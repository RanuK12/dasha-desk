/**
 * Rate limits on the four routes that accept a request with no credential and may
 * hand one back: signup, sign-in, provider enrollment, recovery (review P1-4).
 *
 * Two halves. The bucket itself is tested with a fake clock so the window arithmetic
 * and the memory bound are exact. Then each route is driven through createGateway
 * with the same fake clock to prove it throttles, says how long to wait, recovers
 * when the window passes, keys on the right address, and never leaks whether the
 * thing it refused was real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../gateway/server.mjs';
import { RateLimiter, RATE_LIMITS, clientIp, keyPrefixIdentifier, emailIdentifier } from '../gateway/ratelimit.mjs';

// ---- the bucket -----------------------------------------------------------------

function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test('bucket: refuses past the limit, reports whole seconds to wait, reopens after the window', () => {
  const now = fakeClock();
  const rl = new RateLimiter({ now, limits: { r: { limit: 3, windowMs: 10_000 } } });
  assert.deepEqual(rl.hit('r', 'a'), { ok: true });
  assert.deepEqual(rl.hit('r', 'a'), { ok: true });
  assert.deepEqual(rl.hit('r', 'a'), { ok: true });
  assert.deepEqual(rl.hit('r', 'a'), { ok: false, retryAfter: 10 });
  now.advance(4_200);
  assert.deepEqual(rl.hit('r', 'a'), { ok: false, retryAfter: 6 }, 'ceil of the remaining window');
  now.advance(5_800);
  assert.deepEqual(rl.hit('r', 'a'), { ok: true }, 'a new window opens exactly at resetAt');
  assert.deepEqual(rl.hit('r', 'b'), { ok: true }, 'keys are independent');
  assert.throws(() => rl.hit('nope', 'a'), /unknown rate-limit rule/);
});

test('bucket: retryAfter is never below one second', () => {
  const now = fakeClock();
  const rl = new RateLimiter({ now, limits: { r: { limit: 1, windowMs: 10_000 } } });
  rl.hit('r', 'a');
  now.advance(9_990);
  assert.equal(rl.hit('r', 'a').retryAfter, 1);
});

test('bucket: hitAll charges every rule and answers with the longest wait', () => {
  const now = fakeClock();
  const rl = new RateLimiter({ now, limits: {
    ip: { limit: 2, windowMs: 60_000 }, email: { limit: 1, windowMs: 600_000 } } });
  assert.deepEqual(rl.hitAll([['ip', 'a'], ['email', 'x']]), { ok: true });
  // The email bucket refuses; the ip bucket is still charged for this request.
  assert.deepEqual(rl.hitAll([['ip', 'a'], ['email', 'x']]), { ok: false, retryAfter: 600 });
  // Now the ip bucket refuses too; the answer is the longer of the two.
  assert.deepEqual(rl.hitAll([['ip', 'a'], ['email', 'x']]), { ok: false, retryAfter: 600 });
  assert.deepEqual(rl.hitAll([['ip', 'a'], ['email', 'y']]), { ok: false, retryAfter: 60 });
});

test('bucket: memory is bounded — expired windows are swept and the cap holds', () => {
  const now = fakeClock();
  const rl = new RateLimiter({ now, maxKeys: 100, limits: { r: { limit: 5, windowMs: 1_000 } } });
  for (let i = 0; i < 100; i++) rl.hit('r', `k${i}`);
  assert.equal(rl.size, 100);
  // Past the cap: the oldest entries go, even though none has expired.
  for (let i = 100; i < 150; i++) rl.hit('r', `k${i}`);
  assert.ok(rl.size <= 100, `size ${rl.size} exceeds the cap`);
  assert.deepEqual(rl.hit('r', 'k149'), { ok: true }, 'the newest survive');
  // Everything expires; the next hit sweeps them all.
  now.advance(2_000);
  rl.hit('r', 'fresh');
  assert.equal(rl.size, 1);
});

test('bucket: identifiers are hashed, so the map never holds a key or an address', () => {
  const rl = new RateLimiter();
  // Built at runtime so the source itself carries nothing shaped like a key.
  rl.hit('signin_key', keyPrefixIdentifier('ocm_live_' + 'SECRET'.repeat(4)));
  rl.hit('recover_email', emailIdentifier('Person@Example.test'));
  const stored = [...rl.buckets.keys()].join('\n');
  assert.doesNotMatch(stored, /SECRET|Person|example/i);
  assert.equal(emailIdentifier(' Person@Example.test '), emailIdentifier('person@example.test'),
    'case and whitespace do not make a new bucket');
  assert.equal(keyPrefixIdentifier('ocm_live_abcdefghij_AAAA'), keyPrefixIdentifier('ocm_live_abcdefghij_BBBB'),
    'guesses that share a prefix share a bucket');
  assert.notEqual(keyPrefixIdentifier('ocm_live_abcdefg'), keyPrefixIdentifier('ocm_live_zyxwvut'));
});

test('bucket: the default table covers every rule the gateway uses', () => {
  for (const rule of ['signup_ip', 'signin_ip', 'signin_key', 'enroll_ip', 'recover_ip', 'recover_email']) {
    assert.ok(RATE_LIMITS[rule]?.limit > 0 && RATE_LIMITS[rule]?.windowMs > 0, rule);
  }
  assert.ok(Object.isFrozen(RATE_LIMITS));
});

// ---- the address ------------------------------------------------------------------

const fakeReq = (xff, peer = '10.0.0.9') => ({ headers: xff == null ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: peer } });

test('clientIp: the header is ignored unless a proxy is trusted, then counted from the right', () => {
  assert.equal(clientIp(fakeReq('1.1.1.1'), 0), '10.0.0.9', 'untrusted: socket peer');
  assert.equal(clientIp(fakeReq(undefined), 1), '10.0.0.9', 'trusted but absent: socket peer');
  assert.equal(clientIp(fakeReq('1.1.1.1'), 1), '1.1.1.1');
  // A client-supplied entry sits to the LEFT of what the proxy appends.
  assert.equal(clientIp(fakeReq('6.6.6.6, 1.1.1.1'), 1), '1.1.1.1', 'one proxy: the last entry');
  assert.equal(clientIp(fakeReq('6.6.6.6, 1.1.1.1, 2.2.2.2'), 2), '1.1.1.1', 'two proxies: second from the right');
  assert.equal(clientIp(fakeReq('1.1.1.1'), 5), '1.1.1.1', 'more trust than entries: the first');
  assert.equal(clientIp(fakeReq(['1.1.1.1', '2.2.2.2']), 1), '2.2.2.2', 'repeated header joins like a comma');
  assert.equal(clientIp({ headers: {}, socket: {} }, 0), 'unknown');
});

// ---- the routes -------------------------------------------------------------------

function stubMailer() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); return { messageId: `stub-${sent.length}` }; } };
}

/** A gateway whose limiter runs on a clock the test controls. */
async function startGateway(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-ratelimit-'));
  const now = fakeClock();
  const gw = await createGateway({
    sessionSecret: 'rate-limit-test-secret',
    secureCookies: false,
    ledgerPath: join(dir, 'usage.jsonl'),
    keys: new Map(),
    modelAliases: '',
    consoleHost: 'console.test',
    rateLimiter: new RateLimiter({ now }),
    ...opts,
  });
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  return { ...gw, now, base: `http://127.0.0.1:${gw.server.address().port}` };
}

const form = (base, path, fields, headers = {}) => fetch(`${base}/console${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(fields).toString(),
});

const enroll = (base, body, headers = {}) => fetch(`${base}/v1/provider/enroll`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

const close = (gw) => new Promise((r) => gw.server.close(r));

test('sign-in: throttles per address with Retry-After, recovers after the window, and a real key under the limit still works', async () => {
  const gw = await startGateway();
  try {
    const acct = await gw.accounts.createAccount('owner@example.test');
    const real = await gw.accounts.issue(acct.id, 'developer_key', 'laptop');
    const { limit, windowMs } = RATE_LIMITS.signin_ip;

    // Distinct wrong keys, so only the per-address rule can be what refuses.
    for (let i = 0; i < limit; i++) {
      const r = await form(gw.base, '/signin', { key: `ocm_live_wrong${i}_${'x'.repeat(24)}` });
      assert.equal(r.status, 302, `attempt ${i + 1} is refused as a bad key, not throttled`);
      assert.match(r.headers.get('location'), /not%20valid/);
    }
    const blocked = await form(gw.base, '/signin', { key: real.secret });
    assert.equal(blocked.status, 429, 'past the limit, even the real key is refused');
    const retry = Number(blocked.headers.get('retry-after'));
    assert.ok(retry >= 1 && retry <= windowMs / 1000, `Retry-After ${retry}s`);
    assert.equal(blocked.headers.get('content-type'), 'text/html; charset=utf-8');
    const page = await blocked.text();
    assert.match(page, /Too many requests/);
    assert.doesNotMatch(page, /ocm_live_|not valid|revoked|exists/, 'the page says nothing about the key');
    assert.ok(!blocked.headers.get('set-cookie'), 'no session was issued');

    gw.now.advance(windowMs);
    const ok = await form(gw.base, '/signin', { key: real.secret });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/');
    assert.ok(ok.headers.get('set-cookie'), 'signed in once the window passes');
  } finally { await close(gw); }
});

test('sign-in: a guess spread across addresses is still throttled per key prefix', async () => {
  const gw = await startGateway({ trustProxy: 1 });
  try {
    const { limit } = RATE_LIMITS.signin_key;
    const prefix = 'ocm_live_' + 'Q'.repeat(7);
    for (let i = 0; i < limit; i++) {
      // A different source address each time, and the same 16-char prefix.
      const r = await form(gw.base, '/signin', { key: `${prefix}${String(i).padStart(24, '0')}` },
        { 'x-forwarded-for': `203.0.113.${i + 1}` });
      assert.equal(r.status, 302, `attempt ${i + 1}`);
    }
    const blocked = await form(gw.base, '/signin', { key: `${prefix}${'Z'.repeat(24)}` },
      { 'x-forwarded-for': '203.0.113.200' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    // A different prefix from yet another address is untouched.
    const other = await form(gw.base, '/signin', { key: `ocm_live_${'R'.repeat(31)}` },
      { 'x-forwarded-for': '203.0.113.201' });
    assert.equal(other.status, 302);
  } finally { await close(gw); }
});

test('signup: throttles per address and recovers', async () => {
  const gw = await startGateway();
  try {
    const { limit, windowMs } = RATE_LIMITS.signup_ip;
    for (let i = 0; i < limit; i++) {
      const r = await form(gw.base, '/signup', { email: `person${i}@example.test` });
      assert.equal(r.status, 200, `signup ${i + 1} succeeds`);
    }
    const blocked = await form(gw.base, '/signup', { email: 'late@example.test' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.match(await blocked.text(), /Too many requests/);
    assert.equal(await gw.accounts.accountByEmail('late@example.test'), null, 'no account was created');
    // Also refused for an address that already has an account: the 429 comes first
    // and reads the same, so it says nothing about the address.
    const dup = await form(gw.base, '/signup', { email: 'person0@example.test' });
    assert.equal(dup.status, 429);
    assert.equal(await dup.text(), await (await form(gw.base, '/signup', { email: 'fresh@example.test' })).text());

    gw.now.advance(windowMs);
    assert.equal((await form(gw.base, '/signup', { email: 'late@example.test' })).status, 200);
  } finally { await close(gw); }
});

test('enroll: throttles per address with a JSON 429 and recovers', async () => {
  const gw = await startGateway();
  try {
    const acct = await gw.accounts.createAccount('provider@example.test');
    const { limit, windowMs } = RATE_LIMITS.enroll_ip;
    for (let i = 0; i < limit; i++) {
      const r = await enroll(gw.base, { code: 'ocm_enroll_' + 'A'.repeat(32), agent_id: 'mac' });
      assert.equal(r.status, 401, `guess ${i + 1} is refused as unknown, not throttled`);
    }
    // Past the limit a REAL code is refused too, and not consumed.
    const real = await gw.accounts.issueEnrollment(acct.id, 'mac');
    const blocked = await enroll(gw.base, { code: real.code, agent_id: 'mac' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.equal(blocked.headers.get('content-type'), 'application/json');
    const body = await blocked.json();
    assert.equal(body.error.type, 'rate_limited');
    assert.equal(body.error.retry_after, Number(blocked.headers.get('retry-after')));
    assert.match(body.error.message, /too many requests/);
    assert.ok(!('token' in body), 'no token in a 429');
    // Even a malformed body is a counted, refused request while blocked.
    const junk = await fetch(`${gw.base}/v1/provider/enroll`, { method: 'POST', body: '{nope' });
    assert.equal(junk.status, 429);

    gw.now.advance(windowMs);
    const ok = await enroll(gw.base, { code: real.code, agent_id: 'mac' });
    assert.equal(ok.status, 200, 'the code survived the throttled attempt');
    assert.match((await ok.json()).token, /^ocm_host_/);
  } finally { await close(gw); }
});

test('recovery: throttles per submitted email whether or not it has an account, and per address', async () => {
  const mailer = stubMailer();
  const gw = await startGateway({ recoveryEnabled: true, mailer });
  try {
    await gw.accounts.createAccount('owner@example.test');
    const { limit, windowMs } = RATE_LIMITS.recover_email;

    // An address with no account: same count, same 429, so the throttle is not an oracle.
    for (let i = 0; i < limit; i++) {
      assert.equal((await form(gw.base, '/recover', { email: 'nobody@example.test' })).status, 302);
    }
    const unknownBlocked = await form(gw.base, '/recover', { email: 'Nobody@Example.test' });
    assert.equal(unknownBlocked.status, 429, 'case-folded to the same bucket');
    for (let i = 0; i < limit; i++) {
      assert.equal((await form(gw.base, '/recover', { email: 'owner@example.test' })).status, 302);
    }
    const knownBlocked = await form(gw.base, '/recover', { email: 'owner@example.test' });
    assert.equal(knownBlocked.status, 429);
    assert.equal(await knownBlocked.text(), await unknownBlocked.text(), 'identical page either way');
    assert.ok(Number(knownBlocked.headers.get('retry-after')) >= 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mailer.sent.length, limit, 'the throttled request sent no mail');

    // Per address: enough distinct emails from one source trips the ip rule.
    const { limit: ipLimit } = RATE_LIMITS.recover_ip;
    let status = 302;
    for (let i = 0; i < ipLimit + 1 && status === 302; i++) {
      status = (await form(gw.base, '/recover', { email: `u${i}@example.test` })).status;
    }
    assert.equal(status, 429, 'the per-address rule refuses eventually');

    gw.now.advance(windowMs);
    assert.equal((await form(gw.base, '/recover', { email: 'owner@example.test' })).status, 302);
  } finally { await close(gw); }
});

test('the address key honours X-Forwarded-For only when a proxy is trusted', async () => {
  // Untrusted: a spoofed header does not buy a fresh bucket; every request is one peer.
  const direct = await startGateway({ trustProxy: 0 });
  try {
    const { limit } = RATE_LIMITS.signup_ip;
    for (let i = 0; i < limit; i++) {
      const r = await form(direct.base, '/signup', { email: `p${i}@example.test` }, { 'x-forwarded-for': `198.51.100.${i}` });
      assert.equal(r.status, 200);
    }
    const r = await form(direct.base, '/signup', { email: 'p9@example.test' }, { 'x-forwarded-for': '198.51.100.99' });
    assert.equal(r.status, 429, 'header ignored: still the same socket peer');
  } finally { await close(direct); }

  // Trusted: the proxy-appended entry is the key, so distinct clients get distinct buckets
  // and a client-prepended entry does not change which bucket it is.
  const proxied = await startGateway({ trustProxy: 1 });
  try {
    const { limit } = RATE_LIMITS.signup_ip;
    for (let i = 0; i < limit; i++) {
      const r = await form(proxied.base, '/signup', { email: `a${i}@example.test` }, { 'x-forwarded-for': '198.51.100.1' });
      assert.equal(r.status, 200);
    }
    assert.equal((await form(proxied.base, '/signup', { email: 'a9@example.test' }, { 'x-forwarded-for': '198.51.100.1' })).status, 429);
    assert.equal((await form(proxied.base, '/signup', { email: 'b0@example.test' }, { 'x-forwarded-for': '198.51.100.2' })).status, 200,
      'another client is unaffected');
    // What an ALB produces when the client itself sent a header: "<spoof>, <real>".
    assert.equal((await form(proxied.base, '/signup', { email: 'c0@example.test' }, { 'x-forwarded-for': '6.6.6.6, 198.51.100.1' })).status, 429,
      'the prepended entry is not trusted; the real peer is still throttled');
  } finally { await close(proxied); }
});

test('OCM_TRUST_PROXY is read from the environment when no option is given', async () => {
  const prev = process.env.OCM_TRUST_PROXY;
  process.env.OCM_TRUST_PROXY = '1';
  let gw;
  try {
    gw = await startGateway({ trustProxy: undefined });
    const { limit } = RATE_LIMITS.signup_ip;
    for (let i = 0; i < limit; i++) {
      await form(gw.base, '/signup', { email: `e${i}@example.test` }, { 'x-forwarded-for': '203.0.113.7' });
    }
    assert.equal((await form(gw.base, '/signup', { email: 'e9@example.test' }, { 'x-forwarded-for': '203.0.113.7' })).status, 429);
    assert.equal((await form(gw.base, '/signup', { email: 'f0@example.test' }, { 'x-forwarded-for': '203.0.113.8' })).status, 200);
  } finally {
    if (prev === undefined) delete process.env.OCM_TRUST_PROXY; else process.env.OCM_TRUST_PROXY = prev;
    if (gw) await close(gw);
  }
});

test('rateLimiter: null switches the throttle off for suites that legitimately hammer a route', async () => {
  const gw = await startGateway({ rateLimiter: null });
  try {
    const { limit } = RATE_LIMITS.signin_ip;
    for (let i = 0; i < limit * 2; i++) {
      assert.equal((await form(gw.base, '/signin', { key: `ocm_live_${'n'.repeat(31)}` })).status, 302);
    }
  } finally { await close(gw); }
});

test('the default gateway throttles without any option: the limiter is on by construction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-ratelimit-default-'));
  const gw = await createGateway({ secureCookies: false, ledgerPath: join(dir, 'usage.jsonl'), keys: new Map(), modelAliases: '' });
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gw.server.address().port}`;
  try {
    const { limit } = RATE_LIMITS.signup_ip;
    for (let i = 0; i < limit; i++) await form(base, '/signup', { email: `d${i}@example.test` });
    assert.equal((await form(base, '/signup', { email: 'd9@example.test' })).status, 429);
  } finally { await close(gw); }
});

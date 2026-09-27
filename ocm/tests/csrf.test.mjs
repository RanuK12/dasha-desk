/**
 * Console hygiene from the 2026-09-11 review, batch 2:
 *
 *   P2-9  every signed-in console form carries a per-session CSRF token, and every
 *         console POST that needs a session refuses without it — before acting.
 *         Pre-session forms (sign-in, sign-up, recovery) are guarded by the browser's
 *         Origin / Sec-Fetch-Site headers instead; absent headers are allowed, so the
 *         suite and an operator's curl keep working.
 *   P2-10 the admin network view caps every table at NETWORK_ROWS, newest first,
 *         says "showing N of M", and `?all=1` lifts the cap.
 *   P3-4  a dashboard or network render calls ledger.summary() once, not twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../gateway/server.mjs';
import { NETWORK_ROWS } from '../gateway/console.mjs';
import { csrfOk, csrfToken, issueSession } from '../gateway/session.mjs';

const ADMIN = 'boss@example.test';

async function start(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-csrf-'));
  const gw = await createGateway({
    inviteCode: 'potter',
    sessionSecret: 'csrf-test-session-secret',
    secureCookies: false,
    ledgerPath: join(dir, 'usage.jsonl'),
    keys: new Map(),
    modelAliases: '',
    grantTokens: 5_000,
    adminEmails: ADMIN,
    ...opts,
  });
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  return { ...gw, base: `http://127.0.0.1:${gw.server.address().port}` };
}

const post = (gw, path, fields, { cookie, headers = {} } = {}) => fetch(`${gw.base}/console${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...headers },
  body: new URLSearchParams(fields).toString(),
});

const get = async (gw, path, cookie) => {
  const res = await fetch(`${gw.base}/console${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  return { status: res.status, html: await res.text() };
};

/** Sign up through the console, exactly as a browser would, and hand back what it holds. */
async function signup(gw, email, { invite = 'potter' } = {}) {
  const res = await post(gw, '/signup', invite ? { email, invite } : { email });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const secret = (await res.text()).match(/ocm_live_[A-Za-z0-9_-]+/)[0];
  const accountId = (await gw.accounts.resolve(secret, 'developer_key')).accountId;
  return { cookie, accountId };
}

const tokenOn = (html) => (html.match(/name="csrf" value="([^"]+)"/) || [])[1];
const csrfFor = async (gw, cookie) => tokenOn((await get(gw, '/', cookie)).html);

/** Every <form method="post"> on a page, as the HTML between its open and close tags. */
const postForms = (html) => [...html.matchAll(/<form\b[^>]*method="post"[^>]*>([\s\S]*?)<\/form>/gi)]
  .map((m) => ({ tag: m[0].slice(0, m[0].indexOf('>') + 1), body: m[1] }));

// ---- P2-9 ---------------------------------------------------------------------

test('P2-9: a session POST without its CSRF token is refused with 403 and does nothing', async () => {
  const gw = await start();
  try {
    const me = await signup(gw, 'me@example.test', { invite: '' });   // unredeemed: the redeem form is live
    const csrf = await csrfFor(gw, me.cookie);
    assert.ok(csrf && csrf.length >= 32, 'the dashboard renders a token');
    const other = await signup(gw, 'other@example.test');
    const otherCsrf = await csrfFor(gw, other.cookie);
    assert.notEqual(csrf, otherCsrf, 'tokens are per session');

    const creds = async () => gw.accounts.listCredentials(me.accountId);
    assert.equal((await creds()).length, 1);

    // A refusal is a plain page: 403, no account data, and nothing changed.
    const refusedShape = async (res) => {
      assert.equal(res.status, 403);
      const body = await res.text();
      assert.match(body, /Request refused/);
      assert.doesNotMatch(body, /ocm_(live|host|enroll)_|acct_[A-Za-z0-9_-]{6,}|@example\.test/,
        'the refusal must not leak a credential, an account id or an email');
      assert.equal(res.headers.get('set-cookie'), null, 'a refused post never touches the session cookie');
    };

    // New key: absent, empty, wrong-session and mangled tokens are all refused; none mints.
    for (const bad of [{}, { csrf: '' }, { csrf: otherCsrf }, { csrf: csrf.slice(0, -1) + (csrf.endsWith('A') ? 'B' : 'A') }, { csrf: 'x'.repeat(csrf.length) }]) {
      await refusedShape(await post(gw, '/keys/new', { kind: 'developer_key', label: 'forged', ...bad }, { cookie: me.cookie }));
      assert.equal((await creds()).length, 1, `a key was issued despite token ${JSON.stringify(bad)}`);
    }
    // With the token the same request mints.
    const ok = await post(gw, '/keys/new', { csrf, kind: 'developer_key', label: 'real' }, { cookie: me.cookie });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /ocm_live_/);
    assert.equal((await creds()).length, 2);

    // Revoke: refused without, done with.
    const target = (await creds()).find((c) => c.label === 'real');
    await refusedShape(await post(gw, '/keys/revoke', { credential_id: target.id }, { cookie: me.cookie }));
    assert.equal((await creds()).find((c) => c.id === target.id).revoked_at, null, 'refused revoke must not revoke');
    const revoked = await post(gw, '/keys/revoke', { csrf, credential_id: target.id }, { cookie: me.cookie });
    assert.equal(revoked.status, 302);
    assert.ok((await creds()).find((c) => c.id === target.id).revoked_at, 'with the token the credential is revoked');

    // Enroll: no code without the token, and no enrollment row either.
    await refusedShape(await post(gw, '/enroll', { label: 'mac' }, { cookie: me.cookie }));
    assert.equal((await gw.accounts.listEnrollments(me.accountId)).length, 0, 'refused enroll must not issue a code');
    const enrolled = await post(gw, '/enroll', { csrf, label: 'mac' }, { cookie: me.cookie });
    assert.equal(enrolled.status, 200);
    assert.match(await enrolled.text(), /ocm_enroll_/);
    assert.equal((await gw.accounts.listEnrollments(me.accountId)).length, 1);

    // Redeem: the balance must not move without the token.
    await refusedShape(await post(gw, '/redeem', { invite: 'potter' }, { cookie: me.cookie }));
    assert.equal(await gw.ledger.balance(me.accountId), 0, 'refused redeem must not grant');
    const redeemed = await post(gw, '/redeem', { csrf, invite: 'potter' }, { cookie: me.cookie });
    assert.match(redeemed.headers.get('location'), /notice=/);
    assert.equal(await gw.ledger.balance(me.accountId), 5_000);

    // Rebind: a bound provider token stays bound without the token.
    const tok = await gw.accounts.issue(me.accountId, 'provider_token', 'mac');
    await gw.accounts.claimAgent(tok.id, 'mac-1');
    await refusedShape(await post(gw, '/keys/rebind', { credential_id: tok.id }, { cookie: me.cookie }));
    assert.equal((await creds()).find((c) => c.id === tok.id).bound_agent_id, 'mac-1', 'refused rebind must not release');
    await post(gw, '/keys/rebind', { csrf, credential_id: tok.id }, { cookie: me.cookie });
    assert.equal((await creds()).find((c) => c.id === tok.id).bound_agent_id, null);

    // Sign-out: a live session is not ended by a token-less post (logout CSRF), and the
    // dashboard still opens afterwards. With the token the cookie is cleared.
    await refusedShape(await post(gw, '/signout', {}, { cookie: me.cookie }));
    assert.match((await get(gw, '/', me.cookie)).html, /me@example\.test/, 'the session survived the refused sign-out');
    const out = await post(gw, '/signout', { csrf }, { cookie: me.cookie });
    assert.equal(out.status, 302);
    assert.match(out.headers.get('set-cookie') || '', /ocm_session=;.*Max-Age=0/);
    // No session at all: sign-out is a no-op that still needs no proof (route inventory).
    assert.equal((await post(gw, '/signout', {})).status, 302);

    // Session-less posts to the guarded routes are still the plain redirect, never a 403
    // that would hint at the difference between "no session" and "bad token".
    for (const path of ['/keys/new', '/keys/revoke', '/enroll', '/redeem', '/keys/rebind']) {
      const anon = await post(gw, path, { csrf });
      assert.equal(anon.status, 302, `${path} without a session`);
      assert.equal(anon.headers.get('location'), '/');
    }
  } finally { await gw.close(); }
});

test('P2-9: the token is bound to one session and is not the session signature', () => {
  const secret = 'unit-test-secret';
  const a = issueSession(secret, 'acct_a', 'cred_a');
  const b = issueSession(secret, 'acct_b', 'cred_b');
  assert.ok(csrfOk(secret, a, csrfToken(secret, a)));
  assert.equal(csrfOk(secret, a, csrfToken(secret, b)), false, "another session's token must not pass");
  assert.equal(csrfOk(secret, a, csrfToken('other-secret', a)), false, 'a token under another secret must not pass');
  assert.equal(csrfOk(secret, a, a.slice(a.lastIndexOf('.') + 1)), false, 'the cookie signature is not the token');
  assert.equal(csrfOk(secret, a, a), false, 'the cookie itself is not the token');
  for (const empty of [undefined, null, '', 0, {}]) assert.equal(csrfOk(secret, a, empty), false);
  assert.equal(csrfOk(secret, null, csrfToken(secret, a)), false, 'no session, no token');
});

test('P2-9: every form on a signed-in page carries the hidden token', async () => {
  const gw = await start();
  try {
    // Unredeemed admin with a developer key and a bound provider token, so the
    // dashboard renders every form it has: redeem, release, revoke, enroll, both
    // "new" forms and the sign-out in the header.
    const admin = await signup(gw, ADMIN, { invite: '' });
    const tok = await gw.accounts.issue(admin.accountId, 'provider_token', 'mac');
    await gw.accounts.claimAgent(tok.id, 'mac-1');
    const csrf = await csrfFor(gw, admin.cookie);

    // Dashboard: sign-out, redeem, release + revoke on the provider token, revoke on
    // the developer key, enroll, and the two "new" forms. Profile: the header's
    // sign-out and its own. The rest: the header's sign-out only.
    const expectForms = { '/': 8, '/profile': 2, '/network': 1, '/provider': 1, '/developer': 1 };
    for (const [path, count] of Object.entries(expectForms)) {
      const { status, html } = await get(gw, path, admin.cookie);
      assert.equal(status, 200, path);
      const forms = postForms(html);
      assert.equal(forms.length, count, `${path}: expected ${count} post forms, found ${forms.length}`);
      for (const f of forms) {
        assert.ok(f.body.includes(`<input type="hidden" name="csrf" value="${csrf}">`),
          `${path}: form ${f.tag} lacks the session's CSRF field`);
      }
    }
    // The token appears on the page only inside forms, never in a URL or a script.
    const { html } = await get(gw, '/', admin.cookie);
    assert.doesNotMatch(html, new RegExp(`[?&]csrf=|href="[^"]*${csrf}`), 'the token is a form field, not a link');

    // The anonymous landing page and the recovery form are pre-session: they carry no
    // token (there is no session to bind one to) and are guarded by Origin instead.
    const landing = (await get(gw, '/')).html;
    assert.ok(postForms(landing).length >= 2);
    assert.equal(tokenOn(landing), undefined);
  } finally { await gw.close(); }
});

test('P2-9: a browser post from another site is refused before any handler runs', async () => {
  const adminToken = ['admin', 'bearer', 'for-csrf-test'].join('-');
  const gw = await start({ adminToken });
  try {
    const me = await signup(gw, 'me@example.test');
    const csrf = await csrfFor(gw, me.cookie);
    const creds = async () => gw.accounts.listCredentials(me.accountId);
    const own = new URL(gw.base).host;

    const foreign = [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: 'not a url' },
      { 'sec-fetch-site': 'cross-site' },
      { origin: `http://${own}`, 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of foreign) {
      // Pre-session: sign-in, sign-up and recovery are refused outright.
      const signin = await post(gw, '/signin', { key: 'ocm_live_x' }, { headers });
      assert.equal(signin.status, 403, `sign-in with ${JSON.stringify(headers)}`);
      assert.match(await signin.text(), /another site/);
      const signupRes = await post(gw, '/signup', { email: 'forged@example.test', invite: 'potter' }, { headers });
      assert.equal(signupRes.status, 403);
      assert.equal(await gw.accounts.accountByEmail('forged@example.test'), null, 'cross-site signup must not create an account');
      // Signed-in with a valid token and cookie: the origin layer still refuses.
      const mint = await post(gw, '/keys/new', { csrf, kind: 'developer_key' }, { cookie: me.cookie, headers });
      assert.equal(mint.status, 403);
      assert.equal((await creds()).length, 1, 'cross-site post must not mint even with a valid token');
    }

    // Same-origin browser headers pass through to the handler's own answer.
    for (const headers of [{ origin: `http://${own}` }, { origin: `http://${own.toUpperCase()}`, 'sec-fetch-site': 'same-origin' }, {}]) {
      const signin = await post(gw, '/signin', { key: 'ocm_live_x' }, { headers });
      assert.equal(signin.status, 302, `same-origin ${JSON.stringify(headers)} reaches the handler`);
      assert.match(signin.headers.get('location'), /error=/);
    }
    const ok = await post(gw, '/keys/new', { csrf, kind: 'developer_key' }, { cookie: me.cookie, headers: { origin: `http://${own}`, 'sec-fetch-site': 'same-origin' } });
    assert.equal(ok.status, 200);
    assert.equal((await creds()).length, 2);

    // GETs are never subject to it, and the bearer-authenticated admin API is outside it.
    assert.equal((await fetch(`${gw.base}/console/`, { headers: { origin: 'https://evil.example' } })).status, 200);
    const admin = await fetch(`${gw.base}/admin/accounts`, { method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'made@example.test' }) });
    assert.equal(admin.status, 200, 'the admin bearer API is unaffected by the console origin check');
  } finally { await gw.close(); }
});

// ---- P2-10 --------------------------------------------------------------------

/** Row count of the table under a heading, excluding the header row. */
function rowsUnder(html, heading) {
  const start = html.indexOf(`<h2>${heading}</h2>`);
  assert.ok(start >= 0, `no section ${heading}`);
  const next = html.indexOf('<h2>', start + 1);
  const section = html.slice(start, next < 0 ? undefined : next);
  return { section, rows: (section.match(/<tr>/g) || []).length - (section.includes('<thead>') ? 1 : 0) };
}

test('P2-10: the network view caps each table, newest first, and ?all=1 lifts the cap', async () => {
  const gw = await start();
  try {
    const admin = await signup(gw, ADMIN);
    // Accounts: the cap plus ten, stamped a second apart so "newest first" is not a
    // coin toss on a fast machine. The admin is the oldest, so it falls off the
    // capped page and comes back with ?all=1.
    const t0 = Date.now() - 86_400_000;
    gw.accounts.accounts.get(admin.accountId).created_at = new Date(t0);
    const extra = NETWORK_ROWS + 10;
    for (let i = 1; i <= extra; i++) {
      const a = await gw.accounts.createAccount(`user${i}@example.test`);
      gw.accounts.accounts.get(a.id).created_at = new Date(t0 + i * 1000);
    }
    // Funnel: the cap plus five provider tokens on one account.
    for (let i = 1; i <= NETWORK_ROWS + 5; i++) {
      const c = await gw.accounts.issue(admin.accountId, 'provider_token', `mac-${i}`);
      gw.accounts.creds.get(c.id).created_at = new Date(t0 + i * 1000);
    }
    const total = extra + 1;

    const capped = await get(gw, '/network', admin.cookie);
    assert.equal(capped.status, 200);
    const accts = rowsUnder(capped.html, 'Accounts');
    assert.equal(accts.rows, NETWORK_ROWS, 'the accounts table stops at the cap');
    assert.match(accts.section, new RegExp(`Showing ${NETWORK_ROWS} of ${total}, newest first`));
    assert.match(accts.section, /href="\/network\?all=1"/, 'the escape hatch is offered');
    assert.ok(accts.section.includes(`user${extra}@example.test`), 'the newest account is on the capped page');
    assert.ok(!accts.section.includes(ADMIN), 'the oldest account is not');
    const firstRow = accts.section.indexOf('<tbody>');
    assert.ok(accts.section.indexOf(`user${extra}@example.test`) < accts.section.indexOf(`user${extra - 1}@example.test`),
      'rows run newest to oldest');
    assert.ok(firstRow > 0);
    const funnel = rowsUnder(capped.html, 'Onboarding funnel');
    assert.equal(funnel.rows, NETWORK_ROWS, 'the funnel table stops at the cap too');
    assert.match(funnel.section, new RegExp(`Showing ${NETWORK_ROWS} of ${NETWORK_ROWS + 5}`));
    assert.ok(funnel.section.includes(`mac-${NETWORK_ROWS + 5}`) && !funnel.section.includes('>mac-1 '), 'newest token first');
    // The counter card is the true total, not the capped count.
    assert.match(capped.html, new RegExp(`<div class="k">Accounts</div><div class="v">${total}</div>`));

    const all = await get(gw, '/network?all=1', admin.cookie);
    assert.equal(all.status, 200);
    assert.equal(rowsUnder(all.html, 'Accounts').rows, total, '?all=1 shows every account');
    assert.equal(rowsUnder(all.html, 'Onboarding funnel').rows, NETWORK_ROWS + 5);
    assert.doesNotMatch(all.html, /Showing \d+ of \d+/);
    assert.match(all.html, /Showing every row/);
    assert.ok(all.html.includes(ADMIN));

    // Under the cap nothing is said, and a non-admin gets the usual redirect either way.
    const small = await start();
    try {
      const a = await signup(small, ADMIN);
      assert.doesNotMatch((await get(small, '/network', a.cookie)).html, /Showing \d+ of \d+|Showing every row|all=1/);
    } finally { await small.close(); }
    const user = await signup(gw, 'plain@example.test');
    assert.equal((await get(gw, '/network?all=1', user.cookie)).status, 302);
  } finally { await gw.close(); }
});

// ---- P3-4 ---------------------------------------------------------------------

test('P3-4: a dashboard, profile or network render reads the ledger summary once', async () => {
  const gw = await start();
  try {
    const admin = await signup(gw, ADMIN);
    const real = gw.ledger.summary.bind(gw.ledger);
    let calls = 0;
    gw.ledger.summary = async (...args) => { calls += 1; return real(...args); };

    for (const path of ['/', '/profile', '/network', '/network?all=1', '/stats.json']) {
      calls = 0;
      const { status, html } = await get(gw, path, admin.cookie);
      assert.equal(status, 200, path);
      assert.doesNotMatch(html, /undefined|NaN/, `${path}: a template hole from the reused payload`);
      assert.equal(calls, 1, `${path} called ledger.summary() ${calls} times`);
    }
    // And the reused payload still carries what the tables need.
    const stats = await (await fetch(`${gw.base}/console/stats.json`, { headers: { cookie: admin.cookie } })).json();
    assert.equal(typeof stats.creditedByHost, 'object');
  } finally { await gw.close(); }
});

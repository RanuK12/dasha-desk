/**
 * Concurrent requests cannot overdraw one balance (review P1-1, ROADMAP R3).
 *
 * `handleChat` used to read the balance once and dispatch, so N requests arriving
 * together all saw the same balance and all passed. The gateway now holds each
 * request's worst case (prompt + clamped max_tokens) in `QuotaReservations` from the
 * gate until the job settles. These tests drive the real gateway over a real
 * WebSocket with stub hosts that hold jobs open, the same way `e2e.test.mjs` does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, countTokens } from '../gateway/server.mjs';
import { QuotaReservations } from '../gateway/quota.mjs';

const API_KEY = 'ocm_quota_key';
const CONSUMER = 'quota-dev';
const MODEL = 'qwen3-8b';
const PROMPT = 'hello';
const MAX_TOKENS = 100;
// What one request reserves. The balance covers exactly one of these, never two.
const REQUIRED = countTokens(PROMPT) + MAX_TOKENS;
const BALANCE = REQUIRED + 40;

async function startGateway(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-quota-'));
  const gw = await createGateway({
    keys: new Map([[API_KEY, CONSUMER]]),
    ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: BALANCE,
    modelAliases: '',
    ...opts,
  });
  return new Promise((resolve) => {
    gw.server.listen(0, '127.0.0.1', async () => {
      const acct = await gw.accounts.createAccount('hosts@test.io');
      resolve({ ...gw, hostAccountId: acct.id,
                base: `http://127.0.0.1:${gw.server.address().port}`,
                wsBase: `ws://127.0.0.1:${gw.server.address().port}` });
    });
  });
}

/** A stub host, as in e2e.test.mjs: `behaviour(job, api)` decides what it does. */
async function connectHost(gw, { id, models = [MODEL], behaviour }) {
  const cred = await gw.accounts.issue(gw.hostAccountId, 'provider_token', `stub ${id}`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gw.wsBase}/host/connect`,
      { headers: { authorization: `Bearer ${cred.secret}` } });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello', agent: { id, models, chip: 'stub', memory_gb: 24, region: 'local' } }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'welcome') { resolve({ ws, id }); return; }
      if (msg.t === 'job') {
        behaviour(msg, {
          chunk: (delta) => ws.send(JSON.stringify({ t: 'chunk', id: msg.id, delta })),
          done: () => ws.send(JSON.stringify({ t: 'done', id: msg.id })),
          error: (message) => ws.send(JSON.stringify({ t: 'error', id: msg.id, message })),
        });
      }
    });
  });
}

/** A host that answers nothing until the test tells it to. */
function holdingHost() {
  const jobs = [];
  return {
    jobs,
    behaviour: (job, api) => jobs.push({ job, api }),
    finish: (n = 0, text = 'ok') => { jobs[n].api.chunk(text); jobs[n].api.done(); },
  };
}

const post = (gw, body, init = {}) => fetch(`${gw.base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
  body: JSON.stringify(body),
  ...init,
});

const ask = (extra = {}) => ({
  model: MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS, ...extra,
});

// Captured before any test fakes the clock, so polling keeps working under mock timers.
const realSetTimeout = setTimeout;
const realNow = Date.now;

async function waitFor(predicate, what, ms = 3000) {
  const until = realNow() + ms;
  while (!predicate()) {
    if (realNow() > until) throw new Error(`timed out waiting for ${what()}`);
    await new Promise((r) => realSetTimeout(r, 10));
  }
}

test('reservations: concurrent reserves against one balance read admit exactly one', async () => {
  const quota = new QuotaReservations();
  // Every caller reads the same stale balance, exactly as concurrent ledger reads do.
  const readBalance = () => new Promise((r) => setTimeout(() => r(100), 5));
  const results = await Promise.all(Array.from({ length: 4 }, () => quota.reserve('c', 60, readBalance)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(quota.held('c'), 60);
  const winner = results.find((r) => r.ok);
  assert.equal(winner.release(), true);
  assert.equal(winner.release(), false, 'a second release is a no-op, not a double credit');
  assert.equal(quota.held('c'), 0);
  assert.equal((await quota.reserve('c', 100, readBalance)).ok, true);
});

test('with balance for one request, N simultaneous requests admit exactly one', async () => {
  const gw = await startGateway();
  const host = holdingHost();
  try {
    await connectHost(gw, { id: 'h1', behaviour: host.behaviour });
    assert.equal(await gw.ledger.balance(CONSUMER), BALANCE);

    const N = 6;
    const refused = [];
    const calls = Array.from({ length: N }, () => post(gw, ask()));
    for (const call of calls) call.then((res) => { if (res.status !== 200) refused.push(res); }, () => {});
    await waitFor(() => refused.length === N - 1 && host.jobs.length === 1,
      () => `${N - 1} refusals and one dispatched job (got ${refused.length} refusals, ${host.jobs.length} jobs)`);
    for (const res of refused) {
      assert.equal(res.status, 402);
      const { error } = await res.json();
      assert.equal(error.type, 'insufficient_quota');
      assert.match(error.message, /in-flight/, 'the refusal says the balance is held by in-flight work');
    }
    assert.equal(host.jobs.length, 1, 'exactly one job reached a host');
    assert.equal(gw.quota.held(CONSUMER), REQUIRED, 'the admitted request holds its worst case');

    // Still held: a fresh request is refused too, not just the burst.
    assert.equal((await post(gw, ask())).status, 402);

    // Settle the admitted job: the hold is released and the ledger has the real cost.
    host.finish(0, 'done');
    const accepted = (await Promise.all(calls)).filter((r) => r.status === 200);
    assert.equal(accepted.length, 1);
    assert.equal((await accepted[0].json()).choices[0].message.content, 'done');
    assert.equal(gw.quota.held(CONSUMER), 0, 'settlement released the hold');
    assert.equal(await gw.ledger.balance(CONSUMER), BALANCE - countTokens(PROMPT) - countTokens('done'),
      'the ledger charged what was delivered, not what was reserved');

    // And the balance is usable again.
    const next = post(gw, ask());
    await waitFor(() => host.jobs.length === 2, () => 'the next request to dispatch');
    assert.equal(gw.quota.held(CONSUMER), REQUIRED);
    host.finish(1);
    assert.equal((await next).status, 200);
    assert.equal(gw.quota.held(CONSUMER), 0);
  } finally {
    for (let i = 0; i < host.jobs.length; i++) { try { host.finish(i); } catch {} }
    await gw.close();
  }
});

test('a job that fails before the first byte releases its hold without charging', async () => {
  const gw = await startGateway();
  try {
    await connectHost(gw, { id: 'broken', behaviour: (job, api) => api.error('runtime crashed') });
    const failed = await post(gw, ask());
    assert.equal(failed.status, 503, 'nothing shipped, no other host: the request fails');
    assert.equal(gw.quota.held(CONSUMER), 0, 'the failed job released its hold');
    assert.equal(await gw.ledger.balance(CONSUMER), BALANCE, 'nothing was charged');
    assert.equal((await gw.ledger.summary()).totals.requests, 0);

    // The hold spans failover: the broken host is tried first, the good one answers,
    // and one reservation covers both attempts.
    await connectHost(gw, { id: 'good', behaviour: (job, api) => { api.chunk('fine'); api.done(); } });
    const ok = await post(gw, ask());
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).choices[0].message.content, 'fine');
    assert.equal(gw.quota.held(CONSUMER), 0);
  } finally { await gw.close(); }
});

test('a client that disconnects mid-job releases the hold', async () => {
  const gw = await startGateway();
  const host = holdingHost();
  try {
    await connectHost(gw, { id: 'h1', behaviour: host.behaviour });
    const controller = new AbortController();
    const gone = post(gw, ask({ stream: true }), { signal: controller.signal }).catch((err) => err);
    await waitFor(() => host.jobs.length === 1, () => 'the job to dispatch');
    assert.equal(gw.quota.held(CONSUMER), REQUIRED);
    assert.equal((await post(gw, ask())).status, 402, 'held while the client is still connected');

    controller.abort();
    assert.equal((await gone).name, 'AbortError');
    await waitFor(() => gw.quota.held(CONSUMER) === 0, () => 'the disconnect to release the hold');
    assert.equal(await gw.ledger.balance(CONSUMER), BALANCE, 'nothing shipped, nothing charged');

    const next = post(gw, ask());
    await waitFor(() => host.jobs.length === 2, () => 'the next request to dispatch');
    host.finish(1);
    assert.equal((await next).status, 200);
  } finally {
    for (let i = 0; i < host.jobs.length; i++) { try { host.finish(i); } catch {} }
    await gw.close();
  }
});

test('a job that times out releases the hold', async (t) => {
  const gw = await startGateway();
  const host = holdingHost();
  try {
    await connectHost(gw, { id: 'h1', behaviour: host.behaviour });
    // Only the gateway's job timer is faked; it is armed when the job dispatches, so
    // the fake clock must be on before the request goes in.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const call = post(gw, ask());
    await waitFor(() => host.jobs.length === 1, () => 'the job to dispatch');
    assert.equal(gw.quota.held(CONSUMER), REQUIRED);

    // A never-served stub host is cold, so it gets the long leash.
    t.mock.timers.tick(300_001);
    const res = await call;
    assert.equal(res.status, 503, 'nothing shipped before the deadline, no other host');
    assert.equal(gw.quota.held(CONSUMER), 0, 'the timeout released the hold');
    assert.equal(await gw.ledger.balance(CONSUMER), BALANCE);
    t.mock.timers.reset();

    const next = post(gw, ask());
    await waitFor(() => host.jobs.length === 2, () => 'the next request to dispatch');
    host.finish(1);
    assert.equal((await next).status, 200);
  } finally {
    t.mock.timers.reset();
    for (let i = 0; i < host.jobs.length; i++) { try { host.finish(i); } catch {} }
    await gw.close();
  }
});

test('a request whose worst case exceeds the balance is refused up front', async () => {
  const gw = await startGateway();
  try {
    await connectHost(gw, { id: 'h1', behaviour: (job, api) => { api.chunk('x'); api.done(); } });
    // Alone, with a positive balance, but the budget it asks for could overdraw.
    const res = await post(gw, ask({ max_tokens: BALANCE }));
    assert.equal(res.status, 402);
    const { error } = await res.json();
    assert.equal(error.type, 'insufficient_quota');
    assert.match(error.message, new RegExp(`${countTokens(PROMPT) + BALANCE} tokens`), 'names what it needs');
    assert.match(error.message, new RegExp(`${BALANCE} available`), 'and what there is');
    assert.equal(gw.quota.held(CONSUMER), 0, 'a refusal holds nothing');

    // Asking for less fits.
    assert.equal((await post(gw, ask({ max_tokens: BALANCE - countTokens(PROMPT) }))).status, 200);
  } finally { await gw.close(); }
});

/** Silence the LEDGER WRITE FAILED log line the gateway emits when clear fails. */
function quiet() {
  const orig = console.error;
  console.error = () => {};
  return () => { console.error = orig; };
}

test('a job whose usage cannot be recorded releases the hold and the gate closes', async () => {
  const gw = await startGateway();
  const host = holdingHost();
  const restore = quiet();
  try {
    await connectHost(gw, { id: 'h1', behaviour: host.behaviour });
    // Wrap the real ledger so clear throws, as tests/accounting-fail-closed.test.mjs does.
    gw.ledger.clear = async () => { throw new Error('ACCOUNTING_UNHEALTHY'); };

    const call = post(gw, ask());
    await waitFor(() => host.jobs.length === 1, () => 'the job to dispatch');
    assert.equal(gw.quota.held(CONSUMER), REQUIRED);
    host.finish(0, 'lost');
    const res = await call;
    assert.equal(res.status, 503, 'an unaccounted completion is not a 200');
    assert.equal((await res.json()).error.type, 'accounting_unavailable');
    assert.equal(gw.quota.held(CONSUMER), 0, 'the unaccounted path released the hold');
    assert.equal(await gw.ledger.balance(CONSUMER), BALANCE, 'nothing was charged');

    // The accounting gate now refuses before the reservation, and holds nothing.
    const next = await post(gw, ask());
    assert.equal(next.status, 503);
    assert.equal((await next.json()).error.type, 'accounting_unavailable');
    assert.equal(host.jobs.length, 1, 'refused before dispatch');
    assert.equal(gw.quota.held(CONSUMER), 0);
  } finally {
    restore();
    for (let i = 0; i < host.jobs.length; i++) { try { host.finish(i); } catch {} }
    await gw.close();
  }
});

test('a stream whose usage cannot be recorded releases the hold', async () => {
  const gw = await startGateway();
  const host = holdingHost();
  const restore = quiet();
  try {
    await connectHost(gw, { id: 'h1', behaviour: host.behaviour });
    gw.ledger.clear = async () => { throw new Error('ACCOUNTING_UNHEALTHY'); };

    const call = post(gw, ask({ stream: true }));
    await waitFor(() => host.jobs.length === 1, () => 'the job to dispatch');
    host.finish(0, 'partial');
    const res = await call;
    const text = await res.text();
    assert.equal(res.status, 200, 'the stream had already committed');
    assert.match(text, /event: error/, 'and ends with an error event');
    assert.doesNotMatch(text, /\[DONE\]/, 'never [DONE]');
    assert.equal(gw.quota.held(CONSUMER), 0, 'the unaccounted stream released the hold');
    assert.equal(await gw.ledger.balance(CONSUMER), BALANCE);
  } finally {
    restore();
    for (let i = 0; i < host.jobs.length; i++) { try { host.finish(i); } catch {} }
    await gw.close();
  }
});

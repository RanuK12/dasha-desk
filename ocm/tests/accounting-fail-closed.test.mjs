/**
 * Accounting fails closed at the HTTP boundary (review P1-3, roadmap R7).
 *
 * The ledgers already refuse new work once a write has failed, but a request that
 * passed the balance check before that moment used to finish as a 200 (or a stream
 * ending in [DONE]) whose `usage` block the ledger never recorded. These tests drive
 * the real gateway with a stub host and a JSONL ledger whose `clear` is wrapped to
 * throw, and prove that the client is told, the gate closes at once, /healthz says
 * so, and the next request is refused before any host sees it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../gateway/server.mjs';

const API_KEY = 'ocm_test_key';
const CONSUMER = 'test-dev';

async function startGateway() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-fail-closed-'));
  const gw = await createGateway({
    keys: new Map([[API_KEY, CONSUMER]]),
    ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: 10_000,
    modelAliases: '',
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

/**
 * Wrap the real JSONL ledger so `clear` records every attempt and then throws. The
 * rest of the ledger (balance, credited, grants) is untouched, which is what lets
 * the tests read back that nothing was debited or credited.
 */
function breakClear(gw) {
  const attempts = [];
  gw.ledger.clear = async (input) => {
    attempts.push(input);
    throw new Error('ACCOUNTING_UNHEALTHY', { cause: new Error('disk full (injected)') });
  };
  return attempts;
}

/** A stub host that counts the jobs it is handed and answers each with `reply`. */
async function connectHost(gw, { id, reply }) {
  const cred = await gw.accounts.issue(gw.hostAccountId, 'provider_token', `stub ${id}`);
  const jobs = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gw.wsBase}/host/connect`,
      { headers: { authorization: `Bearer ${cred.secret}` } });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      t: 'hello', agent: { id, models: ['qwen3-8b'], chip: 'stub', memory_gb: 24, region: 'local' },
    })));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'welcome') return resolve();
      if (msg.t === 'job') {
        jobs.push(msg);
        reply(msg, {
          chunk: (delta) => ws.send(JSON.stringify({ t: 'chunk', id: msg.id, delta })),
          done: () => ws.send(JSON.stringify({ t: 'done', id: msg.id })),
          error: (message) => ws.send(JSON.stringify({ t: 'error', id: msg.id, message })),
        });
      }
    });
  });
  return { id, jobs };
}

const post = (gw, body) => fetch(`${gw.base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
  body: JSON.stringify(body),
});

const ask = (extra = {}) => ({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hello' }], ...extra });

const echo = (job, api) => {
  for (const part of ['Hello', ', ', 'world']) api.chunk(part);
  api.done();
};

const quiet = () => {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.error = orig; } };
};

const logged = (lines) => lines
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .find((j) => j && /LEDGER WRITE FAILED/.test(j.msg));

/**
 * What every failure mode must leave behind: the gate closed on /healthz, no debit,
 * no credit, exactly one clear attempt for the job that failed, and the next request
 * refused with the same error type before any host is asked to work.
 */
async function assertGateClosed(gw, host, attempts, { jobsBefore }) {
  const health = await fetch(`${gw.base}/healthz`);
  assert.equal(health.status, 503, '/healthz must go red as soon as usage goes unrecorded');
  const body = await health.json();
  assert.equal(body.ok, false);
  assert.equal(body.service, 'ocm-gateway', 'the existing /healthz fields survive');
  assert.equal(typeof body.hosts, 'number');
  assert.equal(body.accounting.ok, false);
  assert.equal(body.accounting.unrecorded_job, attempts[0].jobId, 'the job to reconcile is named');
  assert.ok(body.accounting.closed_at, 'and when the gate closed');

  assert.equal(await gw.ledger.balance(CONSUMER), 10_000, 'the consumer was not charged');
  assert.equal(await gw.ledger.credited(host.id), 0, 'the provider was not credited');
  assert.equal(attempts.length, 1, 'clear was attempted exactly once, never retried');

  const next = await post(gw, ask());
  assert.equal(next.status, 503, 'the next request is refused');
  assert.equal((await next.json()).error.type, 'accounting_unavailable');
  assert.equal(host.jobs.length, jobsBefore, 'and refused before dispatch: the host never saw it');
  assert.equal(attempts.length, 1, 'a refused request touches the ledger not at all');
}

test('non-streaming: a completion whose usage cannot be recorded is a 5xx, not a 200', async () => {
  const gw = await startGateway();
  const log = quiet();
  try {
    const host = await connectHost(gw, { id: 'h1', reply: echo });
    const attempts = breakClear(gw);

    const res = await post(gw, ask());
    assert.equal(res.status, 503, 'a response was produced, but claiming it succeeded would be a lie');
    const body = await res.json();
    assert.deepEqual(body, { error: {
      type: 'accounting_unavailable',
      message: 'response produced but usage could not be recorded',
    } });
    assert.equal(body.choices, undefined, 'the generated text is dropped, not delivered unaccounted');
    assert.equal(host.jobs.length, 1);

    const entry = logged(log.lines);
    assert.ok(entry, 'the failure is logged');
    assert.equal(entry.jobId, attempts[0].jobId, 'with the job id');
    assert.equal(entry.host, 'h1');

    await assertGateClosed(gw, host, attempts, { jobsBefore: 1 });
  } finally { log.restore(); await gw.close(); }
});

test('streaming: bytes already sent end in an SSE error event, never [DONE]', async () => {
  const gw = await startGateway();
  const log = quiet();
  try {
    const host = await connectHost(gw, { id: 'h1', reply: echo });
    const attempts = breakClear(gw);

    const res = await post(gw, ask({ stream: true }));
    assert.equal(res.status, 200, 'the status was committed with the first chunk and cannot be unsent');
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const raw = await res.text();
    const frames = raw.split('\n\n').filter(Boolean);

    assert.ok(!raw.includes('[DONE]'), 'a stream whose usage is unrecorded must not claim to be done');
    assert.ok(!raw.includes('"finish_reason":"stop"'), 'nor claim a clean stop');
    const content = frames
      .filter((f) => f.startsWith('data: '))
      .map((f) => { try { return JSON.parse(f.slice(6)); } catch { return null; } })
      .filter((p) => p && p.object === 'chat.completion.chunk')
      .map((p) => p.choices[0].delta.content || '').join('');
    assert.equal(content, 'Hello, world', 'what shipped before the failure is intact');

    const last = frames.at(-1).split('\n');
    assert.equal(last[0], 'event: error', 'the final frame is a named SSE error event');
    assert.deepEqual(JSON.parse(last[1].replace(/^data: /, '')), { error: {
      type: 'accounting_unavailable',
      message: 'response produced but usage could not be recorded',
    } });

    const entry = logged(log.lines);
    assert.ok(entry, 'the failure is logged');
    assert.equal(entry.jobId, attempts[0].jobId);

    await assertGateClosed(gw, host, attempts, { jobsBefore: 1 });
  } finally { log.restore(); await gw.close(); }
});

test('streaming with nothing shipped yet gets the plain 503, and a mid-stream host error is covered too', async () => {
  const gw = await startGateway();
  const log = quiet();
  try {
    // First: the host finishes without ever sending a chunk, so no SSE bytes have
    // gone out and the honest answer is still an HTTP 503.
    const silent = await connectHost(gw, { id: 'silent', reply: (job, api) => api.done() });
    const attempts = breakClear(gw);
    const res = await post(gw, ask({ stream: true }));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.type, 'accounting_unavailable');
    await assertGateClosed(gw, silent, attempts, { jobsBefore: 1 });
  } finally { log.restore(); await gw.close(); }

  // Second, on a fresh gateway: the host fails mid-stream after shipping a chunk.
  // That path bills what shipped, so it must fail closed the same way.
  const gw2 = await startGateway();
  const log2 = quiet();
  try {
    const flaky = await connectHost(gw2, { id: 'flaky', reply: (job, api) => { api.chunk('partial'); api.error('boom'); } });
    const attempts = breakClear(gw2);
    const res = await post(gw2, ask({ stream: true }));
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(raw.includes('"content":"partial"'));
    assert.ok(!raw.includes('[DONE]'));
    assert.match(raw, /event: error\ndata: .*accounting_unavailable/);
    await assertGateClosed(gw2, flaky, attempts, { jobsBefore: 1 });
  } finally { log2.restore(); await gw2.close(); }
});

test('a healthy gateway is unchanged: 200, [DONE], one clear, /healthz green', async () => {
  const gw = await startGateway();
  try {
    const host = await connectHost(gw, { id: 'h1', reply: echo });
    const attempts = [];
    const real = gw.ledger.clear.bind(gw.ledger);
    gw.ledger.clear = async (input) => { attempts.push(input); return real(input); };

    const plain = await post(gw, ask());
    assert.equal(plain.status, 200);
    assert.equal((await plain.json()).choices[0].message.content, 'Hello, world');
    const streamed = await post(gw, ask({ stream: true }));
    assert.equal(streamed.status, 200);
    assert.ok((await streamed.text()).endsWith('data: [DONE]\n\n'));

    assert.equal(attempts.length, 2, 'one clear per job');
    assert.equal(host.jobs.length, 2);
    assert.ok(await gw.ledger.credited(host.id) > 0);
    const health = await (await fetch(`${gw.base}/healthz`)).json();
    assert.deepEqual(health.accounting, { ok: true }, 'the health shape is unchanged while healthy');
    assert.equal(health.ok, true);
  } finally { await gw.close(); }
});

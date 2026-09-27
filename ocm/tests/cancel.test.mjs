/**
 * Cancellation, end to end (protocol gate #5; review P2-5; roadmap R4).
 *
 * The gateway sends `cancel` when the client goes away or the job times out. What
 * matters for routing is that the host's slot is free the moment the cancel is
 * sent — `MAX_INFLIGHT_PER_HOST` is 2, so a slot held until the 120s/300s job
 * timeout takes half a machine out of service per abandoned request. What matters
 * for accounting is that a cancelled job bills exactly what reached the client,
 * once, no matter what the host sends afterwards.
 *
 * Two kinds of host are exercised on purpose: one that never answers the cancel
 * (every agent shipped before R4), and one that answers it with a late terminal
 * frame (every agent from R4 on). Both must leave the slot count and the ledger
 * exactly where the cancel left them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countTokens, createGateway } from '../gateway/server.mjs';

const API_KEY = 'ocm_cancel_key';
const MODEL = 'cancel-model';
// "Promptly" for a slot release. The job timeout is 120s; anything in the same
// order as a network round trip is the right answer, and a second is generous.
const PROMPT_MS = 1_000;

async function startGateway() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-cancel-'));
  const gw = await createGateway({
    keys: new Map([[API_KEY, 'cancel-consumer']]),
    ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: 10_000,
    modelAliases: '',
  });
  return new Promise((resolve) => {
    gw.server.listen(0, '127.0.0.1', async () => {
      const acct = await gw.accounts.createAccount('cancel-hosts@test.io');
      const port = gw.server.address().port;
      resolve({ ...gw, hostAccountId: acct.id,
                base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` });
    });
  });
}

/**
 * A stub host that, unlike the e2e harness, also sees `cancel` frames.
 * `behaviour(job, api, host)` runs on each job; set `host.onCancel` to react to a
 * cancel for a given job id. Every frame the gateway sends is kept in `received`.
 */
async function connectHost(gw, { id, behaviour }) {
  const cred = await gw.accounts.issue(gw.hostAccountId, 'provider_token', `stub ${id}`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gw.wsBase}/host/connect`,
      { headers: { authorization: `Bearer ${cred.secret}` } });
    const host = { ws, id, received: [], cancels: [], closed: false, onCancel: null,
                   behaviour, close: () => ws.close() };
    const api = (jobId) => ({
      chunk: (delta) => ws.send(JSON.stringify({ t: 'chunk', id: jobId, delta })),
      done: () => ws.send(JSON.stringify({ t: 'done', id: jobId })),
      error: (message) => ws.send(JSON.stringify({ t: 'error', id: jobId, message })),
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('close', () => { host.closed = true; });
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      t: 'hello', agent: { id, models: [MODEL], chip: 'stub', memory_gb: 24, region: 'local' },
    })));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      host.received.push(msg);
      if (msg.t === 'welcome') { resolve(host); return; }
      if (msg.t === 'cancel') { host.cancels.push(msg.id); host.onCancel?.(msg.id, api(msg.id)); return; }
      if (msg.t === 'job') host.behaviour(msg, api(msg.id), host);
    });
  });
}

const chat = (gw, body, signal) => fetch(`${gw.base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
  body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'go' }], ...body }),
  signal,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` holds; return how long it took, or throw at the deadline. */
async function waitFor(predicate, what, deadlineMs = PROMPT_MS) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (predicate()) return Date.now() - started;
    await sleep(5);
  }
  throw new Error(`${what} did not happen within ${deadlineMs}ms`);
}

const inflight = (gw, id) => gw.registry.get(id).inflight.size;
const usageRows = (gw, jobId) => gw.ledger.entries.filter((e) => e.kind === 'usage' && e.jobId === jobId);
const jobsSeen = (host) => host.received.filter((m) => m.t === 'job');

/**
 * Start a streaming request, wait until the host's first chunk has actually reached
 * the client, then abort it. Returns the job as the host saw it.
 */
async function abortAfterFirstChunk(gw, host) {
  const controller = new AbortController();
  const res = await chat(gw, { stream: true }, controller.signal);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.match(Buffer.from(value).toString(), /"content":"partial"/);
  controller.abort();
  await waitFor(() => host.cancels.length === 1, 'the cancel frame');
  const [job] = jobsSeen(host);
  assert.equal(host.cancels[0], job.id, 'the cancel names the job that was running');
  return job;
}

test('a client abort frees the host slot at once, even when the host never answers the cancel', async () => {
  const gw = await startGateway();
  let host;
  try {
    // An old agent: sends one token, then holds the job open. It stops on cancel but
    // sends nothing back — exactly what every agent before R4 did.
    host = await connectHost(gw, { id: 'silent-host', behaviour: (job, api) => api.chunk('partial') });

    const job = await abortAfterFirstChunk(gw, host);
    const freedIn = await waitFor(() => inflight(gw, host.id) === 0, 'the slot release');
    assert.ok(freedIn < PROMPT_MS, `slot freed in ${freedIn}ms, must not wait for the job timeout`);

    // Only what reached the client is billed, and it is billed once.
    await waitFor(() => usageRows(gw, job.id).length === 1, 'the usage row');
    assert.equal(usageRows(gw, job.id)[0].completionTokens, countTokens('partial'));

    // The next request goes to the same host and completes normally.
    host.behaviour = (j, api) => { api.chunk('fresh'); api.done(); };
    const res = await chat(gw, {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, 'fresh');
    assert.equal(jobsSeen(host).length, 2);
    assert.equal(inflight(gw, host.id), 0);
    assert.equal(host.closed, false);
  } finally {
    host?.close();
    await gw.close();
  }
});

test('a late terminal frame after cancel is ignored: no double free, no second bill, socket kept', async () => {
  const gw = await startGateway();
  let host;
  try {
    // An R4 agent: sends one token, and answers the cancel with a terminal frame a
    // little later. To be unkind, it also sends a stray `done` after that.
    host = await connectHost(gw, { id: 'polite-host', behaviour: (job, api) => api.chunk('partial') });
    let answered = null;
    host.onCancel = (jobId, api) => {
      setTimeout(() => { api.error('cancelled'); api.done(); answered = Date.now(); }, 50);
    };

    const job = await abortAfterFirstChunk(gw, host);
    await waitFor(() => inflight(gw, host.id) === 0, 'the slot release');
    await waitFor(() => usageRows(gw, job.id).length === 1, 'the usage row');
    const billed = usageRows(gw, job.id)[0].completionTokens;

    await waitFor(() => answered !== null, 'the late terminal');
    await sleep(100);   // let both stray frames land
    assert.equal(inflight(gw, host.id), 0, 'inflight does not go negative or grow');
    assert.equal(gw.registry.get(host.id).inflight.has(job.id), false);
    assert.deepEqual(usageRows(gw, job.id).map((e) => e.completionTokens), [billed],
      'the late terminal does not meter the job a second time');
    assert.equal(host.closed, false, 'a late terminal is not a protocol violation');

    // Routing is unaffected: the host still serves.
    host.behaviour = (j, api) => { api.chunk('fresh'); api.done(); };
    const res = await chat(gw, {});
    assert.equal(res.status, 200);
    assert.equal(jobsSeen(host).length, 2);
    assert.equal(inflight(gw, host.id), 0);
  } finally {
    host?.close();
    await gw.close();
  }
});

test('an abort before any output frees the slot, bills nothing and does not fail over', async () => {
  const gw = await startGateway();
  let host;
  try {
    // A host still loading its model: the job arrives, nothing comes back yet.
    let dispatched;
    const arrived = new Promise((resolve) => { dispatched = resolve; });
    host = await connectHost(gw, { id: 'loading-host', behaviour: () => dispatched() });

    for (const stream of [false, true]) {
      const controller = new AbortController();
      const request = chat(gw, { stream }, controller.signal).catch((err) => err);
      await arrived;
      await waitFor(() => inflight(gw, host.id) === 1, 'dispatch');
      controller.abort();
      const err = await request;
      assert.equal(err.name, 'AbortError');

      const freedIn = await waitFor(() => inflight(gw, host.id) === 0, 'the slot release');
      assert.ok(freedIn < PROMPT_MS);
      const [job] = jobsSeen(host).slice(-1);
      await waitFor(() => host.cancels.includes(job.id), 'the cancel frame');
      await sleep(50);
      assert.equal(usageRows(gw, job.id).length, 0, 'nothing shipped, nothing billed');
      host.behaviour = () => {};   // a second dispatch here would be a failover
    }
    assert.equal(jobsSeen(host).length, 2, 'one job per request: an abort is not retried');
    assert.equal(host.closed, false);
  } finally {
    host?.close();
    await gw.close();
  }
});

test('the reference agent answers a cancel with a terminal frame, and only one', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../agent/agent.py', import.meta.url), 'utf8');
  const runJob = source.slice(source.indexOf('async def run_job('), source.indexOf('\ndef _connect('));
  assert.match(runJob, /"t": "error", "id": job_id, "message": "cancelled"/,
    'run_job must send the cancelled terminal frame; tests/agent-smoke.py proves it fires');
  assert.match(runJob, /asyncio\.wait\(\{item, stop\}, return_when=asyncio\.FIRST_COMPLETED\)/,
    'the cancel must be able to interrupt a wait on the runtime, or a cold load delays the terminal');
});

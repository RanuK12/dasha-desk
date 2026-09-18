/**
 * The ready bit (review P2-13).
 *
 * A host advertises its models at hello before Metal has loaded anything, and the
 * gateway used to learn a machine was warm only from its first chunk — so the first
 * consumer paid the ~75s load, and a preloaded machine was routed as if cold. Now an
 * agent may say `ready` in hello and in a `status` frame, and the gateway ranks a
 * ready host with warm ones. Agents that never send it are still accepted and are
 * treated exactly as before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../gateway/server.mjs';

const API_KEY = 'ocm_ready_key';
const MODEL = 'ocm-coder';

async function startGateway() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-ready-'));
  const gw = await createGateway({
    keys: new Map([[API_KEY, 'ready-dev']]),
    ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: 10_000,
    modelAliases: '',
  });
  return new Promise((resolve) => {
    gw.server.listen(0, '127.0.0.1', async () => {
      const acct = await gw.accounts.createAccount('ready-hosts@test.io');
      const port = gw.server.address().port;
      resolve({ ...gw, hostAccountId: acct.id,
                base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` });
    });
  });
}

/**
 * A stub host, as in e2e.test.mjs, plus whatever extra hello fields a test wants
 * (`ready` here). Every job it receives is echoed back and recorded in `served`.
 */
async function connectHost(gw, { id, models = [MODEL], extra = {}, served = [] }) {
  const cred = await gw.accounts.issue(gw.hostAccountId, 'provider_token', `stub ${id}`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gw.wsBase}/host/connect`,
      { headers: { authorization: `Bearer ${cred.secret}` } });
    const closed = new Promise((r) => ws.addEventListener('close', (ev) => r(ev.code)));
    ws.addEventListener('error', () => {});
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello', agent: { id, models, chip: 'stub', ...extra } }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'welcome') { resolve({ ws, id, served, closed }); return; }
      if (msg.t === 'job') {
        served.push(msg.id);
        ws.send(JSON.stringify({ t: 'chunk', id: msg.id, delta: `from ${id}` }));
        ws.send(JSON.stringify({ t: 'done', id: msg.id }));
      }
    });
    // A refused hello closes the socket without a welcome; surface that instead of hanging.
    closed.then((code) => reject(new Error(`closed before welcome: ${code}`)));
  });
}

const ask = (gw) => fetch(`${gw.base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
  body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
});

const network = async (gw) => {
  const net = await (await fetch(`${gw.base}/v1/network`)).json();
  return Object.fromEntries(net.hosts.map((h) => [h.id, h]));
};

test('an idle host that says ready is preferred over an idle cold one, whichever connected first', async () => {
  for (const readyFirst of [true, false]) {
    const gw = await startGateway();
    try {
      const order = readyFirst
        ? [{ id: 'ready-mac', extra: { ready: true } }, { id: 'cold-mac' }]
        : [{ id: 'cold-mac' }, { id: 'ready-mac', extra: { ready: true } }];
      const hosts = {};
      for (const spec of order) hosts[spec.id] = await connectHost(gw, spec);

      const res = await ask(gw);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.choices[0].message.content, 'from ready-mac');
      assert.deepEqual(hosts['ready-mac'].served.length, 1);
      assert.deepEqual(hosts['cold-mac'].served, [],
        `the cold host must not get the job while a ready one is idle (ready connected ${readyFirst ? 'first' : 'second'})`);
    } finally { await gw.close(); }
  }
});

test('/v1/network carries ready per host: true, false, or null when the agent never said', async () => {
  const gw = await startGateway();
  try {
    await connectHost(gw, { id: 'loaded-mac', extra: { ready: true } });
    await connectHost(gw, { id: 'loading-mac', extra: { ready: false } });
    await connectHost(gw, { id: 'old-agent' });

    const hosts = await network(gw);
    assert.equal(hosts['loaded-mac'].ready, true);
    assert.equal(hosts['loading-mac'].ready, false);
    assert.equal(hosts['old-agent'].ready, null, 'absent means unknown, not false');
    // `warm` is untouched: it remains what the gateway itself observed.
    assert.equal(hosts['loaded-mac'].warm, false);
    assert.doesNotMatch(JSON.stringify(hosts), /acct_|@/, 'still no account identity');
  } finally { await gw.close(); }
});

test('a hello without ready is accepted and routes exactly as before', async () => {
  const gw = await startGateway();
  try {
    const legacy = await connectHost(gw, { id: 'old-agent' });
    const res = await ask(gw);
    assert.equal(res.status, 200);
    assert.equal(legacy.served.length, 1);
    const hosts = await network(gw);
    assert.equal(hosts['old-agent'].warm, true, 'a first chunk still marks the host warm');
    assert.equal(hosts['old-agent'].ready, null);
  } finally { await gw.close(); }
});

test('a status frame moves the bit, and the bit never un-warms a host the gateway saw serve', async () => {
  const gw = await startGateway();
  try {
    const cold = await connectHost(gw, { id: 'cold-mac' });
    const flip = await connectHost(gw, { id: 'flip-mac', extra: { ready: false } });
    assert.equal((await network(gw))['flip-mac'].ready, false);

    // The agent finishes its preload and says so.
    flip.ws.send(JSON.stringify({ t: 'status', ready: true }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await network(gw))['flip-mac'].ready, true);
    assert.equal((await ask(gw)).status, 200);
    assert.equal(flip.served.length, 1, 'ready by the host\'s word ranks with warm');
    assert.equal(cold.served.length, 0);

    // It loses the model again (a different one was loaded). Its warmth evidence from
    // the chunk above still stands for the warm TTL, so it stays preferred; the bit
    // alone must not un-warm a host the gateway saw serve.
    flip.ws.send(JSON.stringify({ t: 'status', ready: false }));
    await new Promise((r) => setTimeout(r, 50));
    const hosts = await network(gw);
    assert.equal(hosts['flip-mac'].ready, false);
    assert.equal(hosts['flip-mac'].warm, true);
  } finally { await gw.close(); }
});

test('a ready that is not a boolean is refused, in hello and in a status frame', async () => {
  const gw = await startGateway();
  try {
    await assert.rejects(connectHost(gw, { id: 'liar-mac', extra: { ready: 'yes' } }),
      /closed before welcome: 1008/);

    const host = await connectHost(gw, { id: 'honest-mac', extra: { ready: true } });
    host.ws.send(JSON.stringify({ t: 'status', ready: 'maybe' }));
    assert.equal(await host.closed, 1008);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(Object.keys(await network(gw)).length, 0, 'the refused socket is deregistered');
  } finally { await gw.close(); }
});

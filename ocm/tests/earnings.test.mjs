/**
 * Provider earnings view (ROADMAP P5): what each of an owner's machines has been
 * credited today, over seven UTC days and all time, with a zero-filled day strip.
 *
 * Pinned here:
 *   - the arithmetic on the JSONL ledger, including the UTC day boundaries and that a
 *     row older than the window counts all-time but not in the week or the strip;
 *   - the answer is scoped to the machines asked for: another account's host never
 *     appears, even when it has usage;
 *   - the owner dashboard renders the section for an account with machines, with the
 *     "not money" sentence, and omits it for an account with none;
 *   - the Postgres ledger gives byte-identical answers for the same rows, when a test
 *     database is available (OCM_TEST_DATABASE_URL); skipped otherwise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Ledger, startOfUtcDay, utcDayKeys } from '../gateway/ledger.mjs';
import { createGateway } from '../gateway/server.mjs';

const API_KEY = 'ocm_live_' + 'earnings-test';
const NOW = new Date('2026-09-11T15:30:00Z');
const DAY = 86_400_000;
const at = (daysAgo, hour = 12) => new Date(startOfUtcDay(NOW).getTime() - daysAgo * DAY + hour * 3_600_000).toISOString();

/** Rows shared by the JSONL and Postgres checks. `z` belongs to someone else. */
const ROWS = [
  { host: 'a', at: at(0, 15), completionTokens: 40, promptTokens: 10 },
  { host: 'b', at: at(0, 1), completionTokens: 5, promptTokens: 1 },
  { host: 'a', at: at(3), completionTokens: 100, promptTokens: 20 },
  { host: 'a', at: at(6, 0), completionTokens: 7, promptTokens: 1 },      // first day of the window
  { host: 'a', at: at(7, 23), completionTokens: 1000, promptTokens: 1 },  // just outside it
  { host: 'z', at: at(0), completionTokens: 999, promptTokens: 1 },
];
const EXPECTED = {
  since_today: startOfUtcDay(NOW).toISOString(),
  since_week: new Date(startOfUtcDay(NOW).getTime() - 6 * DAY).toISOString(),
  hosts: {
    a: { today: 40, week: 147, all: 1147, requests: 4, last_at: at(0, 15) },
    b: { today: 5, week: 5, all: 5, requests: 1, last_at: at(0, 1) },
  },
  daily: utcDayKeys(new Date(startOfUtcDay(NOW).getTime() - 6 * DAY), 7).map((day, i) => ({
    day, credited: [7, 0, 0, 100, 0, 0, 45][i], requests: [1, 0, 0, 1, 0, 0, 2][i],
  })),
};

test('JSONL ledger: earnings per machine, UTC windows, zero-filled days, scoped to the caller', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-earn-'));
  const ledger = new Ledger(join(dir, 'usage.jsonl'));
  await ledger.init();
  for (const r of ROWS) {
    ledger.entries.push({ id: randomUUID(), kind: 'usage', consumer: 'c', model: 'ocm-coder', jobId: randomUUID(),
      tokens: r.promptTokens + r.completionTokens, ...r });
  }
  const got = await ledger.earnings(['a', 'b'], { now: NOW });
  assert.deepEqual(got, EXPECTED);
  assert.ok(!('z' in got.hosts), 'a machine not asked for never appears');
  // An owner with no machines gets an empty, still well-formed answer.
  const none = await ledger.earnings([], { now: NOW });
  assert.deepEqual(none.hosts, {});
  assert.equal(none.daily.length, 7);
  assert.equal(none.daily.reduce((n, d) => n + d.credited, 0), 0);
});

test('Postgres ledger: the same rows give the same answer', { skip: !process.env.OCM_TEST_DATABASE_URL && 'set OCM_TEST_DATABASE_URL to run' }, async () => {
  const { PgLedger } = await import('../gateway/pg-ledger.mjs');
  const ledger = new PgLedger(process.env.OCM_TEST_DATABASE_URL, { ssl: false });
  await ledger.init();
  try {
    await ledger.pool.query('DELETE FROM usage_log');
    for (const r of ROWS) {
      await ledger.pool.query(
        `INSERT INTO usage_log (id, at, kind, consumer, host, model, job_id, prompt_tokens, completion_tokens, tokens)
         VALUES ($1, $2, 'usage', 'c', $3, 'ocm-coder', $4, $5, $6, $7)`,
        [randomUUID(), r.at, r.host, randomUUID(), r.promptTokens, r.completionTokens, r.promptTokens + r.completionTokens]);
    }
    assert.deepEqual(await ledger.earnings(['a', 'b'], { now: NOW }), EXPECTED);
    assert.deepEqual((await ledger.earnings([], { now: NOW })).hosts, {});
  } finally {
    await ledger.close();
  }
});

async function startGateway(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-earn-gw-'));
  const gw = await createGateway({
    sessionSecret: 'earnings-test-secret', secureCookies: false,
    keys: new Map([[API_KEY, 'earnings-dev']]), ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: 5_000, modelAliases: '', ...opts,
  });
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  const port = gw.server.address().port;
  return { ...gw, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}
function connectHost(gw, token, id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gw.wsBase}/host/connect`, { headers: { authorization: `Bearer ${token}` } });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      t: 'hello', agent: { id, models: ['ocm-coder'], chip: 'stub', memory_gb: 24, region: 'local' } })));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'welcome') resolve(ws);
      if (msg.t === 'job') {
        ws.send(JSON.stringify({ t: 'chunk', id: msg.id, delta: 'four words of output' }));
        ws.send(JSON.stringify({ t: 'done', id: msg.id, usage: { completion_tokens: 1 } }));
      }
    });
    ws.addEventListener('close', (ev) => reject(new Error(`closed ${ev.code} ${ev.reason}`)));
  });
}
async function signin(gw, accountId) {
  const key = await gw.accounts.issue(accountId, 'developer_key', 'laptop');
  const res = await fetch(`${gw.base}/console/signin`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `key=${encodeURIComponent(key.secret)}` });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

test('the owner dashboard shows earnings for its machines only, and says credits are not money', async () => {
  const gw = await startGateway();
  try {
    const owner = await gw.accounts.createAccount('earn-owner@example.test');
    const code = await gw.accounts.issueEnrollment(owner.id, 'Air');
    const ex = await (await fetch(`${gw.base}/v1/provider/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.code, agent_id: 'air' }) })).json();
    const ws = await connectHost(gw, ex.token, 'air');
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${gw.base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: 'ocm-coder', messages: [{ role: 'user', content: 'hi' }] }) });
      assert.equal(res.status, 200, await res.text());
    }
    await new Promise((r) => setTimeout(r, 60));
    const earn = await gw.ledger.earnings(['air']);
    assert.equal(earn.hosts.air.requests, 2);
    assert.ok(earn.hosts.air.today > 0, 'the gateway metered completion tokens');

    const dash = await (await fetch(`${gw.base}/console/`, { headers: { cookie: await signin(gw, owner.id) } })).text();
    assert.match(dash, /<h2>Earnings<\/h2>/);
    assert.match(dash, /Credited today<\/div><div class="v">\d/);
    assert.match(dash, /<th>Machine<\/th><th>Today<\/th><th>7 days<\/th><th>All time<\/th><th>Requests<\/th><th>Last served<\/th>/);
    assert.match(dash, /<th>Day \(UTC\)<\/th>(<th>\d\d-\d\d<\/th>){7}/, 'a seven-day strip');
    assert.match(dash, /They are not money and have no payout today/);
    const section = dash.slice(dash.indexOf('<h2>Earnings</h2>'));
    const row = section.slice(section.indexOf('<code>air</code>'));
    assert.match(row.slice(0, row.indexOf('</tr>')), /<td>2<\/td>\s*<td>just now<\/td>/, 'two requests, last served just now');

    // An account with no machines has no earnings section, and sees nothing of air.
    const other = await gw.accounts.createAccount('earn-other@example.test');
    const dash2 = await (await fetch(`${gw.base}/console/`, { headers: { cookie: await signin(gw, other.id) } })).text();
    assert.doesNotMatch(dash2, /<h2>Earnings<\/h2>/);
    assert.doesNotMatch(dash2, /<code>air<\/code>/);
    ws.close();
  } finally { await gw.close(); }
});

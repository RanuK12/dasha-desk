/**
 * Bounded chat requests (review P1-2), the compatibility way.
 *
 * Unmodified OpenAI clients send sampling parameters by default. Those are accepted,
 * not applied, and named in `x-ocm-ignored-params`. Capabilities the runtimes lack
 * (tools, structured output, audio, images, several choices) are refused with a
 * precise 400. The completion budget is clamped to the gateway's cap and named in
 * `x-ocm-adjusted`, and the budget travels to the host in the job frame.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeChatRequest, MAX_OUTPUT_TOKENS } from '../gateway/request.mjs';
import { createGateway } from '../gateway/server.mjs';

const ok = (extra = {}) => ({ model: 'ocm-coder', messages: [{ role: 'user', content: 'hi' }], ...extra });

test('sampling parameters are accepted, not applied, and reported; features are refused', () => {
  const r = normalizeChatRequest(ok({ temperature: 0.2, top_p: 0.9, stop: ['\n'], user: 'u1', seed: 7, n: 1, stream: false }));
  assert.deepEqual(r.ignored, ['seed', 'stop', 'temperature', 'top_p', 'user']);
  assert.equal(r.maxTokens, MAX_OUTPUT_TOKENS);
  assert.equal(r.adjusted, null);
  assert.deepEqual(r.messages, [{ role: 'user', content: 'hi' }]);

  assert.throws(() => normalizeChatRequest(ok({ tools: [{ type: 'function' }] })), /unsupported parameter\(s\): tools/);
  assert.throws(() => normalizeChatRequest(ok({ response_format: { type: 'json_object' } })), /response_format/);
  assert.throws(() => normalizeChatRequest(ok({ n: 2 })), /n: only one choice/);
  assert.throws(() => normalizeChatRequest(ok({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] })), /only text is supported \(no image_url parts\)/);
  assert.throws(() => normalizeChatRequest(ok({ messages: [{ role: 'assistant', content: '', tool_calls: [] }] })), /tools are not supported/);
  assert.throws(() => normalizeChatRequest(ok({ messages: Array.from({ length: 129 }, () => ({ role: 'user', content: 'x' })) })), /1-128/);
  assert.throws(() => normalizeChatRequest(ok({ messages: [{ role: 'user', content: 'x'.repeat(256 * 1024 + 1) }] })), /too long/);
  assert.throws(() => normalizeChatRequest(ok({ max_tokens: 0 })), /positive integer/);
  assert.throws(() => normalizeChatRequest(ok({ max_tokens: 10, max_completion_tokens: 20 })), /conflict/);
  assert.throws(() => normalizeChatRequest(ok({ model: 'bad model' })), /model/);
  assert.throws(() => normalizeChatRequest(ok({ messages: [] })), /messages/);
});

test('text-only multimodal content is flattened; the budget is clamped and reported', () => {
  const r = normalizeChatRequest(ok({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
    max_tokens: 4096,
  }));
  assert.equal(r.messages[0].content, 'ab');
  assert.equal(r.maxTokens, MAX_OUTPUT_TOKENS);
  assert.deepEqual(r.adjusted, { max_tokens: MAX_OUTPUT_TOKENS });
  assert.equal(normalizeChatRequest(ok({ max_completion_tokens: 32 })).maxTokens, 32);
  // null is how some SDKs send "unset"; it must not be treated as present.
  assert.deepEqual(normalizeChatRequest(ok({ temperature: null, tools: null, n: null, stream: null })).ignored, []);
});

// ---- end to end: a stub host echoes the budget it was given -------------------------

const API_KEY = 'ocm_live_' + 'chat-request-test';
async function startGateway() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-chatreq-'));
  const gw = await createGateway({
    sessionSecret: 'chat-request-secret', secureCookies: false,
    keys: new Map([[API_KEY, 'chatreq-dev']]), ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: 5_000, modelAliases: '',
  });
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  const port = gw.server.address().port;
  return { ...gw, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}
async function connectHost(gw, id) {
  const acct = await gw.accounts.createAccount(`${id}@example.test`);
  const cred = await gw.accounts.issue(acct.id, 'provider_token', id);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gw.wsBase}/host/connect`, { headers: { authorization: `Bearer ${cred.secret}` } });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      t: 'hello', agent: { id, models: ['ocm-coder'], chip: 'stub', memory_gb: 24, region: 'local' } })));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'welcome') resolve(ws);
      if (msg.t === 'job') {
        ws.send(JSON.stringify({ t: 'chunk', id: msg.id, delta: `budget=${msg.max_tokens}` }));
        ws.send(JSON.stringify({ t: 'done', id: msg.id }));
      }
    });
  });
}
const chat = (gw, body) => fetch(`${gw.base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
  body: JSON.stringify(body),
});

test('over HTTP: defaults from a stock client succeed with disclosure; features get a precise 400', async () => {
  const gw = await startGateway();
  const ws = await connectHost(gw, 'stub-chat');
  try {
    // What an unmodified SDK typically sends.
    const stock = await chat(gw, ok({ temperature: 0.7, top_p: 1, user: 'cli', stream: false, max_tokens: 9000 }));
    const stockText = await stock.text();
    assert.equal(stock.status, 200, stockText);
    assert.equal(stock.headers.get('x-ocm-ignored-params'), 'temperature,top_p,user');
    assert.equal(stock.headers.get('x-ocm-adjusted'), `max_tokens=${MAX_OUTPUT_TOKENS}`);
    const body = JSON.parse(stockText);
    assert.equal(body.choices[0].message.content, `budget=${MAX_OUTPUT_TOKENS}`, 'the clamped budget reached the host in the job frame');

    const small = await chat(gw, ok({ max_tokens: 40 }));
    assert.equal(small.status, 200);
    assert.equal(small.headers.get('x-ocm-ignored-params'), null);
    assert.equal(small.headers.get('x-ocm-adjusted'), null);
    assert.equal((await small.json()).choices[0].message.content, 'budget=40');

    const tools = await chat(gw, ok({ tools: [{ type: 'function', function: { name: 'f' } }] }));
    assert.equal(tools.status, 400);
    const err = await tools.json();
    assert.equal(err.error.type, 'invalid_request_error');
    assert.match(err.error.message, /unsupported parameter\(s\): tools/);

    const image = await chat(gw, ok({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:,' } }] }] }));
    assert.equal(image.status, 400);
    assert.match((await image.json()).error.message, /only text is supported/);

    const many = await chat(gw, ok({ n: 3 }));
    assert.equal(many.status, 400);
    assert.match((await many.json()).error.message, /only one choice/);

    const nomodel = await chat(gw, { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(nomodel.status, 400);
  } finally {
    ws.close();
    await gw.close();
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

/* OpenRouter provider-listing surface: namespaced model ids ("dasha/..."),
   a dedicated external key with its own rate limit and fail-fast queue
   timeout, advertised context lengths, and honest usage accounting (real
   provider-reported tokens preferred; estimates flagged, never silent). */

const CONSUMER_KEY = "consumer-test";
const PROVIDER_KEY = "provider-test";
const OPENROUTER_KEY = "openrouter-test-secret";

async function waitFor(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("coordinator did not start");
}

/* Spawn the coordinator on a race-free OS-assigned port: PORT=0 binds
   atomically and the helper reads the listening line from stdout. The old
   freePort-then-spawn pattern let two parallel test coordinators collide on
   one port and steal each other's jobs. */
async function coordinator(context, extraEnv = {}) {
  const child = spawn(process.execPath, ["coordinator/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: "0",
      DASHA_API_KEY: CONSUMER_KEY,
      DASHA_PROVIDER_KEY: PROVIDER_KEY,
      DASHA_OPENROUTER_KEY: OPENROUTER_KEY,
      JOB_TIMEOUT_MS: "60000",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  context.after(() => child.kill("SIGTERM"));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("coordinator did not print a listening port")), 10_000);
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk.toString();
      const match = text.match(/listening on http:\/\/[^/:]+:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`coordinator exited before listening (code ${code})`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/healthz`);
  return base;
}

function chat(base, body, key) {
  const headers = { "Content-Type": "application/json" };
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  return fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function pollOnce(base, providerId, models = ["qwen3-8b"]) {
  // Retry on 204 like the repo's pollForJob: the chat POST and the poll race
  // over loopback, and under parallel-suite load the poll can arrive first.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${base}/v1/providers/poll`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PROVIDER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: providerId, name: "Test Mac", models }),
    });
    if (response.status === 204) { await new Promise((resolve) => setTimeout(resolve, 25)); continue; }
    assert.equal(response.status, 200);
    return (await response.json()).job;
  }
  throw new Error("provider did not receive a job");
}

async function settleJob(base, jobId, providerId, result) {
  const response = await fetch(`${base}/v1/providers/jobs/${jobId}/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PROVIDER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider_id: providerId, ...result }),
  });
  assert.equal(response.status, 202);
}

test("models list serves OpenRouter provider documents", async (context) => {
  const base = await coordinator(context);
  const response = await fetch(`${base}/v1/models`);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.ok(data.length >= 6, "expected the alpha model set");
  for (const doc of data) {
    assert.match(doc.id, /^dasha\//, "id is the namespaced id OpenRouter calls");
    assert.equal(doc.openrouter.slug, doc.id, "public slug matches the called id");
    assert.equal(doc.is_free, true, "free launch");
    assert.equal(doc.is_ready, true);
    const [input] = doc.input_modalities;
    assert.equal(input.type, "text");
    assert.ok(input.supported_inputs.max_context_length.value > 0, `${doc.id} needs max_context_length`);
    const [output] = doc.output_modalities;
    assert.equal(output.type, "text");
    assert.ok(output.supported_parameters.temperature, "temperature declared");
    assert.ok(output.supported_parameters.max_tokens, "max_tokens declared");
    assert.equal(output.streaming, true);
    assert.equal(doc.pricing, undefined, "free launch omits pricing, never zero-stuffs");
  }
});

test("namespaced model ids route and echo back; bare ids keep working", async (context) => {
  const base = await coordinator(context);
  for (const requested of ["dasha/qwen3-8b", "qwen3-8b"]) {
    const pending = chat(base, { model: requested, messages: [{ role: "user", content: "hi" }] }, OPENROUTER_KEY);
    const job = await pollOnce(base, "provider-a");
    assert.ok(job, `expected a leased job for ${requested}`);
    assert.equal(job.model, "qwen3-8b", "provider sees the bare internal id");
    await settleJob(base, job.id, "provider-a", { content: "ok", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    const done = await pending;
    assert.equal(done.status, 200);
    const payload = await done.json();
    assert.equal(payload.model, requested, "response echoes the requested id");
    assert.deepEqual(payload.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    assert.equal(done.headers.get("x-dasha-usage-estimated"), null, "reported usage is not flagged");
  }
});

test("unknown namespaced models are rejected with 400", async (context) => {
  const base = await coordinator(context);
  const response = await chat(base, { model: "dasha/gpt-9", messages: [{ role: "user", content: "hi" }] }, OPENROUTER_KEY);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /unknown model/);
});

test("openrouter key is independent: wrong keys 401, unset key disables the lane", async (context) => {
  const base = await coordinator(context);
  const wrong = await chat(base, { model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] }, "not-the-key");
  assert.equal(wrong.status, 401);

  const noLane = await coordinator(context, { DASHA_OPENROUTER_KEY: "", JOB_TIMEOUT_MS: "5000" });
  const stale = await chat(noLane, { model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] }, OPENROUTER_KEY);
  assert.equal(stale.status, 401, "unset DASHA_OPENROUTER_KEY must not accept anything");
  const consumer = await chat(noLane, { model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] }, CONSUMER_KEY);
  assert.equal(consumer.status, 503, "consumer key still routes (no provider online)");
});

test("openrouter lane is rate limited and limited requests never become jobs", async (context) => {
  const base = await coordinator(context, { OPENROUTER_RATE_LIMIT_RPM: "1", OPENROUTER_RATE_LIMIT_BURST: "1", OPENROUTER_QUEUE_TIMEOUT_MS: "5000", JOB_TIMEOUT_MS: "5000" });
  const first = await chat(base, { model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] }, OPENROUTER_KEY);
  assert.equal(first.status, 429, "queue timeout on the openrouter lane is a 429, not a 5xx");
  // Bucket holds 1 token and refills 1/min: the next request is limited
  // immediately instead of waiting out the 5s queue window.
  const started = Date.now();
  const limited = await chat(base, { model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] }, OPENROUTER_KEY);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.ok(Date.now() - started < 2000, "rate-limited requests must not wait for providers");
  // Consumer lane has no bucket: it is unaffected by the openrouter limit.
  const consumer = await chat(base, { model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] }, CONSUMER_KEY);
  assert.equal(consumer.status, 503);
});

test("openrouter lane fails fast with 429 (uptime-safe) when no provider is online", async (context) => {
  const base = await coordinator(context, { OPENROUTER_QUEUE_TIMEOUT_MS: "5000" });
  const started = Date.now();
  const response = await chat(base, { model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] }, OPENROUTER_KEY);
  const elapsed = Date.now() - started;
  // 429 keeps OpenRouter's uptime metric clean (5xx would count against it).
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.ok(elapsed < 20000, `fail-fast timeout should beat the 60s consumer default (took ${elapsed}ms)`);
  assert.ok(elapsed >= 4000, "should still wait out the configured queue window");
});

test("missing provider usage is estimated and flagged, never zeroed silently", async (context) => {
  const base = await coordinator(context);
  const pending = chat(base, { model: "dasha/qwen3-8b", messages: [{ role: "user", content: "hello world, this is a prompt" }] }, OPENROUTER_KEY);
  const job = await pollOnce(base, "provider-a");
  assert.ok(job);
  await settleJob(base, job.id, "provider-a", { content: "a short completion" });
  const done = await pending;
  assert.equal(done.status, 200);
  assert.equal(done.headers.get("x-dasha-usage-estimated"), "true");
  const usage = (await done.json()).usage;
  assert.ok(usage.total_tokens > 0, "estimated usage must be positive");
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
});

test("streams send SSE keep-alive comments while a provider works", async (context) => {
  const base = await coordinator(context, { OPENROUTER_KEEPALIVE_MS: "300" });
  const pending = fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "dasha/qwen3-8b", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  const job = await pollOnce(base, "provider-a");
  assert.ok(job, "expected a leased stream job");
  const response = await pending;
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5000;
  while (!text.includes(": keep-alive") && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  assert.ok(text.includes(": keep-alive"), "expected an SSE keep-alive comment while the provider works");
  const finished = await fetch(`${base}/v1/providers/jobs/${job.id}/chunk`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PROVIDER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider_id: "provider-a", done: true }),
  });
  assert.equal(finished.status, 202);
  while (true) { const { done } = await reader.read(); if (done) break; }
});

test("streamed chunks echo the namespaced model id and carry usage", async (context) => {
  const base = await coordinator(context);
  const pending = fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "dasha/qwen3-8b", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  const job = await pollOnce(base, "provider-a");
  assert.ok(job, "expected a leased stream job");
  const pHeaders = { Authorization: `Bearer ${PROVIDER_KEY}`, "Content-Type": "application/json" };
  const chunked = await fetch(`${base}/v1/providers/jobs/${job.id}/chunk`, {
    method: "POST", headers: pHeaders, body: JSON.stringify({ provider_id: "provider-a", delta: "hello" }),
  });
  assert.equal(chunked.status, 202);
  const finished = await fetch(`${base}/v1/providers/jobs/${job.id}/chunk`, {
    method: "POST", headers: pHeaders,
    body: JSON.stringify({ provider_id: "provider-a", done: true, usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }),
  });
  assert.equal(finished.status, 202);
  const response = await pending;
  assert.equal(response.status, 200);
  const text = await response.text();
  const chunks = text.split("\n\n").filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
  assert.ok(chunks.length >= 2, "expected role chunk plus content chunks");
  for (const chunk of chunks) assert.equal(chunk.model, "dasha/qwen3-8b");
  const last = chunks[chunks.length - 1];
  assert.deepEqual(last.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
  assert.equal(last.choices[0].finish_reason, "stop");
});

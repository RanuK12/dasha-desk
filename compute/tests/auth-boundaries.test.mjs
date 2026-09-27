import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

/* The coordinator's auth and request-validation boundaries are its security
   perimeter: bearer keys guard the consumer and provider routes, the model
   list is an allowlist, and oversized or malformed bodies are rejected before
   any job state exists. None of this was pinned by a test. */

const CONSUMER_KEY = "consumer-test";
const PROVIDER_KEY = "provider-test";

/* Spawn the coordinator on a race-free OS-assigned port: PORT=0 binds
   atomically and the helper reads the listening line from stdout. The old
   freePort-then-spawn pattern let two parallel test coordinators collide on
   one port and steal each other's jobs. */
async function spawnCoordinator(context, extraEnv = {}) {
  const child = spawn(process.execPath, ["coordinator/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: "0", JOB_TIMEOUT_MS: "5000", ...extraEnv },
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

async function waitFor(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("coordinator did not start");
}

async function coordinator(context) {
  return spawnCoordinator(context, { DASHA_API_KEY: CONSUMER_KEY, DASHA_PROVIDER_KEY: PROVIDER_KEY });
}

function chat(base, body, key = CONSUMER_KEY) {
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

async function network(base) {
  const response = await fetch(`${base}/v1/network`);
  assert.equal(response.status, 200);
  return response.json();
}

test("health, models and network are public; nothing else is", async (context) => {
  const base = await coordinator(context);
    for (const path of ["/healthz", "/v1/models", "/v1/network"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
  }
  const noAuth = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(noAuth.status, 401);
  const queued = await network(base);
  assert.equal(queued.jobs_queued, 0, "rejected requests must not create jobs");
});

test("chat completions rejects a wrong consumer key with 401", async (context) => {
  const base = await coordinator(context);
    const response = await chat(base, { model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] }, "not-the-key");
  assert.equal(response.status, 401);
  assert.match((await response.json()).error.message, /invalid API key/);
});

test("chat completions rejects unknown models and bad messages with 400", async (context) => {
  const base = await coordinator(context);
    const good = { model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] };
  const unknown = await chat(base, { ...good, model: "gpt-9" });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error.message, /unknown model/);
  for (const messages of [[], [{ role: "hacker", content: "hi" }], [{ role: "user", content: 42 }], [{ role: "user" }]]) {
    const bad = await chat(base, { ...good, messages });
    assert.equal(bad.status, 400, JSON.stringify(messages));
  }
});

test("chat completions rejects malformed JSON with 400 and huge bodies with 413", async (context) => {
  const base = await coordinator(context);
  const headers = { Authorization: `Bearer ${CONSUMER_KEY}`, "Content-Type": "application/json" };
  const malformed = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: "{\"model\":" });
  assert.equal(malformed.status, 400);
  const huge = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "qwen3-8b", messages: [{ role: "user", content: "x".repeat(300_000) }] }),
  });
  assert.equal(huge.status, 413);
});

test("provider routes reject missing and wrong keys with 401", async (context) => {
  const base = await coordinator(context);
  const noKey = await fetch(`${base}/v1/providers/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider_id: "x", models: [] }),
  });
  assert.equal(noKey.status, 401);
  const wrongKey = await fetch(`${base}/v1/providers/poll`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
    body: JSON.stringify({ provider_id: "x", models: [] }),
  });
  assert.equal(wrongKey.status, 401);
});

test("a provider cannot report another provider's job (409)", async (context) => {
  const base = await coordinator(context);
  const pending = fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONSUMER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] }),
  });
  const job = await pollOnce(base, "provider-a");
  assert.ok(job, "expected a leased job");
  const hijack = await fetch(`${base}/v1/providers/jobs/${job.id}/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PROVIDER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider_id: "provider-b", content: "pwned" }),
  });
  assert.equal(hijack.status, 409);
  // Settle honestly so the background consumer request completes.
  const settle = await fetch(`${base}/v1/providers/jobs/${job.id}/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PROVIDER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider_id: "provider-a", content: "ok", finish_reason: "stop" }),
  });
  assert.equal(settle.status, 202);
  const done = await pending;
  assert.equal(done.status, 200);
  assert.equal((await done.json()).choices[0].message.content, "ok");
});

test("stream jobs must use the chunk endpoint, non-stream the result endpoint", async (context) => {
  const base = await coordinator(context);
  const headers = { Authorization: `Bearer ${CONSUMER_KEY}`, "Content-Type": "application/json" };
  const pHeaders = { Authorization: `Bearer ${PROVIDER_KEY}`, "Content-Type": "application/json" };

  const streamPending = fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers, body: JSON.stringify({ model: "qwen3-8b", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  const streamJob = await pollOnce(base, "provider-a");
  const streamViaResult = await fetch(`${base}/v1/providers/jobs/${streamJob.id}/result`, {
    method: "POST", headers: pHeaders, body: JSON.stringify({ provider_id: "provider-a", content: "x" }),
  });
  assert.equal(streamViaResult.status, 409);
  const finish = await fetch(`${base}/v1/providers/jobs/${streamJob.id}/chunk`, {
    method: "POST", headers: pHeaders, body: JSON.stringify({ provider_id: "provider-a", done: true }),
  });
  assert.equal(finish.status, 202);
  await streamPending;

  const plainPending = fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers, body: JSON.stringify({ model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] }),
  });
  const plainJob = await pollOnce(base, "provider-a");
  const plainViaChunk = await fetch(`${base}/v1/providers/jobs/${plainJob.id}/chunk`, {
    method: "POST", headers: pHeaders, body: JSON.stringify({ provider_id: "provider-a", delta: "x" }),
  });
  assert.equal(plainViaChunk.status, 409);
  const settle = await fetch(`${base}/v1/providers/jobs/${plainJob.id}/result`, {
    method: "POST", headers: pHeaders, body: JSON.stringify({ provider_id: "provider-a", content: "ok" }),
  });
  assert.equal(settle.status, 202);
  assert.equal((await plainPending).status, 200);
});

test("a job with no provider times out as 503 with a retry hint", async (context) => {
  const base = await coordinator(context);
  const started = Date.now();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONSUMER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3-8b", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.match((await response.json()).error.type, /provider_unavailable/);
  assert.ok(Date.now() - started >= 4000, "should wait for the job timeout");
});

/* A coordinator bound to a non-loopback interface with the public default keys
   would expose the consumer/provider APIs to the network with guessable
   credentials. It must refuse to start; loopback keeps the convenient
   defaults for local development. */
test("coordinator refuses a non-loopback bind with default keys", async () => {
  const child = spawn(process.execPath, ["coordinator/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: "0", HOST: "0.0.0.0", JOB_TIMEOUT_MS: "5000" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, 15_000);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 1, "coordinator started on 0.0.0.0 with default keys");
  assert.match(stderr, /not loopback/, "refusal reason names the non-loopback bind");
});

test("coordinator starts on a non-loopback bind with real keys", async (context) => {
  const base = await spawnCoordinator(context, {
    HOST: "0.0.0.0",
    DASHA_API_KEY: "real-consumer-key",
    DASHA_PROVIDER_KEY: "real-provider-key",
  });
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
});

test("coordinator keeps default keys on the loopback bind", async (context) => {
  const base = await spawnCoordinator(context); // no HOST, no keys: 127.0.0.1 + defaults
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
});

#!/usr/bin/env node
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

// PORT=0 is honored so tests can ask the OS for a race-free ephemeral port
// (the old freePort-then-spawn pattern let two coordinators collide).
const port = process.env.PORT === undefined || process.env.PORT === "" ? 8787 : Number(process.env.PORT);
// Public default keys are a loopback-only convenience. Binding a non-loopback
// interface with them would expose the consumer/provider APIs to the network
// with credentials anyone can guess. Guarded again below before listen().
const DEFAULT_CONSUMER_KEY = "dasha-local-consumer";
const DEFAULT_PROVIDER_KEY = "dasha-local-provider";
const consumerKey = process.env.DASHA_API_KEY || DEFAULT_CONSUMER_KEY;
const providerKey = process.env.DASHA_PROVIDER_KEY || DEFAULT_PROVIDER_KEY;
const corsOrigin = process.env.DASHA_CORS_ORIGIN || "";
const jobTimeoutMs = Math.max(5_000, Number(process.env.JOB_TIMEOUT_MS || 120_000));
const maxBodyBytes = 256 * 1024;
const providerFreshnessMs = 30_000;
// --- OpenRouter provider-facing surface (alpha) ---
// OpenRouter lists models as "<slug>/<model>" and sends bursty external
// traffic, so it gets a dedicated key with its own rate limit and a short
// fail-fast queue timeout (OpenRouter routes around slow providers itself).
const providerSlug = process.env.DASHA_PROVIDER_SLUG || "dasha";
const openrouterKey = process.env.DASHA_OPENROUTER_KEY || "";
const bindHost = process.env.HOST || "127.0.0.1";
const openrouterRpm = Math.max(1, Number(process.env.OPENROUTER_RATE_LIMIT_RPM || 60));
const openrouterBurst = Math.max(1, Number(process.env.OPENROUTER_RATE_LIMIT_BURST || 10));
const openrouterQueueMs = Math.max(5_000, Number(process.env.OPENROUTER_QUEUE_TIMEOUT_MS || 25_000));
// Free-launch switch: is_free=true lists zero-cost :free endpoints; flipping
// to "false" stages the paid conversion OpenRouter documents.
const openrouterIsFree = process.env.OPENROUTER_IS_FREE !== "false";
// SSE comment cadence while a stream job is unsettled (OpenRouter cancels
// streams it believes are stalled).
const keepAliveMs = Math.max(1_000, Number(process.env.OPENROUTER_KEEPALIVE_MS || 10_000));
const models = [
  { id: "qwen3-8b", object: "model", owned_by: "community", context_length: 32768, size_gb: 5.2, min_memory_gb: 8, status: "alpha" },
  { id: "gemma3-12b", object: "model", owned_by: "community", context_length: 131072, size_gb: 8.1, min_memory_gb: 16, status: "alpha" },
  { id: "gpt-oss-20b", object: "model", owned_by: "community", context_length: 131072, size_gb: 14, min_memory_gb: 16, status: "alpha" },
  { id: "qwen3-30b-a3b", object: "model", owned_by: "community", context_length: 32768, size_gb: 19, min_memory_gb: 24, status: "alpha" },
  { id: "gemma3-27b", object: "model", owned_by: "community", context_length: 131072, size_gb: 17, min_memory_gb: 24, status: "alpha" },
  { id: "gpt-oss-120b", object: "model", owned_by: "community", context_length: 131072, size_gb: 65, min_memory_gb: 96, status: "alpha" },
];
const jobs = new Map();
const providers = new Map();
let jobsCompleted = 0;
let tokensCompleted = 0;

function baseHeaders(extra = {}) {
  return { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin, Vary: "Origin" } : {}), ...extra };
}
function send(response, status, payload, headers = {}) {
  if (response.headersSent) return;
  response.writeHead(status, baseHeaders(headers));
  response.end(JSON.stringify(payload));
}
function bearer(request) {
  const value = request.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}
function secretMatches(actual, expected) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
// OpenRouter requests models as "<slug>/<id>"; bare ids keep working for
// existing local clients. The response echoes the requested id back.
function resolveModel(raw) {
  const requested = String(raw || "");
  const prefix = `${providerSlug}/`;
  const bare = requested.startsWith(prefix) ? requested.slice(prefix.length) : requested;
  const model = models.find((item) => item.id === bare);
  return model ? { model, requested } : null;
}
function makeBucket(rpm, burst) {
  let tokens = burst;
  let last = Date.now();
  return {
    take() {
      const now = Date.now();
      tokens = Math.min(burst, tokens + ((now - last) / 60000) * rpm);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
const openrouterBucket = makeBucket(openrouterRpm, openrouterBurst);
// Dedicated external-consumer policy. Returns null when the key is unknown.
// Like the other local bearer keys these are shared secrets: rotate by
// restarting with a new value; there is no revocation store.
function consumerPolicy(request) {
  const key = bearer(request);
  if (openrouterKey && secretMatches(key, openrouterKey)) {
    return { name: "openrouter", queueTimeoutMs: openrouterQueueMs, bucket: openrouterBucket };
  }
  if (secretMatches(key, consumerKey)) {
    return { name: "consumer", queueTimeoutMs: jobTimeoutMs, bucket: null };
  }
  return null;
}
// Token accounting must be honest: prefer provider-reported usage, and only
// fall back to a chars/4 estimate when the provider reported nothing. The
// estimate is flagged with X-Dasha-Usage-Estimated so nobody mistakes it
// for measured billing data.
// OpenRouter provider document for /v1/models, following the current
// provider-integration spec: typed input/output modality entries, the exact
// id OpenRouter will call us with, openrouter.slug for the public listing,
// is_free for the free launch (no pricing array — "do not zero-stuff
// prices"), and honest omissions: no datacenters (community fleet locations
// vary; declared at application time) and no compliance.zdr (provider
// operators can see prompts — see THREAT_MODEL.md).
function openrouterModels() {
  return models.map((model) => ({
    id: `${providerSlug}/${model.id}`,
    openrouter: { slug: `${providerSlug}/${model.id}` },
    is_free: openrouterIsFree,
    is_ready: true,
    input_modalities: [
      {
        type: "text",
        supported_inputs: {
          max_context_length: { value: model.context_length, unit: "token" },
        },
      },
    ],
    output_modalities: [
      {
        type: "text",
        supported_parameters: {
          temperature: { type: "range", min: 0, max: 2, default: 0.7 },
          max_tokens: { type: "integer", min: 1, max: 8192, unit: "token", default: 1024 },
          stream: { type: "boolean", default: false },
        },
        streaming: true,
        max_length: { value: 8192, unit: "token" },
      },
    ],
  }));
}
function promptChars(job) {
  return job.messages.map((item) => String(item.content || "")).join("\n").length;
}
function finalUsage(job, result) {
  const reported = result.usage;
  const total = Number(reported?.total_tokens || 0);
  if (reported && total > 0) return { usage: reported, estimated: false };
  const prompt_tokens = Math.max(1, Math.ceil(promptChars(job) / 4));
  const completionChars = result.content ? String(result.content).length : (job.completionChars || 0);
  const completion_tokens = Math.max(1, Math.ceil(completionChars / 4));
  return { usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }, estimated: true };
}
async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
}
function validateMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return false;
  return value.every((item) => item && ["system", "user", "assistant", "tool"].includes(item.role) && typeof item.content === "string" && item.content.length <= 64_000);
}
function publicJob(job) {
  return { id: job.id, model: job.model, messages: job.messages, temperature: job.temperature, max_tokens: job.maxTokens, stream: job.stream };
}
function cleanupLeases() {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.status === "leased" && job.leaseExpiresAt < now) {
      job.status = "queued";
      job.providerId = null;
    }
  }
}
function sse(response, payload) {
  if (!response.destroyed && !response.writableEnded) response.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}
function streamChunk(job, delta, finishReason = null, usage) {
  sse(job.response, { id: `chatcmpl_${job.id.slice(4)}`, object: "chat.completion.chunk", created: job.created, model: job.requestedModel || job.model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) });
}
function finishJob(job, result) {
  if (job.settled) return;
  job.settled = true;
  clearTimeout(job.timer);
  if (!result.error) {
    jobsCompleted += 1;
    tokensCompleted += Number(result.usage?.total_tokens || 0);
  }
  job.settle(result);
}

async function handleChat(request, response) {
  const policy = consumerPolicy(request);
  if (!policy) return send(response, 401, { error: { message: "invalid API key", type: "authentication_error" } });
  if (policy.bucket && !policy.bucket.take()) {
    return send(response, 429, { error: { message: "rate limit exceeded", type: "rate_limit_error" } }, { "Retry-After": "60" });
  }
  const body = await readJson(request);
  const resolved = resolveModel(body.model);
  if (!resolved) return send(response, 400, { error: { message: "unknown model", type: "invalid_request_error" } });
  if (!validateMessages(body.messages)) return send(response, 400, { error: { message: "messages must be a non-empty OpenAI-style array", type: "invalid_request_error" } });

  const id = `job_${randomUUID().replaceAll("-", "")}`;
  let settle;
  const resultPromise = new Promise((resolve) => { settle = resolve; });
  const job = {
    id, model: resolved.model.id, requestedModel: resolved.requested, messages: body.messages,
    temperature: Number.isFinite(body.temperature) ? Math.max(0, Math.min(2, body.temperature)) : 0.7,
    maxTokens: Number.isFinite(body.max_tokens) ? Math.max(1, Math.min(8192, body.max_tokens)) : 1024,
    stream: body.stream === true, status: "queued", created: Math.floor(Date.now() / 1000),
    providerId: null, leaseExpiresAt: 0, response: body.stream === true ? response : null,
    settle, settled: false, timer: null, completionChars: 0,
  };
  jobs.set(id, job);
  if (job.stream) {
    response.writeHead(200, baseHeaders({ "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no", "X-Dasha-Privacy": "tls-relay-alpha" }));
    streamChunk(job, { role: "assistant", content: "" });
    // SSE comment keep-alives: OpenRouter cancels streams it believes are
    // stalled, so prove liveness while a provider works on the first tokens.
    job.keepAlive = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write(": keep-alive\n\n");
    }, keepAliveMs);
    if (typeof job.keepAlive.unref === "function") job.keepAlive.unref();
    response.on("close", () => { clearInterval(job.keepAlive); if (!job.settled) finishJob(job, { error: "consumer disconnected", disconnected: true }); });
  }
  job.timer = setTimeout(() => finishJob(job, { timeout: true }), policy.queueTimeoutMs);
  const result = await resultPromise;
  clearInterval(job.keepAlive);
  jobs.delete(id);

  if (job.stream) {
    if (result.timeout) {
      sse(response, { error: { message: "no provider completed the request before timeout", type: "provider_unavailable" } });
      sse(response, "[DONE]");
      response.end();
    } else if (result.error && !result.disconnected) {
      sse(response, { error: { message: result.error, type: "provider_error" } });
      sse(response, "[DONE]");
      response.end();
    }
    return;
  }
  // OpenRouter excludes 429 from uptime but counts every 5xx against it, and
  // explicitly advises early 429s over queueing — so the external lane fails
  // with 429 (route elsewhere) while the local lane keeps the 503 semantics
  // existing clients expect.
  if (result.timeout) {
    if (policy.name === "openrouter") {
      return send(response, 429, { error: { message: "no provider capacity available right now", type: "rate_limit_error" } }, { "Retry-After": "5" });
    }
    return send(response, 503, { error: { message: "no provider completed the request before timeout", type: "provider_unavailable" } }, { "Retry-After": "5" });
  }
  if (result.error) return send(response, 502, { error: { message: result.error, type: "provider_error" } });
  const accounted = finalUsage(job, result);
  return send(response, 200, {
    id: `chatcmpl_${id.slice(4)}`, object: "chat.completion", created: job.created, model: job.requestedModel,
    choices: [{ index: 0, message: { role: "assistant", content: String(result.content || "") }, finish_reason: result.finish_reason || "stop" }],
    usage: accounted.usage,
  }, { "X-Dasha-Provider": String(result.providerId || "community"), "X-Dasha-Privacy": "tls-relay-alpha", ...(accounted.estimated ? { "X-Dasha-Usage-Estimated": "true" } : {}) });
}

async function handleProviderPoll(request, response) {
  if (!secretMatches(bearer(request), providerKey)) return send(response, 401, { error: "invalid provider key" });
  const body = await readJson(request);
  const id = String(body.provider_id || "").trim().slice(0, 96);
  if (!id) return send(response, 400, { error: "provider_id is required" });
  const supported = Array.isArray(body.models) ? body.models.filter((item) => typeof item === "string") : [];
  providers.set(id, { id, name: String(body.name || id).slice(0, 96), models: supported, hardware: body.hardware || {}, lastSeenAt: Date.now() });
  cleanupLeases();
  const job = [...jobs.values()].find((candidate) => candidate.status === "queued" && supported.includes(candidate.model));
  if (!job) { response.writeHead(204, { "Cache-Control": "no-store" }); return response.end(); }
  job.status = "leased";
  job.providerId = id;
  job.leaseExpiresAt = Date.now() + 90_000;
  return send(response, 200, { job: publicJob(job), lease_seconds: 90 });
}
function authorizedJob(response, request, body, jobId) {
  if (!secretMatches(bearer(request), providerKey)) { send(response, 401, { error: "invalid provider key" }); return null; }
  const job = jobs.get(jobId);
  if (!job || job.status !== "leased") { send(response, 404, { error: "job is unavailable or lease expired" }); return null; }
  if (String(body.provider_id || "") !== job.providerId) { send(response, 409, { error: "job belongs to another provider" }); return null; }
  return job;
}
async function handleProviderResult(request, response, jobId) {
  const body = await readJson(request);
  const job = authorizedJob(response, request, body, jobId);
  if (!job) return;
  if (job.stream) return send(response, 409, { error: "stream jobs must use the chunk endpoint" });
  job.status = body.error ? "failed" : "complete";
  finishJob(job, { providerId: job.providerId, content: body.content, finish_reason: body.finish_reason, usage: body.usage, error: body.error });
  return send(response, 202, { accepted: true });
}
async function handleProviderChunk(request, response, jobId) {
  const body = await readJson(request);
  const job = authorizedJob(response, request, body, jobId);
  if (!job) return;
  if (!job.stream) return send(response, 409, { error: "non-stream jobs must use the result endpoint" });
  if (body.error) {
    job.status = "failed";
    finishJob(job, { providerId: job.providerId, error: String(body.error) });
    return send(response, 202, { accepted: true });
  }
  if (typeof body.delta === "string" && body.delta) {
    job.completionChars += body.delta.length;
    streamChunk(job, { content: body.delta });
  }
  if (body.done === true) {
    job.status = "complete";
    const accounted = finalUsage(job, { usage: body.usage });
    streamChunk(job, {}, body.finish_reason || "stop", accounted.usage);
    sse(job.response, "[DONE]");
    job.response.end();
    finishJob(job, { providerId: job.providerId, usage: accounted.usage });
  }
  return send(response, 202, { accepted: true });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, { ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin } : {}), "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
      return response.end();
    }
    if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { ok: true, service: "dasha-compute", version: "0.3.0" });
    if (request.method === "GET" && url.pathname === "/v1/models") return send(response, 200, { object: "list", data: openrouterModels() });
    if (request.method === "GET" && url.pathname === "/v1/network") {
      const now = Date.now();
      const online = [...providers.values()].filter((provider) => now - provider.lastSeenAt < providerFreshnessMs);
      return send(response, 200, { version: "0.3.0", providers_online: online.length, models_available: [...new Set(online.flatMap((provider) => provider.models))], jobs_queued: [...jobs.values()].filter((job) => job.status === "queued").length, jobs_completed: jobsCompleted, tokens_completed: tokensCompleted, streaming: true });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") return await handleChat(request, response);
    if (request.method === "POST" && url.pathname === "/v1/providers/poll") return await handleProviderPoll(request, response);
    const resultMatch = request.method === "POST" && url.pathname.match(/^\/v1\/providers\/jobs\/([^/]+)\/result$/);
    if (resultMatch) return await handleProviderResult(request, response, resultMatch[1]);
    const chunkMatch = request.method === "POST" && url.pathname.match(/^\/v1\/providers\/jobs\/([^/]+)\/chunk$/);
    if (chunkMatch) return await handleProviderChunk(request, response, chunkMatch[1]);
    return send(response, 404, { error: { message: "route not implemented", type: "not_found" } });
  } catch (error) {
    return send(response, Number(error.status || 500), { error: { message: error.status ? error.message : "internal error", type: error.status ? "invalid_request_error" : "server_error" } });
  }
});
// Refuse to start on a non-loopback interface with the public default keys.
// Local runs keep the convenient defaults; anything reachable from the
// network must set DASHA_API_KEY and DASHA_PROVIDER_KEY explicitly.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(bindHost) && (consumerKey === DEFAULT_CONSUMER_KEY || providerKey === DEFAULT_PROVIDER_KEY)) {
  process.stderr.write(
    `refusing to start: HOST=${bindHost} is not loopback but DASHA_API_KEY/DASHA_PROVIDER_KEY are still the public defaults — set real keys\n`
  );
  process.exit(1);
}
server.listen(port, bindHost, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  process.stdout.write(`dasha-compute coordinator listening on http://${bindHost}:${actualPort}\n`);
});
function shutdown() { server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

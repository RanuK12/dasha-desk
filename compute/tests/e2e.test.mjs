import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const python = process.env.DASHA_TEST_PYTHON || "python3";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

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

async function coordinator(context) {
  return spawnCoordinator(context, { DASHA_API_KEY: "consumer-test", DASHA_PROVIDER_KEY: "provider-test" });
}

async function pollForJob(base, providerId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${base}/v1/providers/poll`, {
      method: "POST",
      headers: { Authorization: "Bearer provider-test", "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: providerId, name: "Test Mac", models: ["qwen3-8b"] }),
    });
    if (response.status === 204) { await new Promise((resolve) => setTimeout(resolve, 25)); continue; }
    assert.equal(response.status, 200);
    return (await response.json()).job;
  }
  throw new Error("provider did not receive a job");
}

test("macOS installer and service scripts are shell-valid", () => {
  for (const file of ["install.sh", "provider/run-provider", "provider/dasha-compute"]) execFileSync("sh", ["-n", file], { cwd: new URL("..", import.meta.url) });
  const help = execFileSync("sh", ["install.sh", "--help"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.match(help, /DASHA_PROVIDER_ID/);
  assert.match(help, /\.dasha-provider-key/);
  assert.match(help, /DASHA_PROVIDER_KEY_FILE/);
  assert.doesNotMatch(help, /DASHA_PROVIDER_KEY=/);
});

async function fakeDarwinBin(directory) {
  const fakeBin = join(directory, "bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "uname"), "#!/bin/sh\nprintf 'Darwin\\n'\n", "utf8");
  await chmod(join(fakeBin, "uname"), 0o755);
  return fakeBin;
}

test("macOS installer consumes a 0600 key file and keeps the token off argv", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dasha-compute-keyfile-"));
  const fakeBin = await fakeDarwinBin(directory);
  const token = "tok_9f3k2m8q1";
  const keyFile = join(directory, "provider.key");
  await writeFile(keyFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(fakeBin, "python3"), `#!/bin/sh\nprintf 'argv:%s\\n' "$*" >> "$HOME/python.argv"\nexit 0\n`, "utf8");
  await writeFile(join(fakeBin, "security"), `#!/bin/sh\nprintf 'argv:%s\\n' "$*" >> "$HOME/security.argv"\nexit 0\n`, "utf8");
  await writeFile(join(fakeBin, "launchctl"), `#!/bin/sh\nprintf 'argv:%s\\n' "$*" >> "$HOME/launchctl.argv"\nexit 0\n`, "utf8");
  await chmod(join(fakeBin, "python3"), 0o755);
  await chmod(join(fakeBin, "security"), 0o755);
  await chmod(join(fakeBin, "launchctl"), 0o755);
  context.after(() => rm(directory, { recursive: true, force: true }));

  const child = spawn("sh", ["install.sh"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      HOME: directory,
      PATH: `${fakeBin}:${process.env.PATH}`,
      DASHA_PROVIDER_ID: "test-mac",
      DASHA_MODEL_MAP: "qwen3-8b=qwen3:8b",
      DASHA_PROVIDER_KEY_FILE: keyFile,
    },
  });
  const argvLog = [];
  child.on("spawn", () => argvLog.push(...child.spawnargs));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0, stderr || stdout);
  assert.deepEqual(argvLog, ["sh", "install.sh"]);
  assert.ok(!argvLog.join(" ").includes(token));
  await assert.rejects(readFile(keyFile, "utf8"), { code: "ENOENT" });

  const plist = await readFile(join(directory, "Library/LaunchAgents/com.getdasha.compute.provider.plist"), "utf8");
  assert.match(plist, /<string>.*\/run-provider<\/string>/);
  assert.doesNotMatch(plist, new RegExp(token));
  assert.doesNotMatch(plist, /DASHA_PROVIDER_KEY/);

  const providerEnv = await readFile(join(directory, "Library/Application Support/Dasha Compute/provider.env"), "utf8");
  assert.doesNotMatch(providerEnv, new RegExp(token));
  assert.doesNotMatch(providerEnv, /DASHA_PROVIDER_KEY/);

  const launchctlArgv = await readFile(join(directory, "launchctl.argv"), "utf8");
  assert.doesNotMatch(launchctlArgv, new RegExp(token));
  const pythonArgv = await readFile(join(directory, "python.argv"), "utf8");
  assert.doesNotMatch(pythonArgv, new RegExp(token));
});

test("macOS installer refuses a missing key file instead of a command-line token", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dasha-compute-nokey-"));
  const fakeBin = await fakeDarwinBin(directory);
  context.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn("sh", ["install.sh"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      HOME: directory,
      PATH: `${fakeBin}:${process.env.PATH}`,
      DASHA_PROVIDER_ID: "test-mac",
      DASHA_MODEL_MAP: "qwen3-8b=qwen3:8b",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /\.dasha-provider-key/);
  assert.match(stderr, /Do not put DASHA_PROVIDER_KEY on the command line/);
});

test("kit README documents the file handoff for live registration", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /\.dasha-provider-key/);
  assert.match(readme, /python3 provider\/save-provider-key\.py/);
  assert.doesNotMatch(readme, /DASHA_PROVIDER_KEY=\S+.*\.\/install\.sh/s);
});

test("macOS installer rejects shell syntax in coordinator URLs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dasha-compute-installer-"));
  const fakeBin = await fakeDarwinBin(directory);
  context.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "must-not-exist");
  const child = spawn("sh", ["install.sh"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      HOME: directory,
      PATH: `${fakeBin}:${process.env.PATH}`,
      DASHA_PROVIDER_ID: "test-mac",
      DASHA_PROVIDER_KEY: "provider-test",
      DASHA_MODEL_MAP: "qwen3-8b=qwen3:8b",
      DASHA_COORDINATOR_URL: `https://example.com/'\n: > '${marker}'\n#`,
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /unsupported characters/);
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
});

test("provider doctor fails when a configured Ollama model is missing", async (context) => {
  const port = await freePort();
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/api/tags" ? { models: [] } : { version: "test" }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  context.after(() => server.close());
  const child = spawn(python, ["provider/agent.py", "--doctor"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, DASHA_COORDINATOR_URL: `http://127.0.0.1:${port}`, OLLAMA_URL: `http://127.0.0.1:${port}`, DASHA_MODEL_MAP: "qwen3-8b=qwen3:8b", DASHA_DOCTOR_TEST_PLATFORM: "Darwin:arm64:15.0" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /models\s+failed · missing: qwen3:8b/);
  assert.match(stderr, /ollama pull qwen3:8b/);
});

test("provider advertises only installed Ollama models", async (context) => {
  const port = await freePort();
  let heartbeat;
  const server = http.createServer((request, response) => {
    if (request.url === "/api/tags") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      heartbeat = JSON.parse(raw);
      response.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  context.after(() => server.close());
  const child = spawn(python, ["provider/agent.py", "--once"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, DASHA_COORDINATOR_URL: `http://127.0.0.1:${port}`, OLLAMA_URL: `http://127.0.0.1:${port}`, DASHA_PROVIDER_KEY: "provider-test", DASHA_PROVIDER_ID: "test-mac", DASHA_MODEL_MAP: "qwen3-8b=qwen3:8b,gemma3-12b=gemma3:12b" },
  });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0);
  assert.deepEqual(heartbeat.models, ["qwen3-8b"]);
});

test("streaming live providers renew leases and honor cancellation", () => {
  const probe = `
import importlib.util, sys, threading
spec = importlib.util.spec_from_file_location("dasha_compute_agent", "provider/agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
agent.COORDINATOR = "https://lobby.getdasha.com/compute/api"
agent.MODELS = {"qwen3-8b": "qwen3:8b"}
agent.installed_models = lambda: {"qwen3:8b"}
heartbeat_started = threading.Event()
def keep_lease(_job_id, _lease_seconds, stop, cancelled):
    cancelled.set()
    heartbeat_started.set()
    stop.wait()
agent.keep_lease = keep_lease
class OllamaStream:
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def __iter__(self): return iter([b'{"message":{"content":"must not be relayed"}}\\n'])
def open_stream(*_args, **_kwargs):
    assert heartbeat_started.wait(1), "stream heartbeat did not start"
    return OllamaStream()
agent.urllib.request.urlopen = open_stream
reported = []
agent.report_chunk = lambda _job_id, **chunk: reported.append(chunk)
agent.request_json = lambda url, **_kwargs: {"job": {"id": "job_stream", "model": "qwen3-8b", "stream": True}, "lease_seconds": 300} if url.endswith("/providers/poll") else {}
sys.argv = ["agent.py", "--once"]
agent.main()
assert reported == [], reported
`;
  const output = execFileSync(python, ["-B", "-c", probe], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.match(output, /cancelled job_stream/);
});

test("provider reports Ollama stream errors as failures", () => {
  const probe = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("dasha_compute_agent", "provider/agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
agent.COORDINATOR = "https://lobby.getdasha.com/compute/api"
agent.MODELS = {"qwen3-8b": "qwen3:8b"}
agent.installed_models = lambda: {"qwen3:8b"}
agent.keep_lease = lambda _job_id, _lease_seconds, stop, _cancelled: stop.wait()
class OllamaStream:
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def __iter__(self): return iter([b'{"error":"model runner crashed"}\\n'])
agent.urllib.request.urlopen = lambda *_args, **_kwargs: OllamaStream()
reported = []
agent.report_chunk = lambda _job_id, **chunk: reported.append(chunk)
agent.request_json = lambda url, **_kwargs: {"job": {"id": "job_error", "model": "qwen3-8b", "messages": [], "stream": True}, "lease_seconds": 300} if url.endswith("/providers/poll") else {}
sys.argv = ["agent.py", "--once"]
agent.main()
assert reported == [{"error": "provider inference failed: RuntimeError"}], reported
class TruncatedStream:
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def __iter__(self): return iter([b'{"message":{"content":"partial"},"done":false}\\n'])
agent.urllib.request.urlopen = lambda *_args, **_kwargs: TruncatedStream()
reported.clear()
agent.request_json = lambda url, **_kwargs: {"job": {"id": "job_truncated", "model": "qwen3-8b", "messages": [], "stream": True}, "lease_seconds": 300} if url.endswith("/providers/poll") else {}
agent.main()
assert reported == [{"delta": "partial"}, {"error": "provider inference failed: RuntimeError"}], reported
`;
  const output = execFileSync(python, ["-B", "-c", probe], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.doesNotMatch(output, /completed job_(?:error|truncated)/);
});

test("provider benchmark reports measured model throughput", async (context) => {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "dasha-compute-benchmark-"));
  const benchmarkPath = join(directory, "benchmark.json");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/api/tags" ? { models: [{ name: "qwen3:8b" }] } : { message: { content: "ok" }, eval_count: 40, eval_duration: 2_000_000_000 }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  context.after(() => server.close());
  const child = spawn(python, ["provider/agent.py", "--benchmark"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, OLLAMA_URL: `http://127.0.0.1:${port}`, DASHA_MODEL_MAP: "qwen3-8b=qwen3:8b", DASHA_BENCHMARK_PATH: benchmarkPath },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.results[0].model, "qwen3-8b");
  assert.equal(result.results[0].tokens_per_second, 20);
  assert.deepEqual(JSON.parse(await readFile(benchmarkPath, "utf8")), result);
});

test("routes one OpenAI-style completion through a provider", async (context) => {
  const base = await coordinator(context);
  const provider = (async () => {
    const job = await pollForJob(base, "test-mac");
    assert.equal(job.stream, false);
    const accepted = await fetch(`${base}/v1/providers/jobs/${job.id}/result`, {
      method: "POST",
      headers: { Authorization: "Bearer provider-test", "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "test-mac", content: "the casino has become self-aware", usage: { prompt_tokens: 7, completion_tokens: 6, total_tokens: 13 } }),
    });
    assert.equal(accepted.status, 202);
  })();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer consumer-test", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3-8b", messages: [{ role: "user", content: "hello" }] }),
  });
  const body = await response.json();
  await provider;
  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, "the casino has become self-aware");
  assert.equal(body.usage.total_tokens, 13);
  assert.equal(response.headers.get("x-dasha-privacy"), "tls-relay-alpha");
});

test("relays provider deltas as OpenAI-compatible SSE", async (context) => {
  const base = await coordinator(context);
  const provider = (async () => {
    const job = await pollForJob(base, "stream-mac");
    assert.equal(job.stream, true);
    for (const payload of [
      { delta: "hello " },
      { delta: "from the edge" },
      { done: true, finish_reason: "stop", usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
    ]) {
      const accepted = await fetch(`${base}/v1/providers/jobs/${job.id}/chunk`, {
        method: "POST",
        headers: { Authorization: "Bearer provider-test", "Content-Type": "application/json" },
        body: JSON.stringify({ provider_id: "stream-mac", ...payload }),
      });
      assert.equal(accepted.status, 202);
    }
  })();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer consumer-test", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3-8b", stream: true, messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = await response.text();
  await provider;
  assert.match(events, /"content":"hello "/);
  assert.match(events, /"content":"from the edge"/);
  assert.match(events, /"finish_reason":"stop"/);
  assert.match(events, /data: \[DONE\]/);
});

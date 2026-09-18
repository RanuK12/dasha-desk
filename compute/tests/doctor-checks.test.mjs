import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import test from "node:test";

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

/* Mock that serves one port as both coordinator and Ollama. routes maps
   "METHOD path" to { status, body }; anything unmapped returns 404, which
   the doctor treats as "no verify endpoint". */
async function mockServer(context, routes) {
  const port = await freePort();
  const server = http.createServer((request, response) => {
    const key = `${request.method} ${request.url}`;
    const route = routes[key];
    if (!route) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.writeHead(route.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(route.body));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  context.after(() => server.close());
  return port;
}

function baseRoutes(overrides = {}) {
  return {
    "GET /healthz": { status: 200, body: { ok: true, service: "dasha-compute", version: "0.3.0" } },
    "GET /api/tags": { status: 200, body: { models: [{ name: "qwen3:8b" }] } },
    "GET /api/version": { status: 200, body: { version: "0.33.1" } },
    ...overrides,
  };
}

async function runDoctor(env, extraArgs = []) {
  const child = spawn(python, ["provider/agent.py", "--doctor", ...extraArgs], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  return { code, stdout, stderr };
}

function doctorEnv(port, extra = {}) {
  return {
    DASHA_COORDINATOR_URL: `http://127.0.0.1:${port}`,
    OLLAMA_URL: `http://127.0.0.1:${port}`,
    DASHA_MODEL_MAP: "qwen3-8b=qwen3:8b",
    DASHA_DOCTOR_TEST_MEMORY_GB: "64",
    // the OS gate (G1) would fail on Linux CI; these tests target the other
    // checks, and G1/G3 have their own platform-hook cases below
    DASHA_DOCTOR_TEST_PLATFORM: "Darwin:arm64:15.0",
    ...extra,
  };
}

test("doctor G4 fails when Ollama is below the version floor", async (context) => {
  const port = await mockServer(context, baseRoutes({ "GET /api/version": { status: 200, body: { version: "0.15.3" } } }));
  const { code, stderr } = await runDoctor(doctorEnv(port));
  assert.equal(code, 1);
  assert.match(stderr, /ollama-version\s+failed · found 0\.15\.3, need ≥ 0\.33\.1/);
  assert.match(stderr, /run: brew upgrade ollama/);
});

test("doctor G4 warns (does not fail) on an unparseable Ollama version", async (context) => {
  const port = await mockServer(context, baseRoutes({ "GET /api/version": { status: 200, body: { version: "test" } } }));
  const { code, stderr } = await runDoctor(doctorEnv(port));
  assert.equal(code, 0);
  assert.match(stderr, /ollama-version\s+warn/);
});

test("doctor G5 fails when the port does not answer as Ollama", async (context) => {
  const port = await mockServer(context, baseRoutes({ "GET /api/version": { status: 200, body: { not: "ollama" } } }));
  const { code, stderr } = await runDoctor(doctorEnv(port));
  assert.equal(code, 1);
  assert.match(stderr, /ollama\s+failed · .*does not answer as Ollama \(is another service bound there\?\)/);
  assert.match(stderr, /lsof -ti tcp:11434/);
});

test("doctor G6 fails when free disk cannot cover missing model pulls", async (context) => {
  const port = await mockServer(context, baseRoutes({ "GET /api/tags": { status: 200, body: { models: [] } } }));
  const { code, stderr } = await runDoctor(doctorEnv(port, { DASHA_DOCTOR_TEST_DISK_FREE_GB: "1" }));
  assert.equal(code, 2); // models + disk both fail; exit code counts failing checks
  assert.match(stderr, /disk\s+failed · need ~5\.2 GB for missing models \(qwen3:8b\), have 1\.0 GB free/);
  assert.match(stderr, /ollama rm <unused-model>/);
});

test("doctor G6 passes when free disk covers the missing pulls", async (context) => {
  const port = await mockServer(context, baseRoutes({ "GET /api/tags": { status: 200, body: { models: [] } } }));
  const { code, stdout, stderr } = await runDoctor(doctorEnv(port, { DASHA_DOCTOR_TEST_DISK_FREE_GB: "100" }));
  assert.doesNotMatch(stderr, /disk\s+failed/);
  assert.match(stdout, /disk\s+ok · need ~5\.2 GB for missing models \(qwen3:8b\), have 100\.0 GB free/);
  // the models check still fails (qwen3:8b is missing), only the disk check is asserted here
  assert.equal(code, 1);
});

test("doctor G7 fails with a re-register hint when the coordinator rejects the token", async (context) => {
  const port = await mockServer(context, baseRoutes({
    "POST /v1/providers/verify": { status: 401, body: { error: "bad key" } },
  }));
  const { code, stderr } = await runDoctor(doctorEnv(port));
  assert.equal(code, 1);
  assert.match(stderr, /key\s+failed · coordinator rejected the provider token \(401\)/);
  assert.match(stderr, /re-register this Mac on getdasha\.com\/compute → Provide/);
  assert.match(stderr, /dasha-compute uninstall/);
  assert.doesNotMatch(stderr, /gateway\s+failed/);
});

test("doctor G7 skips when the coordinator exposes no verify endpoint", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const { code, stdout, stderr } = await runDoctor(doctorEnv(port));
  assert.equal(code, 0);
  assert.match(stdout, /key\s+skip · this coordinator has no verify endpoint/);
  assert.doesNotMatch(stderr, /key\s+failed/);
});

test("doctor G7 on the live path reuses the gateway verify verdict", async (context) => {
  const port = await mockServer(context, baseRoutes({
    "POST /compute/api/providers/verify": { status: 401, body: { error: "bad key" } },
  }));
  const env = doctorEnv(port, { DASHA_COORDINATOR_URL: `http://127.0.0.1:${port}/compute/api` });
  const { code, stderr } = await runDoctor(env);
  assert.equal(code, 1);
  assert.match(stderr, /key\s+failed · coordinator rejected the provider token \(401\)/);
  assert.doesNotMatch(stderr, /gateway\s+failed/);
});

test("doctor G11 warns (never fails) when a mapped model exceeds unified memory", async (context) => {
  const port = await mockServer(context, baseRoutes({
    "GET /api/tags": { status: 200, body: { models: [{ name: "qwen3:8b" }, { name: "gpt-oss:120b" }] } },
  }));
  const env = doctorEnv(port, {
    DASHA_MODEL_MAP: "qwen3-8b=qwen3:8b,gpt-oss-120b=gpt-oss:120b",
    DASHA_DOCTOR_TEST_MEMORY_GB: "16",
  });
  const { code, stderr } = await runDoctor(env);
  assert.equal(code, 0);
  assert.match(stderr, /models\s+warn · gpt-oss-120b needs ≥ 96 GB unified memory — this Mac has 16 GB/);
  assert.match(stderr, /serve only: qwen3-8b/);
});

test("doctor --json emits the machine-readable check contract", async (context) => {
  const port = await mockServer(context, baseRoutes({
    "POST /v1/providers/verify": { status: 200, body: { ok: true } },
  }));
  const { code, stdout } = await runDoctor(doctorEnv(port), ["--json"]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.exit_code, 0);
  assert.deepEqual(payload.checks.map((check) => check.name),
    ["os", "python", "gateway", "network", "ollama", "ollama-version", "models", "disk", "memory-fit", "mlx", "key", "service", "keychain", "benchmark"]);
  for (const check of payload.checks) {
    assert.match(check.status, /^(pass|fail|warn|skip)$/);
    assert.equal(typeof check.detail, "string");
  }
  assert.equal(payload.checks.find((check) => check.name === "key").status, "pass");
});

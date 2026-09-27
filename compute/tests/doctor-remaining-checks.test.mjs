import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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
   "METHOD path" to { status, body }; anything unmapped returns 404. */
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

/* Coordinator that accepts connections but never responds — the client
   hits its 5s timeout. */
async function hangingServer(context) {
  const port = await freePort();
  const sockets = new Set();
  const server = http.createServer(() => { /* never respond */ });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  context.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
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
  const testHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dasha-doctor-isolated-"));
  try {
    const child = spawn(python, ["provider/agent.py", "--doctor", ...extraArgs], {
      cwd: new URL("..", import.meta.url),
      // Avoid contacting the operator's real LaunchAgent or Keychain on macOS.
      env: { ...process.env, HOME: testHome, DASHA_DOCTOR_TEST_KEYCHAIN: "ok", DASHA_DOCTOR_TEST_LAUNCHCTL: "loaded", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    return { code, stdout, stderr };
  } finally {
    await fs.promises.rm(testHome, { recursive: true, force: true });
  }
}

function doctorEnv(port, extra = {}) {
  return {
    DASHA_COORDINATOR_URL: `http://127.0.0.1:${port}`,
    OLLAMA_URL: `http://127.0.0.1:${port}`,
    DASHA_MODEL_MAP: "qwen3-8b=qwen3:8b",
    DASHA_DOCTOR_TEST_MEMORY_GB: "64",
    // the OS gate (G1) would fail on Linux CI; these tests target the other
    // checks, and G1 has its own platform-hook cases below
    DASHA_DOCTOR_TEST_PLATFORM: "Darwin:arm64:15.0",
    ...extra,
  };
}

/* A fake $HOME so the post-install checks (G9/G10/G12) resolve against a
   hermetic install dir instead of the real ~/Library/... */
async function freshHome(context) {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dasha-doctor-"));
  context.after(async () => { await fs.promises.rm(home, { recursive: true, force: true }); });
  return home;
}

async function installInto(home, { agent = true, cli = true } = {}) {
  const appDir = path.join(home, "Library", "Application Support", "Dasha Compute");
  await fs.promises.mkdir(appDir, { recursive: true });
  await fs.promises.writeFile(path.join(appDir, "provider.env"), "DASHA_PROVIDER_ID=test-mac\n");
  if (agent) await fs.promises.writeFile(path.join(appDir, "agent.py"), "# test install\n");
  if (cli) {
    const binDir = path.join(home, "bin");
    await fs.promises.mkdir(binDir, { recursive: true });
    await fs.promises.writeFile(path.join(binDir, "dasha-compute"), "#!/bin/sh\n");
  }
  return appDir;
}

/* --- G1: macOS + Apple Silicon gate --- */

test("doctor G1 fails on non-macOS with a clear message", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  const { code, stderr } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_DOCTOR_TEST_PLATFORM: "Linux:x86_64",
  }));
  assert.equal(code, 1); // only the os gate fails; everything else passes or skips
  assert.match(stderr, /os\s+failed · Dasha Compute providers require macOS/);
  assert.match(stderr, /see compute\/README\.md §2/);
});

test("doctor G1 warns (does not fail) on Intel macOS", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  const { code, stdout, stderr } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_DOCTOR_TEST_PLATFORM: "Darwin:x86_64:14.5",
  }));
  assert.equal(code, 0);
  assert.match(stderr, /os\s+warn · Intel Mac detected — inference will be slow; Apple Silicon recommended/);
  assert.doesNotMatch(stdout, /os\s+ok/);
});

test("doctor G1 passes on Apple Silicon", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  const { code, stdout } = await runDoctor(doctorEnv(port, { HOME: home }));
  assert.equal(code, 0);
  assert.match(stdout, /os\s+ok · macOS 15\.0 on Apple Silicon/);
});

/* --- G3: MLX capability flag --- */

test("doctor G3 reports the MLX flag on Apple Silicon", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  const { code, stdout } = await runDoctor(doctorEnv(port, { HOME: home }));
  assert.equal(code, 0);
  assert.match(stdout, /mlx\s+ok · M-series GPU usable \(macOS 15\.0\)/);
});

test("doctor G3 warns on Apple Silicon below macOS 14", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  const { code, stderr } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_DOCTOR_TEST_PLATFORM: "Darwin:arm64:13.6",
  }));
  assert.equal(code, 0);
  assert.match(stderr, /mlx\s+warn · mlx needs macOS ≥ 14 \(this Mac: 13\.6\)/);
});

test("doctor G3 warns that MLX is unavailable on Intel", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  const { code, stderr } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_DOCTOR_TEST_PLATFORM: "Darwin:x86_64:14.5",
  }));
  assert.equal(code, 0);
  assert.match(stderr, /mlx\s+warn · mlx unavailable on Intel Macs/);
});

/* --- G14: Python version floor --- */

test("doctor G14 fails below the Python floor", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  const { code, stderr } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_DOCTOR_TEST_PYTHON_VERSION: "3.9.7",
  }));
  assert.equal(code, 1);
  assert.match(stderr, /python\s+failed · found 3\.9\.7, need ≥ 3\.10/);
  assert.match(stderr, /brew install python@3\.12/);
});

test("doctor G14 passes above the floor", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  const { code, stdout } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_DOCTOR_TEST_PYTHON_VERSION: "3.12.1",
  }));
  assert.equal(code, 0);
  assert.match(stdout, /python\s+ok · 3\.12\.1 ≥ 3\.10/);
});

/* --- G8: coordinator TLS / clock-skew classification --- */

test("doctor G8 classifies a refused coordinator connection", async (context) => {
  const ollamaPort = await mockServer(context, baseRoutes());
  const closedPort = await freePort(); // nothing listens here
  const home = await freshHome(context);
  const { code, stderr } = await runDoctor(doctorEnv(ollamaPort, {
    HOME: home,
    DASHA_COORDINATOR_URL: `http://127.0.0.1:${closedPort}`,
  }));
  assert.equal(code, 1);
  assert.match(stderr, /gateway\s+failed · connection refused — coordinator down or URL wrong \(DASHA_COORDINATOR_URL=http:\/\/127\.0\.0\.1:\d+\)/);
  assert.match(stderr, /check the coordinator URL, then re-run: dasha-compute doctor/);
  assert.doesNotMatch(stderr, /urlopen error/);
});

test("doctor G8 classifies a coordinator timeout", async (context) => {
  const ollamaPort = await mockServer(context, baseRoutes());
  const hangingPort = await hangingServer(context);
  const home = await freshHome(context);
  const { code, stderr } = await runDoctor(doctorEnv(ollamaPort, {
    HOME: home,
    DASHA_COORDINATOR_URL: `http://127.0.0.1:${hangingPort}`,
  }));
  assert.equal(code, 1);
  assert.match(stderr, /gateway\s+failed · timed out after 5s — firewall or DNS blocking\?/);
  assert.doesNotMatch(stderr, /urlopen error/);
}, { timeout: 60000 });

test("doctor G8 classifies a TLS failure to the coordinator", async (context) => {
  const ollamaPort = await mockServer(context, baseRoutes());
  const plainPort = await mockServer(context, baseRoutes()); // plain HTTP, not TLS
  const home = await freshHome(context);
  const { code, stderr } = await runDoctor(doctorEnv(ollamaPort, {
    HOME: home,
    DASHA_COORDINATOR_URL: `https://127.0.0.1:${plainPort}`,
  }));
  assert.equal(code, 1);
  assert.match(stderr, /gateway\s+failed · TLS handshake failed/);
  assert.doesNotMatch(stderr, /urlopen error/);
});

/* --- G13: network egress quality --- */

test("doctor G13 warns on a slow coordinator round trip", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  const { code, stderr } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_DOCTOR_TEST_GATEWAY_RTT_S: "4.2",
  }));
  assert.equal(code, 0); // advisory only — warns, never fails
  assert.match(stderr, /network\s+warn · coordinator round trip 4\.2s \(job poll needs < 2s\) — check Wi-Fi \/ VPN/);
});

test("doctor G13 passes on a fast round trip", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  const { code, stdout } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_DOCTOR_TEST_GATEWAY_RTT_S: "0.12",
  }));
  assert.equal(code, 0);
  assert.match(stdout, /network\s+ok · coordinator round trip 0\.1s/);
});

/* --- G9: LaunchAgent / service state --- */

test("doctor G9 skips pre-install (source tree)", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context); // no provider.env written
  const { code, stdout } = await runDoctor(doctorEnv(port, { HOME: home }));
  assert.equal(code, 0);
  assert.match(stdout, /service\s+skip · not installed — service check runs post-install/);
});

test("doctor G9 fails when install files are missing", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  await installInto(home, { agent: false });
  const { code, stderr } = await runDoctor(doctorEnv(port, { HOME: home }));
  assert.equal(code, 1);
  assert.match(stderr, /service\s+failed · .*agent\.py missing/);
  assert.match(stderr, /re-run install\.sh/);
});

test("doctor G9 passes when the LaunchAgent is loaded", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  await installInto(home);
  const { code, stdout } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_DOCTOR_TEST_LAUNCHCTL: "loaded",
  }));
  assert.equal(code, 0);
  assert.match(stdout, /service\s+ok · LaunchAgent com\.getdasha\.compute\.provider loaded/);
});

test("doctor G9 fails when the LaunchAgent is not bootstrapped", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  await installInto(home);
  const { code, stderr } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_DOCTOR_TEST_LAUNCHCTL: "missing",
  }));
  assert.equal(code, 1);
  assert.match(stderr, /service\s+failed · LaunchAgent com\.getdasha\.compute\.provider missing or not bootstrapped/);
  assert.match(stderr, /run: dasha-compute start/);
});

test("doctor G9 passes (info) when installed but stopped", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  await installInto(home);
  const { code, stdout } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_DOCTOR_TEST_LAUNCHCTL: "stopped",
  }));
  assert.equal(code, 0);
  assert.match(stdout, /service\s+ok · LaunchAgent com\.getdasha\.compute\.provider installed but not running — run: dasha-compute start/);
});

/* --- G10: Keychain accessibility --- */

test("doctor G10 skips pre-install", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  const { code, stdout } = await runDoctor(doctorEnv(port, { HOME: home }));
  assert.equal(code, 0);
  assert.match(stdout, /keychain\s+skip · not installed — Keychain check runs post-install/);
});

test("doctor G10 passes when the Keychain read succeeds", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  await installInto(home);
  const { code, stdout } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_DOCTOR_TEST_KEYCHAIN: "ok",
  }));
  assert.equal(code, 0);
  assert.match(stdout, /keychain\s+ok · provider token readable from Keychain/);
});

test("doctor G10 fails without printing the token when the read is denied", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  await installInto(home);
  const sentinel = "s3cr3t-token-sentinel";
  const { code, stdout, stderr } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_PROVIDER_KEY: sentinel,
    DASHA_DOCTOR_TEST_KEYCHAIN: "denied",
  }));
  assert.equal(code, 1);
  assert.match(stderr, /keychain\s+failed · cannot read the stored provider token/);
  assert.match(stderr, /re-run install\.sh or check Keychain access prompts/);
  assert.doesNotMatch(stdout + stderr, new RegExp(sentinel));
});

/* --- G12: benchmark freshness --- */

test("doctor G12 skips pre-install", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  const stale = path.join(home, "benchmark.json");
  await fs.promises.writeFile(stale, JSON.stringify({ measured_at: Date.now() - 47 * 86400_000 }));
  const { code, stdout } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_BENCHMARK_PATH: stale,
  }));
  assert.equal(code, 0);
  assert.match(stdout, /benchmark\s+skip · not installed — benchmark check runs post-install/);
});

test("doctor G12 warns on a stale benchmark", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  await installInto(home);
  const stale = path.join(home, "benchmark.json");
  await fs.promises.writeFile(stale, JSON.stringify({ measured_at: Date.now() - 47 * 86400_000 }));
  const { code, stderr } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_BENCHMARK_PATH: stale,
  }));
  assert.equal(code, 0); // warn-only
  assert.match(stderr, /benchmark\s+warn · benchmark\.json is 47 days old/);
  assert.match(stderr, /refresh with: dasha-compute benchmark/);
});

test("doctor G12 passes on a fresh benchmark", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  await installInto(home);
  const fresh = path.join(home, "benchmark.json");
  await fs.promises.writeFile(fresh, JSON.stringify({ measured_at: Date.now() }));
  const { code, stdout } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_BENCHMARK_PATH: fresh,
  }));
  assert.equal(code, 0);
  assert.match(stdout, /benchmark\s+ok · benchmark\.json is 0 days old/);
});

test("doctor G12 skips when no benchmark.json exists yet", async (context) => {
  const port = await mockServer(context, baseRoutes());
  const home = await freshHome(context);
  await installInto(home);
  const { code, stdout } = await runDoctor(doctorEnv(port, {
    HOME: home,
    DASHA_BENCHMARK_PATH: path.join(home, "benchmark.json"),
  }));
  assert.equal(code, 0);
  assert.match(stdout, /benchmark\s+skip · no benchmark\.json at .* yet/);
});

# `dasha-compute doctor` — gap spec

**Status:** spec only — no implementation.  
**Scope:** `compute/provider/agent.py --doctor` (also exposed as `dasha-compute doctor`).  
**Goal:** every failure that currently surfaces only *after* install (at first job, at first model pull, or as a silent slow Mac) should be caught by `doctor` **before** the user invests further — supply of provider Macs is the binding constraint, and a confusing first-run experience is the most expensive kind of churn.

## Current coverage (what doctor already checks)

| # | Check | Implementation today | Exit behavior |
|---|-------|---------------------|---------------|
| D1 | Hardware line | `platform.system()/machine()`, Python version printed | info only |
| D2 | Coordinator reachability | `GET /healthz` (local) or `POST /providers/verify` (live lobby) | fail |
| D3 | Ollama reachability | `installed_models()` against `OLLAMA_URL` | fail |
| D4 | Mapped models installed | every `DASHA_MODEL_MAP` value present in Ollama library | fail + `ollama pull <model>` hint |

`doctor` exits nonzero when D2–D4 fail. Everything below is missing.

## Missing checks (spec)

Each check specifies: **command intent**, **pass criterion**, **fail exit message** (printed to stderr, exit-code nonzero via `failures` counter), and **remediation hint**.

### G1 — macOS + Apple Silicon gate
- **Why:** install.sh aborts on non-Darwin, but `agent.py --doctor` can be run standalone anywhere; a Linux download should fail *clearly* before the provider registers.
- **Pass:** `platform.system() == "Darwin"` and `platform.machine() in ("arm64",)` — with `x86_64` (Rosetta/Intel) downgraded to **warn**, not fail (Ollama runs, just slower).
- **Fail message:** `os failed · Dasha Compute providers require macOS; see compute/README.md §2`
- **Warn message:** `os warn · Intel Mac detected — inference will be slow; Apple Silicon recommended`

### G2 — chip + unified memory detection
- **Why:** model choice (qwen3-8b vs gemma3-27b) is really a memory question; a 8 GB Mac offering a 27B model will thrash and produce garbage latency.
- **How:** `sysctl -n machdep.cpu.brand_string`, `sysctl -n hw.memsize`, `sysctl -n hw.optional.arm.FEAT_SME` (or `/usr/bin/system_profiler SPHardwareDataType` fallback).
- **Pass:** chip name parsed, memsize reported ≥ 8 GB.
- **Fail message:** `memory failed · could not read unified memory (sysctl hw.memsize unavailable)`
- **Warn message:** `memory warn · 8 GB unified memory — use 8B-or-smaller quant models only (see ADD-A-MODEL.md memory tiers)`
- **Remediation:** link to the memory-tier catalog; doctor should print `recommended max model: qwen3-8b (q4)` etc. derived from the tier.

### G3 — MLX capability flag
- **Why:** MLX is the documented provider performance path ("Prefer MLX when you can"); doctor should tell the provider whether their chip can use it.
- **Pass:** arm64 + macOS ≥ 14 → `mlx ok · M-series GPU usable` (info). Intel → `mlx unavailable` (warn).
- **No fail** — MLX is optional; the line exists so the funnel can measure MLX-capable supply share.

### G4 — Ollama version ≥ minimum
- **Why:** today doctor only checks Ollama *reachability*. Features the funnel depends on (specific `/api` behaviors, MLX backend in newer Ollama, `ollama cp`) are version-gated.
- **How:** `GET {OLLAMA_URL}/api/version`.
- **Pass:** version parses and is ≥ the floor recorded in `compute/README.md` (currently ≥ 0.19 per the MLX research lane; the spec pins the floor in one place).
- **Fail message:** `ollama-version failed · found 0.15.3, need ≥ 0.19.0 — run: brew upgrade ollama`
- **Warn:** version unknown/unparseable → warn, not fail.

### G5 — Ollama port conflict / wrong server
- **Why:** port 11434 may be bound by a *different* Ollama (e.g. a stale install) or by something else entirely (a dev server). A model list from the wrong server makes D4 pass while the real Ollama has nothing.
- **How:** after listing models, fingerprint: `GET /api/version` must look like Ollama; also `lsof -iTCP:11434` optional.
- **Fail message:** `ollama failed · port 11434 does not answer as Ollama (is another service bound there?)`
- **Remediation:** `OLLAMA_URL` env override hint, or `lsof -ti tcp:11434 | xargs kill` hint.

### G6 — free disk for model pulls
- **Why:** a 4 GB free disk passes D3 but dies mid-`ollama pull` of a 16 GB model. The pull that *would have failed* should have failed as a doctor message, not as a hung installer.
- **How:** `shutil.disk_usage` on the Ollama models dir (respect `OLLAMA_MODELS`, else `~/.ollama`); sum the known download sizes of *missing* mapped models (a per-tag size table, conservative upper bounds checked in with the spec at implement time).
- **Pass:** free ≥ 1.5× the sum of missing-model sizes (headroom for temp files + KV cache).
- **Fail message:** `disk failed · need ~16 GB for missing models (qwen3:8b), have 3.2 GB free on /`
- **Remediation:** `ollama rm <unused>` hint, or reduce `DASHA_MODEL_MAP`.

### G7 — provider token validity (key check)
- **Why:** the *live* path already sends the token in `POST /providers/verify` — but on the *local* coordinator path the token is never validated, so a typo'd `DASHA_PROVIDER_KEY` installs fine and fails at first poll.
- **Pass:** if the coordinator exposes a verify endpoint, POST `{provider_id}` with the Bearer token and require 200. Local coordinator without the endpoint → **skip** (info), never fail.
- **Fail message:** `key failed · coordinator rejected the provider token (401) — re-register this Mac on getdasha.com/compute → Provide`
- **Remediation:** `dasha-compute uninstall` then re-run install with the fresh token; token is one-time and not recoverable from Keychain for display.

### G8 — coordinator TLS / clock skew
- **Why:** `https://lobby.getdasha.com` fails on machines with a wrong clock or captive portals that MITM TLS; the error today is a raw `urlopen` exception, unreadable.
- **How:** on TLS failure, classify: `ssl.SSLCertVerificationError` vs connection refused vs timeout.
- **Fail message (TLS):** `gateway failed · TLS verification failed — check date/time and that no VPN/proxy intercepts traffic`
- **Fail message (refused):** `gateway failed · connection refused — coordinator down or URL wrong (DASHA_COORDINATOR_URL=…)`
- **Fail message (timeout):** `gateway failed · timed out after 5s — firewall or DNS blocking?`

### G9 — LaunchAgent / service state (post-install only)
- **Why:** `dasha-compute doctor` after install should confirm the service layer, not just the daemon bits.
- **How:** `launchctl print gui/<uid>/com.getdasha.compute.provider`; check `$APP_DIR/agent.py`, `$APP_DIR/provider.env`, `~/bin/dasha-compute` exist.
- **Pass:** service loaded or explicitly stopped-but-installed → info line.
- **Fail message:** `service failed · LaunchAgent plist missing or not bootstrapped — run: dasha-compute start`
- **Skip** when run from the source tree (no `$APP_DIR/provider.env`) — doctor doubles as a pre-install checker in install.sh.

### G10 — Keychain accessibility of the token
- **Why:** `run-provider` reads the token via `security find-generic-password` at every start; if Keychain prompts deny or the item is missing, the service crash-loops silently.
- **How (post-install):** attempt a non-destructive `security find-generic-password -a <id> -s <label> -w` read (or at minimum `find-generic-password` existence check).
- **Fail message:** `keychain failed · cannot read the stored provider token — re-run install.sh or check Keychain access prompts`

### G11 — model memory fit vs unified memory
- **Why:** G2 tells us the Mac's memory; G6 checks disk. Neither stops an 8 GB Mac from registering `gpt-oss-120b` and then OOM-killing at first job.
- **How:** per-tag minimum-memory table (same source as the ADD-A-MODEL catalog); compare against G2's memsize.
- **Warn message:** `models warn · gpt-oss:120b needs ≥ 96 GB unified memory, this Mac has 16 GB — jobs on this model will likely OOM`
- **Warn, not fail** — the provider may serve only the smaller mapped models; doctor should say *which* mapped models are viable.

### G12 — benchmark freshness
- **Why:** install.sh writes `benchmark.json` once; a Mac that later degrades (thermal throttling, background load) keeps advertising stale throughput.
- **How (post-install):** if `$DASHA_BENCHMARK_PATH` exists and is older than 30 days → warn with re-run hint. Missing → info.
- **Warn message:** `benchmark warn · benchmark.json is 47 days old — refresh with: dasha-compute benchmark`

### G13 — network egress quality (light)
- **Why:** providers poll outbound; a Mac behind a proxy that breaks long-lived streaming will accept jobs and then fail them.
- **How:** time the D2 coordinator round trip; measure once, not continuously.
- **Warn message:** `network warn · coordinator round trip 4.2s (p99 job poll needs < 2s) — check Wi-Fi / VPN`
- **Fail:** none — advisory only; job timeouts belong to runtime telemetry, not doctor.

### G14 — Python version floor
- **Why:** agent.py uses `argparse`/`urllib` stdlib only, but future MLX wiring may need 3.10+.
- **Pass:** Python ≥ 3.10.
- **Fail message:** `python failed · found 3.9.x, need ≥ 3.10 — install from python.org or: brew install python@3.12`

## Exit contract (unchanged, extended)

- Exit `0` — everything passed (warns allowed).
- Exit `N > 0` — N failing checks; each failure printed to stderr as `<area> failed · <message> — <remediation>`.
- Machine-readable: `--json` flag (new) emits `{"checks": [{"name": "disk", "status": "pass|fail|warn|skip", "detail": "…", "remediation": "…"}], "exit_code": N}` for the installer and funnel analytics.

## Implementation notes (for whoever builds it)

1. Keep doctor stdlib-only (no new deps) — it runs on a fresh Mac before anything is installed.
2. The check registry should be a list of `(name, fn)` so new checks register in one place and `--json` output stays uniform.
3. `install.sh` runs doctor *before* Keychain write; G9/G10/G12 must skip gracefully pre-install.
4. Doctor must never print the provider token — only whether the key *validated*.
5. Re-run guidance: after any fail, print the exact next command (`ollama pull …`, `dasha-compute restart`, …), never "see the docs".

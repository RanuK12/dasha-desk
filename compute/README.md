# Dasha Compute · open alpha

**Live Start.:** [Ask / Provide](../docs/COMPUTE.md). This directory is the community **open-alpha kit**, not the Worker.

**[Live product](https://www.getdasha.com/compute)** ·
**[Project index](https://uuriko.github.io/dasha-desk/compute/)** ·
**[Source map](SOURCE_MAP.md)** ·
**[Download source](https://www.getdasha.com/dasha-compute-open-alpha.tar.gz)**

An independently written, local-first proof of concept for routing OpenAI-shaped chat requests to community-run model providers. It is designed to become the compute surface at `getdasha.com/compute` without copying Darkbloom code, branding, prose or private protocols.

Version 0.3 supports both a local coordinator and the live getdasha.com community queue. It has real request routing, streaming and end-to-end tests. The live queue stores short-lived jobs in a Durable Object and adds account-bound registration, hashed revocable credentials, rate limits, and complete or SSE-streamed responses. Neither mode has billing, hardware attestation or operator-blind prompts. Do not send secrets. See `THREAT_MODEL.md`.

Pick **one** path. You do not need the other two first.

## 1. Use live (no clone)

Open [https://www.getdasha.com/compute](https://www.getdasha.com/compute). Cold start is **Start.** Primary **Ask** / **Provide**. Quiet **Pay** / **Credits** (USDC or `$dasha`, no card). Gate **Sign in** / **You**. After Ask, Hosted; enter a prompt, **Run**.

**Provide** is the Mac kit on the same page: **Prefer MLX when you can · Ollama ≥0.33.1 · models on internal SSD.** Marketplace / Host stay quieter: [`/compute/ocm`](https://www.getdasha.com/compute/ocm) and [`/compute/ocm/provider`](https://www.getdasha.com/compute/ocm/provider). `ocm/` is on `main` via [#76](https://github.com/Uuriko/dasha-desk/pull/76) + [#131](https://github.com/Uuriko/dasha-desk/pull/131). Do not merge raw [#44](https://github.com/Uuriko/dasha-desk/pull/44).

Power users: create a developer key in the **Build** tab, then use `https://lobby.getdasha.com/compute/api/v1` as the OpenAI base URL (same base already documented below). Do not invent endpoints. Do not wrangler-deploy from this repo.

## 2. Join as a community Mac (Provide)

Download the kit from [`dasha-compute-open-alpha.tar.gz`](https://www.getdasha.com/dasha-compute-open-alpha.tar.gz). Log in at `https://www.getdasha.com/compute`, open **Provide**, size your Mac, and choose **Register this Mac**. The page returns a one-time provider token. Dasha stores only the token hash; live provider tokens and developer keys are account-bound and owner-revocable. The live queue supports complete and SSE-streamed responses. Ordinary queued and leased prompts are stored in the Durable Object until completion, failure, cancellation or expiry; terminal paths clear or delete prompt text, while completed answers, errors or chunks receive a ten-minute expiry and are removed by a subsequent prune. Night Shift retains its assignment prompt and up to five artifacts until the task is deleted.

This is open alpha. Prompts assigned to this Mac are visible to the operator. Do not send secrets.

On macOS, use the hidden-input prompt below to save that token to a private 0600 file, then run `./install.sh`. Paste the token only at the prompt; it is not part of a shell command or here-document. The installer verifies the complete connection, stores the token in Keychain, deletes the file, installs a persistent `launchd` service, and adds `~/bin/dasha-compute`. The launchd job does not receive the token on `ProgramArguments`.

```bash
python3 provider/save-provider-key.py
DASHA_PROVIDER_ID=your-provider-id \
DASHA_MODEL_MAP=qwen3-8b=qwen3:8b \
./install.sh
```

`./install.sh --help` prints the same handoff. The prompt refuses an existing file or a terminal that cannot hide input. `DASHA_PROVIDER_KEY_FILE` overrides the default `.dasha-provider-key` path for both the prompt and installer; set it consistently. The file stays available if validation, connection checks, or the Keychain write fail. The one-time macOS Keychain write still passes the token to `security -w`; this change does not remove that existing process-argument limitation. Manage the service with:

```bash
dasha-compute status
dasha-compute doctor
dasha-compute benchmark
dasha-compute logs
dasha-compute restart
dasha-compute uninstall
```

## 3. Run the local coordinator

Local-only. The bundled coordinator binds to `127.0.0.1` by default. Default keys are not for the internet. Never expose them. Put the process behind a real HTTPS reverse proxy before any remote test.

It works as follows:

1. a client submits `POST /v1/chat/completions`;
2. the coordinator holds the job in volatile memory;
3. a provider polls outbound over HTTPS;
4. the provider calls its local Ollama model;
5. the result returns as a complete OpenAI-shaped response or streamed SSE chunks.

`console/` also includes the full React/CSS interface and the deliberately unavailable hosted-alpha routes, so the public artifact contains both sides of the product rather than only the daemon code.

Prerequisites: Node 20+, Python 3.10+, and [Ollama](https://ollama.com/) on the provider machine.

```bash
curl -fLO https://www.getdasha.com/dasha-compute-open-alpha.tar.gz
tar -xzf dasha-compute-open-alpha.tar.gz
cd dasha-compute-open-alpha

# terminal 1 · coordinator
DASHA_API_KEY=consumer-secret \
DASHA_PROVIDER_KEY=provider-secret \
npm start

# terminal 2 · provider
ollama pull qwen3:8b
DASHA_PROVIDER_KEY=provider-secret \
DASHA_MODEL_MAP=qwen3-8b=qwen3:8b \
python3 provider/agent.py

# terminal 3 · client
DASHA_API_KEY=consumer-secret python3 examples/chat.py
```

Before joining a test, check the complete local chain:

```bash
python3 provider/agent.py --doctor
```

The doctor exits nonzero when the coordinator, Ollama, or any configured model is unavailable. It also fails when Ollama is below the version floor (≥0.33.1, pinned in `compute/README.md`), when the Ollama port answers as a non-Ollama service, when free disk cannot cover the missing model pulls (1.5× headroom), or when the coordinator rejects the provider token (with a re-register hint — the token itself is never printed). It fails on non-macOS systems (Intel Macs get a warning instead — inference will be slow) and on Python < 3.10; coordinator connection failures are classified into TLS / refused / timeout lines instead of raw tracebacks; and post-install it fails when the LaunchAgent is not bootstrapped, install files are missing, or the Keychain token is unreadable. It warns, without failing, when a mapped model needs more unified memory than the Mac has, when the Ollama version is unreadable, when the coordinator round trip exceeds 2s, when benchmark.json is older than 30 days, or when MLX is unavailable. The MLX line is informational so the funnel can measure MLX-capable supply share. `python3 provider/agent.py --doctor --json` emits the machine-readable check list for the installer and funnel analytics.

Measure actual model throughput with `python3 provider/agent.py --benchmark`. Set `DASHA_BENCHMARK_TOKENS` between 16 and 256 to trade speed for a longer calibrated run.

### OpenRouter lane (external integrations)

The coordinator exposes a dedicated lane for the OpenRouter provider listing so external traffic never shares the local consumer's key or queue semantics:

- `GET /v1/models` serves the OpenRouter provider document: namespaced `dasha/<model>` ids, `openrouter.slug`, text input/output modality entries with `max_context_length` and declared `temperature`/`max_tokens`/`stream` parameters, `streaming: true`, and `is_free: true` (pricing omitted on the free launch). No datacenters or zero-data-retention claims are made.
- `DASHA_OPENROUTER_KEY` is a separate credential. Unset disables the lane; it must never reuse a consumer or provider key.
- OpenRouter calls authenticate to that key and get a dedicated token bucket (`OPENROUTER_RATE_LIMIT_RPM`, `OPENROUTER_RATE_LIMIT_BURST`) and a short queue window (`OPENROUTER_QUEUE_TIMEOUT_MS`). Under load or when no provider is online the lane fails with `429` + `Retry-After` — OpenRouter excludes 429 from uptime scoring, while 5xx would count against it. Local consumers keep the existing 503 behavior.
- `POST /v1/chat/completions` accepts `dasha/<model>` ids (bare ids still work) and echoes the requested id back; streams emit `: keep-alive` comments (every `OPENROUTER_KEEPALIVE_MS`, default 10s) so long provider work is not cancelled as stalled. Streamed usage is always returned in the final chunk: provider-reported tokens when available, otherwise a chars/4 estimate — complete responses flag estimates with `X-Dasha-Usage-Estimated: true`, never silent zeros.
- `OPENROUTER_IS_FREE=false` flips the document to `is_free: false`, which OpenRouter uses to stage the paid conversion.

This lane is a reference implementation for the live `lobby.getdasha.com` gateway: it is not deployed and does not go live by merging.

## Verify or build the source archive

The repository builds the download from an explicit source allowlist. Every archive
uses normalized paths, ownership, modes and timestamps; contains a
`SOURCE-MANIFEST.sha256` for its extracted files; and ships beside an external archive
checksum and deterministic `release.json`.

```bash
npm run release:build
(cd dist && shasum -a 256 -c dasha-compute-open-alpha.tar.gz.sha256)
tar -tzf dist/dasha-compute-open-alpha.tar.gz
```

Main-branch builds are also linked to GitHub build provenance. After downloading the
tarball from the **Compute release** workflow, verify that provenance with:

```bash
gh attestation verify dasha-compute-open-alpha.tar.gz --repo Uuriko/dasha-desk
```

Provenance connects bytes to a repository workflow and commit; it does not prove that
the software is secure. Review this source, `SECURITY.md`, and `THREAT_MODEL.md` before
running an alpha provider.

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/healthz` | Process health |
| `GET` | `/v1/models` | OpenAI-shaped model list |
| `GET` | `/v1/network` | Aggregate provider and job counts |
| `POST` | `/v1/chat/completions` | Complete or SSE-streamed chat completion |
| `POST` | `/v1/providers/poll` | Provider heartbeat and job lease |
| `POST` | `/v1/providers/jobs/:id/result` | Provider result |
| `POST` | `/v1/providers/jobs/:id/chunk` | Provider stream delta or completion |

The live `https://lobby.getdasha.com/compute/api` queue also renews active leases at `POST /providers/jobs/:id/heartbeat`; cancellation clears the queued prompt immediately and is returned by that heartbeat.

## Live OpenAI-compatible API

Create a developer key in the **Build** tab at `https://www.getdasha.com/compute`, then use `https://lobby.getdasha.com/compute/api/v1` as the OpenAI base URL. The live gateway supports model discovery plus complete and SSE-streamed chat completions through online community providers.

```bash
curl https://lobby.getdasha.com/compute/api/v1/chat/completions \
  -H "Authorization: Bearer $DASHA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-8b","messages":[{"role":"user","content":"hello"}]}'
```

## Deliberate differences

- The protocol is small, original and documented by the code itself.
- Providers poll with ordinary HTTPS so the first version is deployable almost anywhere.
- There is no claim that provider operators cannot inspect prompts.
- `$dasha` is not required for use or payment. A holder badge, queue access and community recognition can be layered on later without making a volatile token the accounting unit.
- Self-hosting and self-routing remain free.

## Local coordinator production path

The live queue already uses durable storage, hashed account-bound credentials and basic quotas. For the bundled dependency-free local coordinator:

1. Replace in-memory maps with Postgres and a durable queue.
2. Add per-user API-key hashing, quotas, idempotency and abuse controls.
3. Add hard Ollama request aborts and stream backpressure limits.
4. Sign model manifests and provider releases; publish reproducible build instructions.
5. Encrypt queued payloads to provider keys and extend this threat model for that design.
6. Commission a security review before any stronger privacy claim.
7. Add USDC/USD metering and compliant payouts only after demand exists.

## Test

```bash
npm test
```

The tests start isolated coordinators, simulate providers, verify both complete responses and OpenAI-compatible SSE chunks through `[DONE]`, and prove that two clean release builds have identical bytes and complete source manifests.

## License

MIT. Model weights keep their own licenses. The `$dasha` name and cultural references are not a grant of rights in any third-party person, likeness or brand.

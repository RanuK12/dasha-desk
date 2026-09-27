# OCM — Open-Compute Marketplace

OCM is a working open-source alpha for routing OpenAI-compatible inference to independently operated compute. Apple Silicon with MLX is the first provider class; the gateway and provider contract are intended to admit other runtimes without changing the client API.

The original contribution is Graham's [`#44`](https://github.com/Uuriko/dasha-desk/pull/44). It landed on `main` through [`#76`](https://github.com/Uuriko/dasha-desk/pull/76) and its follow-on [`#131`](https://github.com/Uuriko/dasha-desk/pull/131). **Do not merge #44** — it was closed, not merged. OCM is **not production-ready, payment-safe, or confidential from community providers**.

## Current proof — August 2026

The current implementation includes:

- an OpenAI-compatible `/v1/models` and `/v1/chat/completions` gateway;
- complete and SSE-streamed responses through `[DONE]`;
- provider registration over a persistent outbound WebSocket;
- model and hardware capability discovery;
- warm-aware routing, cancellation, and failover before client commitment;
- gateway-side usage measurement and append-only JSONL/Postgres ledgers;
- account-bound, revocable developer keys and provider tokens;
- a server-rendered consumer/provider console;
- a launchd installer and diagnostics for Mac providers;
- an automated socket, routing, credential, console, installer, and secret-hygiene test suite.

The full path has been exercised on a real Apple M4 running MLX, including a request from the unmodified OpenAI Python SDK. Headless Metal inference was also validated on an EC2 Mac M4 host. A tested 7B-class coder model decoded in the mid-20 tokens/second range on that setup; this is one hardware/model result, not a network-wide performance promise.

## Remaining unknowns and hard gates

Before external provider traffic or money:

- provider credentials must never appear in WebSocket URLs or proxy logs;
- usage clearing must remain at-most-once under duplicate, racing, and ambiguous terminal events;
- accounting fails closed after a committed-response write failure (a 503, or an SSE `error` event with no `[DONE]`, and `/healthz` names the job until a restart) and concurrent requests cannot overdraw one balance; durable recovery without a restart is still open;
- approximate character-based metering must be replaced before billing by model-specific tokens;
- provider/runtime/model identities need immutable provenance;
- residential connection stability, update recovery, and multi-host reliability need a real pilot;
- community providers receive raw prompts and can inspect them;
- provider payouts, refunds, disputes, tax/compliance, and production Solana settlement are not implemented;
- green CI and a fresh reproducible M4 run are required at the reviewed commit.

Do not describe granted alpha credits as money, revenue, provider earnings, or on-chain settlement.

## Maintainer merge gates (human-only)

`#76` and `#131` are on `main`. `#44` was closed, not merged. Do not merge `#44`.

Repository CI on this tree is the code-review gate. The remaining steps are human-only and are not claimed by CI:

1. Inspect ALB/proxy access logs and rotate any provider credential that was previously sent in a WebSocket URL.
2. A fresh M4/MLX `--doctor`, benchmark, and unmodified OpenAI SDK request from the reviewed commit, using [`scripts/verify-m4.sh`](scripts/verify-m4.sh). Load credentials from a hidden prompt or `*_FILE`; do not put them on the command line. This repository does not invent that hardware proof.
3. Confirm deployed agent/gateway versions match the reviewed commit before inviting external providers.
4. No production deploy, provider payout, or Solana settlement from this stack. Granted alpha credits are not money.

## Architecture

```text
OpenAI client
    |
    v
OCM gateway  ---- append-only usage ledger
    |
    | job / chunk / done over a persistent provider socket
    v
outbound-only provider agent
    |
    +-- MLX on Apple Silicon
    +-- Ollama for local development / alternate runtime
    +-- later optional provider adapters
```

Providers initiate the connection and never need an inbound public port. The gateway selects a currently eligible host, streams output, cancels abandoned work, and retries another host only before bytes have been committed to the client. Gateway measurement is authoritative; provider-reported token counts are not trusted.

## Local core loop

Requirements: Node 22+, Python 3.11+, and `uv`. Use Ollama for a hardware-independent local run, or MLX on Apple Silicon.

```bash
# terminal 1 — gateway
OCM_HOST_TOKEN=dev-host \
OCM_API_KEY=ocm_dev \
node ocm/gateway/server.mjs

# terminal 2 — provider using Ollama
OCM_RUNTIME=ollama \
OCM_HOST_TOKEN=dev-host \
OCM_MODEL_MAP="ocm-coder=codellama:latest" \
uv run ocm/agent/agent.py

# terminal 3 — an ordinary OpenAI-compatible client
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=ocm_dev
```

On Apple Silicon, the default MLX model is `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit`. The public client alias is `ocm-coder`; pin a deliberate `OCM_MODEL_MAP` in reproducible deployments rather than allowing one alias to drift across materially different model builds.

```bash
uv run ocm/agent/agent.py --doctor
uv run ocm/agent/agent.py --benchmark
cd ocm && npm test
```

## Layout

```text
ocm/
  gateway/     HTTP/WebSocket gateway, routing, accounts, console, ledgers
  agent/       outbound provider agent and launchd installer
  tests/       end-to-end, regression, and secret-hygiene tests
  scripts/     preflight and operational helpers
  docs/        architecture, benchmarks, deployment, and decisions
```

## Trust and privacy boundary

- A community provider receives the raw request needed to run inference.
- OCM does not provide confidential compute or hardware attestation.
- The gateway should not log prompts or completions by default.
- Provider and developer credentials belong in Authorization headers and secret storage, never URLs, repositories, screenshots, or public metadata.
- The console, public network view, and logs must not expose account identities or provider credentials.
- A separate local-only mode is required for a stronger user-owned privacy boundary.

## Relationship to the rest of this repository

`ocm/` is isolated from the live `$DASHA` website and from `compute/`:

- it has its own package and workflow;
- it does not change `watch.mjs`, the getdasha.com Worker, mint identity, custody, or transaction-signing behavior;
- it does not use `$DASHA` as provider compensation;
- OCM and `$DASHA/getdasha.com` are separate projects.

`compute/` remains an earlier open-alpha experiment. See [`docs/OVERLAP.md`](docs/OVERLAP.md) for the measured reuse boundary rather than assuming the two systems are interchangeable.

## Start here

1. [`docs/PROVIDER-PROTOCOL.md`](docs/PROVIDER-PROTOCOL.md) — published wire contract and 12-point conformance gate
2. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
3. [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)
4. [`docs/OVERLAP.md`](docs/OVERLAP.md)
5. [`docs/AWS-ACCOUNT.md`](docs/AWS-ACCOUNT.md)

Never commit deployment credentials or private operational identifiers to this public repository.

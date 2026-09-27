# OCM provider protocol v0

Status: reviewable alpha contract, not a payment or confidentiality guarantee.

This document is the smallest interoperability contract for connecting an independently operated inference runtime to OCM. It describes the behavior implemented by the current gateway and host agent. It intentionally does not prescribe Apple Silicon, MLX, Nosana, a particular model server, or a payout rail.

## Trust boundary

A provider receives the raw chat messages needed to run inference. The current protocol does not provide confidential compute, hardware attestation, proof of model weights, or proof that the provider discarded a request. Consumers must be told this before sending sensitive material.

The gateway is authoritative for routing, client commitment, cancellation, and usage accounting. A provider-supplied usage claim is never authoritative.

## Connection

A provider opens one persistent **outbound** WebSocket:

```text
wss://<gateway>/host/connect
Authorization: Bearer ocm_host_...
```

Provider credentials must not appear in the URL, query string, user agent, public logs, screenshots, model metadata, or repository. The gateway keeps a loopback-only query-token compatibility path for old local tests; it is not a production integration route.

The provider needs outbound HTTPS/WSS only. It does not need a public inbound port.

### Reconnection

Disconnects are normal. A provider should reconnect with exponential backoff and jitter and reuse the same stable agent ID. Reusing the ID replaces the stale socket; changing it creates a separate provider identity.

The current reference agent sends WebSocket pings every 20 seconds. The gateway considers a provider stale after 90 seconds without activity or pong evidence.

## Messages

All application messages are UTF-8 JSON objects with a string `t` discriminator.

### Provider → gateway: `hello`

Sent immediately after the socket opens.

```json
{
  "t": "hello",
  "agent": {
    "id": "stable-provider-id",
    "runtime": "mlx",
    "models": ["ocm-coder"],
    "chip": "Apple M4",
    "arch": "arm64",
    "memory_gb": 24,
    "region": "us-west",
    "ready": false
  }
}
```

Required in the current alpha:

- `agent.id`: stable, non-secret provider identifier.
- `agent.models`: non-empty list of model names the provider can actually serve.

The remaining fields are capability metadata. Do not put personal information, credentials, exact residential location, or private infrastructure identifiers in them.

`agent.ready` is optional and, when present, must be a boolean: whether the first advertised model (the primary) is resident in memory right now. An agent that predates the field sends nothing and the gateway records unknown. The gateway ranks a ready host with a warm one for routing; it is the provider's claim and never moves billing or timeouts.

A provider must advertise only models that are loaded or loadable under its declared runtime policy. Public aliases are resolved by the gateway, but the job sent to the provider uses a name that provider advertised.

### Gateway → provider: `welcome`

```json
{
  "t": "welcome",
  "host_id": "stable-provider-id",
  "heartbeat_ms": 30000
}
```

The provider is eligible for routing only after this message.

### Gateway → provider: `job`

```json
{
  "t": "job",
  "id": "uuid",
  "model": "provider-advertised-model",
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

`id` is the job and accounting idempotency key. Treat it as opaque. The provider must not reuse it for another request.

The current alpha forwards the OpenAI-style `messages` array and a model name. Unsupported request fields must not be silently invented. A future protocol version may add explicit sampling controls and model-manifest references.

### Provider → gateway: `status`

```json
{
  "t": "status",
  "ready": true
}
```

Sent after `hello` whenever residency of the primary model changes: it was loaded (a preload, or a job served), or it was displaced. The only field is `ready`, a boolean; anything else on the frame is dropped, and a non-boolean closes the socket.

### Provider → gateway: `chunk`

```json
{
  "t": "chunk",
  "id": "uuid",
  "delta": "partial text"
}
```

Each non-empty delta is appended in order. The first delivered delta is evidence that the provider has begun producing output for the exact wire model. Empty deltas should not be sent.

### Provider → gateway: `done`

```json
{
  "t": "done",
  "id": "uuid"
}
```

Send exactly one terminal message per job. A provider may include diagnostic usage metadata for observability, but the gateway does not trust it for debit or provider credit.

### Provider → gateway: `error`

```json
{
  "t": "error",
  "id": "uuid",
  "message": "runtime unavailable"
}
```

Use `error` when the runtime cannot complete the job. Do not include prompts, completions, credentials, stack dumps containing secrets, or private infrastructure details in `message`.

If the provider fails before any client-visible output, the gateway may retry another provider. Once bytes have been committed to a streaming client, OCM does not replay the request elsewhere.

### Gateway → provider: `cancel`

```json
{
  "t": "cancel",
  "id": "uuid"
}
```

Cancellation is best effort but must stop generation promptly. It can result from a client disconnect, timeout, shutdown, or superseding lifecycle event. After cancellation, the provider must stop sending chunks and must not start a new job under the same ID.

The provider answers a cancel with one terminal frame, `error` with `message: "cancelled"`, as soon as the cancel lands (during a cold model load too), then keeps serving. The gateway has already freed the host's routing slot when it sent the cancel, so the terminal is not what unblocks routing; it is what distinguishes "stopped promptly" from "never heard back" in both logs. A late terminal for a job the gateway no longer tracks is dropped without touching the slot count or the ledger.

## Terminal and accounting semantics

For each gateway dispatch, one application path owns the transition:

```text
open → settling → settled
```

The first terminal, timeout, or client-close path to claim `settling` owns response finalization and any usage clear. Late `done`, `error`, disconnect, and close events are ignored.

The ledgers independently enforce at-most-once clearing by `jobId`:

- identical repeats return the existing usage row;
- the same ID with different consumer, provider, model, prompt count, or completion count is an idempotency conflict;
- duplicate or conflicting persisted JSONL rows make accounting unhealthy at startup;
- a write or database failure disables subsequent accounting operations until an operator repairs and restarts the service.

The current gateway uses an approximate character-based token count. That is acceptable for granted alpha credits only. Real-money billing requires an immutable model/runtime manifest and the exact tokenizer for that manifest.

## Generic container provider shape

A non-MLX provider can use the same contract with two local processes inside one long-running workload:

```text
model server on localhost
        ↑
provider adapter / OCM agent
        |
        └── outbound WSS to OCM gateway
```

The workload should provide:

- a stable `OCM_AGENT_ID` across restarts;
- a deliberate public-to-local model map;
- outbound DNS, HTTPS, and WSS;
- a readiness check that proves the local model server can answer before advertising it;
- graceful cancellation and process termination;
- bounded local queueing;
- no prompt/completion logging by default;
- a reproducible image digest and model-manifest digest;
- restart behavior that does not register duplicate provider identities.

The model server may be MLX, Ollama, vLLM, or another runtime. Runtime-specific adapters remain responsible for translating its stream into ordered `chunk`, one `done`, or one `error`.

## Conformance gate

A provider integration is not ready for external traffic until it passes all of the following against the reviewed gateway commit:

1. **Header-auth connection:** joins using an `Authorization` header; no credential appears in the requested URL or access log.
2. **Truthful catalogue:** advertises only an actually serviceable model and receives jobs under a name it understands.
3. **Complete response:** returns a valid non-streamed OpenAI-compatible completion through the gateway.
4. **Streaming response:** emits ordered deltas and exactly one terminal event through `[DONE]`.
5. **Cancellation:** stops generation promptly after `cancel`, answers with exactly one `error: cancelled` terminal, and emits no later completion (`tests/cancel.test.mjs`, `tests/agent-smoke.py`).
6. **Reconnect:** reconnects under the same agent ID without the stale socket deregistering the live replacement.
7. **Pre-token failure:** an error/drop before output receives no provider credit and can be retried elsewhere.
8. **Mid-stream failure:** only output already committed to the client is eligible for alpha accounting; the request is not replayed.
9. **Terminal race:** `done → error → done`, duplicate done, socket close, and client-close races create at most one usage row.
10. **Accounting outage:** after an ambiguous ledger/database failure, new work is refused rather than served without records.
11. **Privacy disclosure:** operators and consumers are told that providers receive plaintext prompts.
12. **Soak run:** multi-hour connection, reconnect, cancellation, and sustained-load evidence is captured without credentials or user data.

## Evidence to record

For each conformance run, record only non-secret evidence:

- gateway commit and provider image digest;
- runtime, immutable model identifier, quantization, tokenizer, and model digest where available;
- provider hardware class and coarse region;
- cold-start time, TTFT, decode throughput, request completion rate, reconnect count, cancellation latency, and sustained-load duration;
- pass/fail result for each gate above;
- known deviations and the exact commit that resolves them.

Never publish provider tokens, developer keys, database URLs, private hostnames, residential IP addresses, raw prompts, raw completions, or user email addresses.

## Versioning

This is protocol `v0`: it documents the currently implemented alpha and may change before public provider onboarding. Any future wire-incompatible change must add an explicit protocol version to `hello` and reject unsupported versions clearly rather than guessing compatibility.

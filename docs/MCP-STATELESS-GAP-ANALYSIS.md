# MCP 2026-07-28 stateless-upgrade gap analysis — Dasha Compute MCP server (task #15)

**Dated:** 2026-09-17. **Status:** ANALYSIS ONLY — no code changes, no deploys, nothing here touches the live Worker.

**Scope boundary (read first).** The MCP server implementation lives in the Worker tree, which is **not cloned in this repo** — dasha-desk contains the coordinator kit (`compute/`), the OCM stack (`ocm/`), and docs only. Every gap below is therefore assessed against (a) the published 2026-07-28 spec changelog, verified from real-world migration notes (see "Revision summary"), and (b) the MCP Server Card draft + registry dossier from PR #220 (task #16/#20). The live server's *current* wire behavior was **not probed** for this analysis — probing the live endpoint and changing the Worker are tasks #47/#48 (JOHN). Several gaps are consequently written as "verify, then fix" rather than "confirmed broken."

**Related:** TASKS.md #15 (this brief) · #16/#20 (card + dossier, PR #220) · #17 (tool naming audit) · #18 (NSA/CISA hardening) · #24 (gateway metering, PR #219) · #47/#48 (serve card / implement upgrade — JOHN) · TASKS.md #9/#32 (MLX lane PR #216, tarball inventory PR #217).

## Revision summary (2026-07-28, "stateless core" — verified from spec/migration notes)

- **Protocol sessions removed (SEP-2567).** No `Mcp-Session-Id` minted or accepted; no `initialize`/`initialized` handshake. Every request is self-contained, carrying protocol version, client info, and capabilities in a per-request `_meta` envelope.
- **Streamable HTTP only.** GET/DELETE on the endpoint change meaning: GET no longer opens an SSE stream (servers answer `405`); DELETE is a no-op that answers `200` — there is no session left to terminate.
- **Mandatory per-request headers** on 2026-07-28 requests: `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` on name-carrying methods (`tools/call`, `prompts/get`, `resources/read`), validated against the body. New error codes: `-32602` (missing `_meta`), `-32020` (header/body mismatch), `-32022` (unsupported protocol version); the spec reserves `-32020`..`-32099` for itself.
- **Error↔HTTP-status mapping rebuilt.** Unknown method → HTTP 404 with `-32601`; protocol/validation errors → 400s; internal `-32603` stays at HTTP 200; the real auth signal is 401 + `WWW-Authenticate`; the old private auth codes (`-32001`/`-32003`/`-32004`) are gone.
- **`server/discover` RPC is mandatory** — advertises supported protocol versions, capabilities, and self-reported server metadata, with `ttlMs`/`cacheScope` caching hints.
- **SSE resumability removed.** A broken stream is re-issued by the client with a **new request id**; tools are expected to be idempotent.
- **SDK v1 → v2.** Scoped packages (`@modelcontextprotocol/*`); the old `server.tool()` / `setRequestHandler` forms are gone; tool argument schemas are now **strictly validated** (`additionalProperties: false` — unknown keys error instead of being stripped); an **unknown tool name is a JSON-RPC error (`-32602`)**, not an `isError` tool result.
- **Old experimental Tasks API removed.** Long-running work moves to the tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663) with client-driven polling (`tasks/get|update|cancel`), not server push.
- **Deprecation runway (~mid-2027):** Roots, Sampling, Logging (logging moves off the wire entirely — SEP-2577); tighter OAuth 2.1 / OIDC alignment.
- **Tool `title`** is now advertised alongside `name` (human-readable display name for connector UIs).
- **Backwards compatibility is opt-in per server:** a 2026-07-28 server can negotiate legacy revisions (e.g. 2025-11-25) on the same endpoint, or go stateless-only — legacy clients break in the stateless-only case.

---

## The gaps

Format per gap: description → **severity** → fix sketch → **⛔ registry promise gate** (what the official registry / Server Card must NOT claim until the gap is closed).

### GAP-1 — Session handshake removal: live server may still be session-based (UNVERIFIED)

The revision deletes the entire session layer. If the live Dasha Worker MCP server still mints `Mcp-Session-Id`, requires `initialize` before use, or keys any per-client state to a session, every 2026-07-28 client will fail against it — and a naive "stateless-only" cutover will equally break every legacy client (see GAP-8). The card draft already declares `"protocol": {"versions": ["2026-07-28"], "stateless": true}`; the dossier's gap #5 flagged the same uncertainty. Nothing in this repo can confirm which wire the live endpoint speaks.

**Severity: HIGH**

**Fix sketch.** Migrate the Worker MCP handler to SDK v2; delete session issuance/storage; answer `initialize` (or any pre-2026-07-28 method) with `-32601` on HTTP 404 naming the supported version; GET on the endpoint → `405`; DELETE → `200` no-op; read identity from the per-request `_meta` envelope. Probe the live endpoint before and after with a stateless client to confirm both directions.

**⛔ Registry promise gate.** Do NOT publish the card's `protocol.versions: ["2026-07-28"]` / `stateless: true`, or the registry `remotes` entry, until a live stateless wire probe passes (no `Mcp-Session-Id` minted, no `initialize` required). Publishing the version claim against a session-based server is a false protocol advertisement that registry verifiers and clients will trip over.

### GAP-2 — Per-request routing headers must survive the Cloudflare edge

2026-07-28 clients send `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` on every request, and the server validates them against the body (mismatch → `-32020`). The Dasha endpoint runs on Cloudflare Workers; any edge middleware that strips, lowercases-to-loss, or filters unknown headers will hard-break every modern client with opaque `-32020`/`-32602` failures. This is an infrastructure interaction, not application code, and it is unverified from here.

**Severity: HIGH**

**Fix sketch.** At the Worker edge, explicitly allowlist-pass `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (plus auth headers) before any normalization; validate body↔header agreement in the handler; return the spec error codes on mismatch; add a smoke test that sends a 2026-07-28 `tools/call` through the *real* edge (not a local harness) and asserts the headers arrive intact.

**⛔ Registry promise gate.** Do NOT claim 2026-07-28 support in the registry until an end-to-end probe through the production edge confirms the headers survive. A registry entry that advertises a version the edge silently mangles is worse than no entry — it burns agent trust on first contact.

### GAP-3 — Billed tools are not idempotent under stateless re-issue (highest severity)

The revision removed SSE resumability: when a stream breaks, **the client re-issues the request with a new request id**, and tools are expected to be idempotent. Dasha tools trigger *billed* work — provider Macs run inference, the free tier burns quota, paid tiers burn credits. A re-issued `tools/call` that the server treats as a fresh request can: (a) double-charge the caller, (b) double-burn free-tier quota, (c) mint a duplicate provider job that pays out twice, and (d) record duplicate gateway usage. The request id itself **cannot** be the dedupe key — it is new on every re-issue by design. This interacts directly with PR #219 (gateway-side metering): the canonical usage record needs a dedupe-safe job identity, not just measured bytes.

**Severity: CRITICAL**

**Fix sketch.** Accept a client-supplied idempotency key (tool argument or `_meta` field — decide one and document it); maintain a server-side dedupe cache keyed on `(auth subject, tool name, idempotency key)` with a TTL longer than the longest expected job; on a repeat key, return the original result (or its task handle — see GAP-9) instead of dispatching a new provider job; wire the key into the gateway-metering canonical record (task #24) so usage never double-counts. Also: never mint two provider payouts against one key.

**⛔ Registry promise gate.** Do NOT advertise the tools as safe-to-call / billable until idempotency is live and the dedupe path is load-tested. Promising a paid inference API over a protocol that explicitly re-issues broken requests, without idempotency, is a double-billing hazard by design.

### GAP-4 — Session-bound quota/auth attribution has no carrier anymore

Any free-tier gating or per-client quota state that was keyed on the protocol session id is broken by construction under 2026-07-28: there is no session id to key on. The authenticated subject must be re-derived from the bearer's token on **every** request and quota counters keyed on `(subject, tool)` per request. (One real-world migration hit exactly this: a session-subject-binding guard became dead code, and per-subject quota attribution had to be rebuilt from the bearer per call.) Dasha's free-tier-for-low-volume model makes this load-bearing: unenforced quota is a cost leak; mis-attributed quota is a fairness and billing bug.

**Severity: HIGH**

**Fix sketch.** Derive the auth subject from the request's credentials on every call (never from stored session state); key rate-limit and quota counters on the derived subject; fail closed when the subject cannot be derived; delete the session-subject binding code rather than leaving it as a no-op that confuses future readers.

**⛔ Registry promise gate.** Do NOT describe the free tier / quota / auth model in the registry or card (`authentication` block) until per-request attribution is verified on the live server. Vague-but-wrong auth copy is a trust liability — see the card hygiene rules in PR #220.

### GAP-5 — Custom error codes may sit in the spec-reserved `-32020..-32099` range

The revision reserves `-32020`..`-32099` for the spec itself (one production migration had to move its rate-limit code out of the range). If the Worker MCP handler uses any custom `-320xx` codes — for quota, billing, or provider errors — they must be renumbered outside the reserved block. Related: unknown method is now HTTP 404 (not 200-with-error), and the auth signal is 401 + `WWW-Authenticate`, not a private JSON-RPC code. Any client-side retry logic keyed on the old statuses/codes needs updating.

**Severity: MEDIUM**

**Fix sketch.** Audit every error the MCP handler can emit; renumber custom codes out of the reserved range; align HTTP statuses to the spec table (404/`-32601` unknown method, 401+`WWW-Authenticate` for auth, 200 for `-32603`); document the resulting error contract in one place so client integrators don't rediscover it by trial.

**⛔ Registry promise gate.** Do NOT document error behavior in any registry metadata until the audit is done. (Low blast radius: keep error detail out of the registry entirely — the registry needs transport/auth facts, not an error catalog.)

### GAP-6 — Mandatory `server/discover` is presumably unimplemented

The card draft (PR #220) states that servers MUST implement `server/discover`, and the dossier's submission checklist requires a live `server/discover` probe — but there is no evidence in this repo that the live server implements it, and it cannot be verified from here. A 2026-07-28 client that opens with `server/discover` and gets `-32601`/404 will treat the server as non-conformant.

**Severity: HIGH**

**Fix sketch.** Implement `server/discover` returning supported protocol versions, capabilities (tools: true; resources/prompts: false per the card), and server metadata; include `ttlMs`/`cacheScope` caching hints so clients don't re-discover on every request; keep the response consistent with the static Server Card (same versions, same capabilities).

**⛔ Registry promise gate.** Do NOT claim `2026-07-28` conformance in the registry or card until `server/discover` answers on the live endpoint. "Claims the version but fails its mandatory discovery RPC" is the fastest way to get the listing flagged.

### GAP-7 — SDK v1→v2 migration: strict schemas and unknown-tool semantics

The v2 SDK strictly validates tool arguments (`additionalProperties: false`) — clients that passed extra keys and were silently tolerated will now get input-validation errors; and an unknown tool name returns JSON-RPC `-32602` instead of an `isError` tool result, so any client code that detected "unknown tool" via `result.isError` breaks. The Worker tree's SDK generation is unverified from here.

**Severity: MEDIUM**

**Fix sketch.** Migrate the Worker MCP code to the v2 SDK (`@modelcontextprotocol/*` scoped packages); replace `server.tool()`/`setRequestHandler` with `registerTool`; audit advertised schemas for keys clients actually send (decide: widen the schema or intentionally break); update any client integrations that read `isError` for unknown tools.

**⛔ Registry promise gate.** No registry field is blocked by this one beyond the general conformance gates (GAP-1/6) — but do not list example tool calls anywhere public until the strict-schema audit is done, or the examples will be wrong.

### GAP-8 — Backwards-compatibility posture is undecided (and the draft card picks a side)

The PR #220 card advertises **only** `"versions": ["2026-07-28"]`. That is a stateless-only promise. Every legacy client — Claude Desktop-era connectors, anything on SDK v1 / 2025-11-25 or earlier — that cannot speak the new wire will break against this server. The alternative (negotiate legacy revisions on the same endpoint, which the v2 SDK supports) keeps old clients working but widens the test matrix. This is a product decision with no default, and the card has already pre-decided it without the decision being made.

**Severity: HIGH**

**Fix sketch.** Make the call explicitly: recommended = serve both eras on one endpoint (negotiate down for legacy `_meta`-less requests; legacy clients are unaffected by the new headers — one production migration confirmed header requirements apply only to modern-envelope requests), with a sunset date for the legacy wire. Only then finalize the card's `protocol.versions` array and test with at least one real legacy client.

**⛔ Registry promise gate.** Do NOT publish `protocol.versions` in the card or registry until the legacy posture is decided and tested. Publishing `["2026-07-28"]`-only and then quietly accepting legacy traffic (or vice versa) is exactly the kind of metadata drift the card hygiene rules warn against.

### GAP-9 — Long-running jobs: old Tasks API is gone, push notifications don't exist

Dasha inference jobs run on provider Macs and can take minutes — far longer than a single HTTP round trip. The revision removed the experimental core Tasks API; the replacement is the tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663) with **client-driven polling** (`tasks/get|update|cancel`). There is no server-initiated push stream to fall back on (GET no longer opens SSE). If the Worker used the old Tasks API, that surface is now dead; if it faked progress via held-open streams, those break under stateless serving. Polling handles must also be idempotency-safe (see GAP-3): a client polling a re-issued request must land on the same job, not a new one.

**Severity: MEDIUM-HIGH**

**Fix sketch.** Adopt the SEP-2663 tasks extension: `tools/call` on a long-running tool returns a task handle immediately; clients poll `tasks/get`; cancellation via `tasks/cancel`. Keep poll responses consistent with the canonical metering record. Decide and document whether partial-progress notifications are supported at all (in the stateless world they ride the polling responses, not a push channel). Track SEP-1686 (server→client triggers) per TASKS.md #21 — it is the future push story, not today's.

**⛔ Registry promise gate.** Do NOT promise notification/push capabilities, streaming progress, or any async-job semantics in the registry or card until the tasks-extension posture is implemented. The card's `capabilities` block should stay at tools-only until then.

### GAP-10 — Tool names, descriptions, and titles are unaudited from here

In the tool-search era, clients defer schemas: **tool names + server `instructions` are the discoverability lever**, and the revision adds a human-readable `title` per tool for connector UIs. The actual Dasha tool names, their descriptions, and whether they carry `title`s live in the Worker tree and are invisible from this repo. TASKS.md #17 owns the naming audit. Additionally, any NSA/CISA May-2026 concerns (treat tool descriptions/results as untrusted, prefer read-only) map onto these same names — TASKS.md #18.

**Severity: MEDIUM**

**Fix sketch.** Clone the Worker tree; enumerate every tool with name, `title`, description, and schema; run the #17 discoverability audit (keyword coverage for "inference", "llm", "mac", "qwen", "gemma", model ids) and the #18 risk ratings; add a server `instructions` string; backfill `title` on every tool.

**⛔ Registry promise gate.** Do NOT enumerate tools in registry metadata beyond the boolean `capabilities.tools` until the audit lands — the card draft already (correctly) declines to list per-tool detail. A registry that names tools the server doesn't have (or misses ones it does) breaks agent planning.

### GAP-11 — Live endpoint URL unconfirmed; live state unverifiable from this repo

Both the card draft and the dossier carry `https://www.getdasha.com/compute/mcp` as a **placeholder** remote URL; the dossier's field table marks it UNCONFIRMED and its gap #3 says the mcpservers.org listing proves a server exists but the exact endpoint was never reconfirmed. For this analysis, fetching the mcpservers.org listing page also failed, so the listing's stated URL could not be rechecked. The registry checks that the remote is publicly reachable — an unconfirmed URL fails submission outright.

**Severity: HIGH** (hard submission blocker)

**Fix sketch.** Confirm the live endpoint URL against the mcpservers.org listing (`www-getdasha-com-compute-mcp-json`); probe it with a stateless 2026-07-28 client (`server/discover`, `tools/list`, one `tools/call` with the required headers) and a legacy client if GAP-8 keeps legacy; only then fill `remotes[].url` in the card and dossier.

**⛔ Registry promise gate.** Do NOT submit to the registry at all until the endpoint URL is confirmed and the live probe passes. Everything else in the dossier is ready to be a paste job — this is the field that makes the paste job real.

### GAP-12 — Deprecation runway and OAuth alignment are untracked

Roots, Sampling, and Logging carry a ~12-month deprecation runway (mid-2027); server logging moves off the wire entirely (stderr, SEP-2577); HTTP auth tightens toward OAuth 2.1 / OIDC; SDK v2 needs Node 20+. None of this breaks the registry submission today, but the auth-model tightening interacts with GAP-4 (the Dasha token scheme is a Worker-side fact, still undocumented publicly).

**Severity: LOW-MEDIUM**

**Fix sketch.** Put the mid-2027 deprecation date on the Worker team's calendar; confirm the endpoint's auth story against OAuth 2.1 expectations (401 + `WWW-Authenticate`, RFC 9728-style challenges) as part of GAP-4; document the real token scheme before the #47 card deploy so the card's `authentication` block is honest.

**⛔ Registry promise gate.** Do NOT write anything beyond "auth required" in the card/registry until the real token scheme is confirmed — the dossier already marks this UNCONFIRMED and it should stay that way.

---

## What the registry must NOT promise — consolidated

Until the gates above close, the official registry entry and the Server Card must not claim:

1. `protocol.versions: ["2026-07-28"]` or `stateless: true` — until the live wire probe passes (GAP-1, GAP-6).
2. A concrete `remotes[].url` — until the endpoint is confirmed and reachable (GAP-11).
3. Safe, billable, retry-friendly tools — until idempotency is live (GAP-3).
4. Any free-tier/quota semantics beyond "auth required" — until per-request attribution is verified (GAP-4).
5. Notification, push, streaming-progress, or async-job capabilities — until the tasks-extension posture is implemented (GAP-9).
6. A tool list — keep `capabilities.tools: true` boolean only until the naming audit lands (GAP-10).
7. An auth/token scheme — until the Worker-side scheme is confirmed (GAP-12).
8. Backwards compatibility with legacy clients — until the negotiation posture is decided and tested (GAP-8).

The honest interim posture for the registry is: *remote streamable-http server, tools capability, auth required, protocol version TBD pending the stateless upgrade (tasks #15/#48)* — anything more specific is a promise the project cannot currently keep.

## Cross-cutting notes

- **Metering interplay (PR #219):** the gateway-metering program makes the coordinator the metering point with provider-reported numbers never-trusted. GAP-3's idempotency key must become part of the canonical usage record, or a re-issued request will double-count gateway-measured bytes too. The two tasks should land together.
- **The card's `ttlMs`/`cacheScope` on `server/discover`** (GAP-6) is also the cheapest client-perceived latency win in the stateless world: without sessions, clients re-discover aggressively unless told not to.
- **Single-instance assumption dies:** stateless means any instance can serve any request — deployments can sit behind ordinary round-robin load balancers. If the Worker MCP handler assumed single-instance affinity (in-memory job maps, local dedupe caches), GAP-3's dedupe cache needs a shared store, not process memory.

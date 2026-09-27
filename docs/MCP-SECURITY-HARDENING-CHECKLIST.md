# MCP security hardening checklist — Dasha Compute (task #18)

**Status:** CHECKLIST ONLY — no code changes. Maps the NSA/CISA May-2026 MCP
guidance onto the Dasha MCP surface and rates every tool. Hardening actions
are assigned to the lane that can act: most server-side fixes belong to the
Worker lane (the MCP server implementation lives in the Worker tree, not in
dasha-desk — see docs/MCP-TOOL-NAMING-AUDIT.md, PR #228); desk-lane actions
are docs/catalog/registry work this repo can ship.

## Guidance mapped (guidance-paraphrase, not repo fact)

The guidance is the NSA Artificial Intelligence Security Center Cybersecurity
Information Sheet *"Model Context Protocol (MCP): Security Design Considerations
for AI-Driven Automation"* (May 2026, v1.0; U/OO/6030316-26 | PP-26-1834),
commonly cited as the NSA/CISA MCP guidance. Its headline recommendations,
paraphrased:

1. **Treat every MCP session as untrusted until verified** — tool
   descriptions and tool results are untrusted input that can carry indirect
   prompt injections (tool poisoning).
2. **Prefer read-only tools** — expose state-changing or billed tools only
   where a read-only tool cannot do the job.
3. **Scope servers and tokens** — restrict which servers a client connects
   to; least-privilege tokens per action and per tool, not one broad token.
4. **Signed provenance for dynamically discovered servers** — don't trust a
   server card or listing at face value.
5. **Log every tool action** — what tool, requested by whom, what result.
6. **Filter/pin the outbound path** — pin resource URLs and access methods;
   don't let tool outputs steer clients to arbitrary endpoints.

Any recommendation wording not traceable to a repo file is guidance-paraphrase.
Repo facts below are grounded in the tool catalog
(`compute/mcp-tool-catalog.json` on the PR #229 branch, backfilling the live
five-tool surface verified 2026-09-18 against
`https://www.getdasha.com/compute/mcp.json`), the V6 tool proposals
(#231/#232/#233), the GAP-3 idempotency design (PR #223), and the server-card
draft (PR #220).

## Tool inventory covered

Five live tools (healthz, models, network, guest-keys, chat.completions) plus
three V6 proposals awaiting Worker-lane decision (dasha_pricing #231,
dasha_hosted_ask #232, dasha_receipt_verify #233). No other tools exist in the
catalog; no MCP server code lives in this repo.

## Per-tool risk ratings and hardening actions

### `healthz` — GET /compute/api/healthz — **Low**

- **Why Low:** unauthenticated but strictly read-only; returns coordinator
  reachability only. No billing, no state change, no user data.
- **Guidance mapping:** read-only (satisfies #2); still treat the status
  payload as untrusted input on the client side (#1) — a compromised
  coordinator could stuff the health payload with injected instructions for
  tool-search routers.
- **Hardening action (Worker lane):** normalize the health response to a
  fixed enum (`ok`/`degraded`/`down`) — no free-text fields that a tool
  description or result parser would ingest.

### `models` — GET /compute/api/v1/models — **Low**

- **Why Low:** read-only, unauthenticated; lists models and per-model
  pricing.
- **Guidance mapping:** model+pricing data shapes spending decisions, so this
  is the highest-value *tool-poisoning* target on the read-only side (#1): a
  tampered model list could steer agents toward a malicious provider's model
  or fake prices. Prefer-read-only is already satisfied (#2).
- **Hardening action (Worker lane):** serve the model list as a signed
  payload (or pin it behind the same integrity story as the receipt chain —
  ed25519 via `/keys.json`); clients SHOULD cross-check the price fields
  against `dasha_pricing` before billing decisions.

### `network` — GET /compute/api/v1/network — **Medium**

- **Why Medium, not Low:** read-only, but it publishes live provider-Mac
  identity and advertised capacity. Spoofed or inflated availability entries
  could steer `chat.completions` jobs toward attacker-controlled Macs — and
  provider Macs can see prompts (see `chat.completions`). Availability data
  is advisory, yet agents will treat it as authoritative unless told
  otherwise.
- **Guidance mapping:** treat the result as untrusted input (#1); it is a
  *discovery* surface, and guidance #4 (signed provenance) applies to
  anything that tells an agent where to send work.
- **Hardening action (Worker lane):** advertise only coordinator-verified
  capacity (cryptographic provider attestation, not self-reported strings);
  label the data advisory in the description; never expose provider IPs,
  keys, or internal hostnames in this view.

### `guest-keys` — POST /compute/api/guest-keys — **Medium**

- **Why Medium:** the only unauthenticated state-changing tool — it mints
  Bearer credentials. Rate-limited (3/hour/IP) per the catalog, but IP-based
  limits are weak against distributed abuse; minted keys are bearer secrets
  ("copy once, cannot be retrieved later").
- **Guidance mapping:** violates prefer-read-only (#2) by design — minting
  is the point — so it needs the compensating controls: per-action scoping
  (#3: keys mint with minimal scope and 24h expiry, already true) and full
  audit logging (#5: mint events logged with source IP, no key material in
  logs).
- **Hardening action (Worker lane):** keep the rate limit and add a
  circuit-breaker (proof-of-work or CAPTCHA) if mint volume spikes; confirm
  minted keys carry the narrowest scope (chat + models only) and that the
  "copy once" contract is enforced server-side (no retrieval endpoint).

### `chat.completions` — POST /compute/api/v1/chat/completions — **High**

- **Why High:** billed per call, executes work on third-party community
  hardware, and **provider Macs can see prompts** — the server
  `instructions` (PR #230) state this explicitly ("never send sensitive
  data"). Under the stateless 2026-07-28 revision, a broken stream is
  re-issued with a new request id, so without a client idempotency key each
  re-issue mints a duplicate billed job (GAP-3, PR #223). Tool outputs are
  model-generated text: treat every completion as untrusted input for
  downstream tool calls (#1).
- **Guidance mapping:** billed + third-party execution is the exact surface
  guidance #2/#3 warn about: this tool must have per-key scoping, spending
  caps/alerts, and mandatory idempotency keys on the billed path; full
  audit logging (#5: tool, key subject, model, tokens, result id).
- **Hardening actions (Worker lane):** (a) enforce the GAP-3 idempotency-key
  contract (PR #223) — reject billed calls without a valid key, fail closed
  on malformed keys (`-32602`); (b) per-key spend caps with alerting; (c)
  strip/escape nothing in outputs but document that outputs are untrusted
  and must not be executed or used as tool arguments without validation;
  (d) keep the "provider Macs see prompts" warning in the tool description
  itself, not just in `instructions`, so schema-deferred clients still see
  it.

### `dasha_pricing` — proposal (PR #231) — **Low**

- **Why Low:** read-only by design ("It estimates — it never bills and never
  charges your key"); all inputs optional.
- **Guidance mapping:** satisfies prefer-read-only (#2). Residual risk is
  quote manipulation steering spend (#1): a poisoned rate card could make an
  expensive model look cheap.
- **Hardening action (Worker lane, on acceptance):** serve the rate card from
  the same signed source as `models` pricing; keep the tool read-only and
  unauthenticated.

### `dasha_hosted_ask` — proposal (PR #232) — **High**

- **Why High:** billed per call like `chat.completions`, stateful, and
  prompts are "billable and logged" on the hosted surface. The proposal
  already requires `idempotency_key` on every call (GAP-3) — the rating stays
  High because the spend and data-exposure surface equals `chat.completions`.
- **Guidance mapping:** same billed-tool controls as `chat.completions`
  (#2/#3/#5); additionally, the tool must never be a *silent swap* for
  community chat — its description already carries this, keep it (#1: don't
  let the description be the only place the distinction lives; mirror it in
  `title`/server `instructions`).
- **Hardening action (Worker lane, on acceptance):** ship with GAP-3
  idempotency enforcement from day one (no migration grace period for a new
  billed tool); require API key (no guest keys); per-key spend caps.

### `dasha_receipt_verify` — proposal (PR #233) — **Medium**

- **Why Medium, not Low:** read-only, but it is a lookup oracle over
  receipts and its security rests entirely on **caller-scoped access** ("a
  key only sees its own receipts") — per the proposal, "only expose if the
  Worker can enforce caller-scoped access." A scoping bug turns a
  read-only tool into a cross-tenant data leak.
- **Guidance mapping:** least-privilege per tool (#3); independent
  verification path (ed25519 against `/keys.json`) satisfies the
  "verify, don't trust" half of #1 — the machine verdict must be checkable
  without trusting the server that produced it.
- **Hardening action (Worker lane, on acceptance):** enforce caller scoping
  in the data layer (row-level, derived from the auth subject — never from
  a client-supplied tenant field); keep rejecting `rcp_` ids as lookup keys
  (`-32602`); document the `verify_chain` independent path as the way to
  check a receipt without trusting the card/listing.

## Cross-cutting checklist

- [ ] **Tool-name squatting / shadowing.** The live names `healthz`,
  `models`, `network`, and `chat.completions` are generic or OpenAI-shaped;
  in multi-server clients that merge tool lists, a malicious or lookalike
  server can squat these names and shadow the real tools. The naming audit
  (PR #228) already proposes `dasha_*`-prefixed renames (R2
  conflict-avoidance); treat the rename batch as a security control, not
  just discoverability. `chat.completions`' dot additionally breaks
  OpenAI-identifier-shaped clients, which can cause silent tool drops —
  fail-loud there is safer than fail-silent.
- [ ] **Prompt injection via tool outputs.** Every tool result on this
  surface is untrusted input: health payloads, model lists, network
  availability, pricing quotes, completions, receipt bodies. Client guidance
  (skill.md + server `instructions`): never execute tool-output text, never
  pass it as a tool argument without validation, and treat availability and
  pricing data as advisory until cross-checked.
- [ ] **Authorization boundaries for billed tools.** Billed = `chat.completions`
  today, `dasha_hosted_ask` if accepted. Boundary stack: Bearer key auth →
  per-key scope (guest keys: chat+models only) → GAP-3 idempotency keys on
  every billed call (PR #223; reject malformed/missing keys with `-32602`,
  fail closed) → per-key spend caps and alerting → full audit log
  (tool, key subject, model, tokens, idempotency key, result id).
- [ ] **Server-card trust (`/.well-known/mcp/server-card.json`).** The card
  draft (PR #220, SEP-2127) is not yet served; serving it is a Worker change
  behind the deploy boundary. Per guidance #4: pin the card URL in docs, sign
  the payload, and treat any card fetched from an unpinned URL as untrusted.
  Confirm the `repository`/`remotes[].url` fields before deploy (both marked
  TBD in the draft).
- [ ] **Registry supply-chain.** The mcpservers.org listing (slug
  `www-getdasha-com-compute-mcp-json`) is a third-party registry surface:
  its body, badge, and endpoint URL are trust-relevant and should be pinned
  and change-monitored in this repo. The authoritative path is the official
  registry dossier (task #20 / PR #220); keep the two bodies byte-identical
  so a diff between registries is itself a signal.
- [ ] **Log every tool action.** Guidance #5: what tool, requested by whom
  (auth subject), arguments hash, idempotency key, result. No key material
  or prompt contents in logs beyond what the retention policy allows.
- [ ] **Prefer read-only — net check.** After the V6 batch, the surface is
  6 read-only tools (healthz, models, network, dasha_pricing,
  dasha_receipt_verify, plus tools/list) against 2 billed state-changing
  tools (chat.completions, dasha_hosted_ask) and 1 credential-minting tool
  (guest-keys). Do not add further state-changing tools without a
  read-only-first review.

## What this checklist does not cover

- The MCP server implementation (Worker tree) — this repo holds the catalog,
  proposals, and docs; server-side enforcement is the Worker lane's.
- Provider-Mac supply-chain (attested builds, provider identity) — tracked
  under the trust/metering tasks (#22–#25), not here.
- The 2026-07-28 transport/stateless gaps themselves — see
  docs/MCP-STATELESS-GAP-ANALYSIS.md (PR #221).

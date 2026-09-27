# MCP `dasha_hosted_ask` tool — proposal (V6 remaining candidate)

**Dated:** 2026-09-18. **Status:** PROPOSAL — Worker lane decision.
**Non-breaking, additive:** one new tool; the five live tool names are
untouched (renames stay with the lane owner per the GAP-8 legacy-posture
decision, PR #221).

## What this is

The V6 coverage-gap ranking (`docs/MCP-SERVER-INSTRUCTIONS.md`, PR #230)
lists the Hosted Ask lane — `POST /compute/api/chat` — as the **second**
candidate after `dasha_pricing` (PR #231): "Medium-high — the primary Ask
surface", **MEDIUM** risk because it is stateful and billed per call.
skill.md: "Hosted Ask is the browser. Not a ledger. Not Room." / "Hosted
Ask is POST /compute/api/chat (status.live Workers AI). Not a silent v1
swap." This doc is the concrete tool proposal: name, 2026-07-28 `title`,
keyword-rich description, input/output schema sketches, example calls,
and the billing/idempotency/auth guardrails the description must carry.

## Tool definition

- **`name`:** `dasha_hosted_ask`
- **`title` (2026-07-28):** "Dasha Hosted Ask"
- **`description`:** Ask Dasha's hosted inference surface directly
  (browser-equivalent `POST /compute/api/chat`, status.live Workers AI) —
  not a silent swap for community chat completions. Requires an API key;
  **billed per call like `chat.completions`** (estimate first with
  `dasha_pricing`); `reasoning_effort` low|medium|high applies (alias
  `effort`). Every billed call MUST carry an `idempotency_key` (UUIDv7) —
  the stateless MCP transport re-issues broken streams with new request
  ids, and a re-issue without a dedupe key mints a duplicate billed job
  (PR #223). Provider Macs are not in this path (hosted), but prompts are
  billable and logged; never send secrets you would not send to a hosted
  inference API.

### Naming-rules compliance (audit R1–R5)

| rule | check | result |
|------|-------|--------|
| R1 charset/length | `[a-z0-9_]` only, 16 chars | pass |
| R2 service context | `dasha_` prefix + `hosted_ask` (matches skill.md's "Hosted Ask" lane name) | pass |
| R3 client compat | snake_case, dot-free, ≤ 64 chars | pass — clean name from the start, unlike `chat.completions` |
| R4 `title` | "Dasha Hosted Ask", human-readable, ≠ name | pass |
| R5 keyword coverage | dasha / hosted / ask · inference / llm / prompt / answer · billed / reasoning-effort / flash / astra | pass |

## Input schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["prompt", "idempotency_key"],
  "properties": {
    "prompt": {
      "type": "string", "minLength": 1,
      "description": "The question/instruction for Hosted Ask. Keep it a single user turn; this is the browser surface, not a chat loop."
    },
    "model": {
      "type": "string",
      "description": "Optional hosted model. Omit for the hosted default. Hosted-only classes per skill.md: deepseek-flash (Hosted Flash), gpt-6-astra (Hosted Astra) — never route these to Community."
    },
    "reasoning_effort": {
      "type": "string", "enum": ["low", "medium", "high"],
      "description": "Reasoning effort; alias `effort`. Hosted applies it (per skill.md). Community chat/completions may ignore — this tool is Hosted-only, so it always applies."
    },
    "idempotency_key": {
      "type": "string", "minLength": 8, "maxLength": 128,
      "description": "REQUIRED on every call (billed tool, per docs/MCP-IDEMPOTENCY-DESIGN.md PR #223). Client-generated per user intent — UUIDv7 recommended; charset [A-Za-z0-9._~-]. Reuse the SAME key across retries/re-issues of this call; a new user intent gets a new key."
    }
  }
}
```

## Output schema

```json
{
  "type": "object",
  "required": ["route", "answer"],
  "properties": {
    "route": { "type": "string", "enum": ["hosted"], "description": "Always 'hosted' — never a silent Community swap (per skill.md)." },
    "answer": { "type": "string", "description": "The hosted model's answer text." },
    "model": { "type": "string", "description": "Hosted model that answered (watch x-dasha-model on the wire)." },
    "request_id": { "type": "string", "description": "Echo back for receipt lookup via dasha_receipt_verify." },
    "spend_usd": { "type": "number", "description": "Known billed spend in USD (x-dasha-spend-usd); may be omitted when unknown." },
    "idempotency": {
      "type": "object",
      "properties": {
        "key": { "type": "string" },
        "replayed": { "type": "boolean", "description": "True if this call returned the deduped result of an earlier call with the same key." }
      }
    }
  }
}
```

## Example calls

**1. Basic ask** — `{"prompt": "Summarize this error log in three
bullets: …", "idempotency_key": "dasha-idem-0193a7f2-…"}` →
`{"route": "hosted", "answer": "…", "model": "…", "request_id": "…",
"spend_usd": 0.02}`.

**2. Hosted-only Flash class** — `{"prompt": "…", "model":
"deepseek-flash", "reasoning_effort": "high", "idempotency_key": "…"}`.

**3. Retry after a broken stream** — same `idempotency_key` as the
timed-out call, same `prompt`; server returns the deduped original result
with `"replayed": true` instead of minting a second billed job.

## Risk notes (the MEDIUM rating, addressed)

1. **Billed per call, stateful.** The description carries the billing
   warning (audit rule: "if exposed, description must state it is billed
   like `chat.completions`") and points to `dasha_pricing` for pre-flight
   estimates.
2. **Double-charge on stream re-issue.** The 2026-07-28 revision deleted
   SSE resumability; clients re-issue `tools/call` with a new request id,
   so request ids cannot dedupe (PR #223, GAP-3 CRITICAL). This proposal
   makes `idempotency_key` **required** in the schema and ties the Worker
   implementation to the PR #223 server contract (UUIDv7, 8–128 chars,
   `[A-Za-z0-9._~-]`, dedupe scope `(auth subject, tool name, key)`, 24h
   TTL, replay returns the stored result). The lane owner must not ship
   this tool without the idempotency flip.
3. **Auth.** skill.md puts key creation at `POST /compute/api/guest-keys`
   (24h chat+models) or a lasting `dsk_` from sign-in. The proposal
   assumes Bearer <redacted> like `chat.completions`; whether guest keys
   (`dgk_`) are accepted for Hosted Ask is a lane-owner decision (open
   question below).
4. **Never a silent swap.** Output pins `"route": "hosted"`; the
   description disambiguates from `chat.completions` (community Macs) and
   from the live `network`/`models` tools.

## Worker-lane application

The live MCP surface is served by the Worker tree — this repo has no MCP
server code, so this doc is payload + instructions only.

1. **File:** `mcp.json` in the Worker tree (the catalog served at
   `https://www.getdasha.com/compute/mcp.json`). Append the
   `dasha_hosted_ask` tool entry. Do not touch the five existing tools.
2. **Backend wiring:** `POST …/compute/api/chat` (status.live Workers
   AI). Forward `prompt`/`model`/`reasoning_effort` (alias `effort`);
   enforce the PR #223 idempotency contract server-side — reject
   out-of-spec keys with `-32602` before dispatch; on key replay return
   the stored result with `replayed: true`. Surface `route`,
   `x-dasha-model`, `x-dasha-spend-usd`, and the echoed `request_id`.
3. **Server Card hygiene:** a new tool is a card-versioning event — bump
   the card `version` per the Server Card rules (PR #220).
4. **Consistency:** mirror the entry in the agent skill
   (`…/compute/skill.md` — Hosted Ask is already described there; add a
   pointer to the tool), the server `instructions` string (PR #230), and
   the mcpservers.org listing body (`www-getdasha-com-compute-mcp-json`).
5. **Non-breaking constraint:** purely additive. `healthz`, `models`,
   `network`, `guest-keys`, `chat.completions` keep their names; the
   V1–V3 renames remain a scheduled breaking batch for the lane owner.

## Open questions (lane owner / Worker lane)

1. **Auth scope:** does Hosted Ask accept guest keys (`dgk_`), or `dsk_`
   only? (skill.md: guest keys are "24h chat+models" — does "chat" include
   `POST /compute/api/chat`?)
2. **Billing disclosure:** exact per-call price for Hosted Ask vs.
   community chat completions — the description must name it once known
   (currently "billed like `chat.completions`" per the audit).
3. **Idempotency enforcement flip:** ship the tool only behind the PR #223
   enforcement flip, or ship with the `Dasha-Idempotency: none`
   diagnostic first? Recommend: do not ship billed tools without
   enforcement.
4. **Hosted model ids:** which hosted model ids are legal inputs (beyond
   the `deepseek-flash`/`gpt-6-astra` classes in skill.md), and does the
   tool accept them, or is the model fixed to the hosted default?

## Explicitly out of scope

- The V1–V3 renames (breaking, lane-owner decision).
- `dasha_pricing` (shipped as proposal PR #231); `dasha_receipt_verify`
  (separate proposal PR); `readyz` (explicitly skipped, PR #230).
- Implementing or deploying the Worker change (tasks #47/#48, JOHN).
- The official registry submission (tasks #38/#39, JOHN).

**Related:** PR #228 (audit, V6) · PR #230 (`instructions` + V6 ranking) ·
PR #231 (`dasha_pricing` proposal) · PR #223 (idempotency design, GAP-3) ·
PR #221 (stateless-gap analysis) · PR #220 (card/dossier) · TASKS.md
#17/#15/#16/#18/#20.

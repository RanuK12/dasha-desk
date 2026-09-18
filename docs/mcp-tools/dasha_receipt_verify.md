# MCP `dasha_receipt_verify` tool — proposal (V6 remaining candidate)

**Dated:** 2026-09-18. **Status:** PROPOSAL — Worker lane decision.
**Non-breaking, additive:** one new tool; the five live tool names are
untouched (renames stay with the lane owner per the GAP-8 legacy-posture
decision, PR #221).

## What this is

The V6 coverage-gap ranking (`docs/MCP-SERVER-INSTRUCTIONS.md`, PR #230)
lists receipt lookup/verify as the **third** candidate after
`dasha_pricing` (PR #231) and the Hosted Ask lane: "Medium — agents
verifying a completed job", **MEDIUM** risk — "per-key scoping must hold;
only expose if the Worker can enforce caller-scoped access". skill.md
documents the surface: "Receipts: signed, chained. GET
https://www.getdasha.com/compute/api/receipts · verify
https://www.getdasha.com/verify … Machine verdict: GET
/compute/api/verify?hash= — the 64-hex chain hash, the job_ id, or your
request_id; the rcp_ receipt id is not a lookup key." This doc is the
concrete tool proposal: name, 2026-07-28 `title`, keyword-rich
description, input/output schema sketches, example calls, and the
caller-scoping + independent-verification notes the design must carry.

## Tool definition

- **`name`:** `dasha_receipt_verify`
- **`title` (2026-07-28):** "Dasha receipt verify"
- **`description`:** Verify a Dasha Compute job receipt without trusting
  any single page: signed, chained receipts (`GET …/compute/api/receipts`;
  human page at /verify). Look up by the 64-hex chain hash, the `job_` id
  from a completion response, or the `request_id` you sent on
  `chat.completions` (echoed as `receipt.request_id`) — the `rcp_` receipt
  id is NOT a lookup key. Read-only; no idempotency key needed. Returns
  the machine verdict plus the signed-body fields for independent checking
  (`GET …/compute/api/chain` + `/keys.json`, ed25519). Receipts are
  caller-scoped: a key only sees its own receipts.

### Naming-rules compliance (audit R1–R5)

| rule | check | result |
|------|-------|--------|
| R1 charset/length | `[a-z0-9_]` only, 19 chars | pass |
| R2 service context | `dasha_` prefix + `receipt_verify` (matches skill.md's "Receipts" surface) | pass |
| R3 client compat | snake_case, dot-free, ≤ 64 chars | pass — clean name from the start, unlike `chat.completions` |
| R4 `title` | "Dasha receipt verify", human-readable, ≠ name | pass |
| R5 keyword coverage | dasha / receipt / verify / signed / chain · job / job_id / request-id / spend / cents · ed25519 / trust | pass |

## Input schema

Exactly one lookup key required.

```json
{
  "type": "object",
  "additionalProperties": false,
  "minProperties": 1,
  "properties": {
    "chain_hash": {
      "type": "string", "pattern": "^[0-9a-f]{64}$",
      "description": "The 64-hex chain hash (receipt.hash = sha256 of the canonical signed body)."
    },
    "job_id": {
      "type": "string",
      "description": "The job_ id from a chat/completions response."
    },
    "request_id": {
      "type": "string",
      "description": "The request_id you sent on chat/completions; echoed as receipt.request_id."
    },
    "verify_chain": {
      "type": "boolean", "default": false,
      "description": "When true, additionally re-walk chain continuity (each prev_hash equals the previous hash) and the ed25519 signer check against /keys.json, returning the independent verdict alongside the machine verdict."
    }
  }
}
```

Note: `rcp_` receipt ids are explicitly rejected (`-32602`) — they are
not lookup keys (per skill.md).

## Output schema

```json
{
  "type": "object",
  "required": ["found", "verdict"],
  "properties": {
    "found": { "type": "boolean", "description": "False when the key sees no such receipt (unknown hash OR another caller's receipt — the tool does not distinguish; see caller scoping)." },
    "verdict": {
      "type": "object",
      "required": ["valid"],
      "properties": {
        "valid": { "type": "boolean", "description": "Machine verdict from GET /compute/api/verify?hash=." },
        "receipt": {
          "type": "object",
          "properties": {
            "hash": { "type": "string" },
            "job_id": { "type": ["string", "null"] },
            "request_id": { "type": ["string", "null"] },
            "engine": { "type": "string" },
            "route": { "type": "string", "enum": ["community", "hosted"], "description": "Same as x-dasha-route." },
            "tokens": { "type": "integer" },
            "cents": { "type": "integer" },
            "at": { "type": ["integer", "null"], "description": "Unix-ms; null allowed per skill.md." },
            "prev_hash": { "type": "string", "description": "Previous receipt hash or \"GENESIS\"." },
            "sig": { "type": "string", "description": "ed25519 over the UTF-8 bytes of the hash hex string." },
            "signer": { "type": "string", "description": "First 16 hex chars of sha256(spki_pem)." }
          }
        },
        "independent": {
          "type": "object",
          "description": "Present when verify_chain=true.",
          "properties": {
            "body_matches_hash": { "type": "boolean", "description": "Rebuilt body (exactly keys job_id, engine, tokens, cents, at, prev_hash in that order) hashes to receipt.hash." },
            "signature_valid": { "type": "boolean", "description": "receipt.sig verifies under the signer's spki_pem from /keys.json." },
            "chain_continuous": { "type": "boolean", "description": "Each prev_hash equals the previous hash back to GENESIS." }
          }
        }
      }
    }
  }
}
```

## Example calls

**1. By request_id** — `{"request_id": "req_01J…"}` → `{"found": true,
"verdict": {"valid": true, "receipt": {"job_id": "job_…", "route":
"community", "cents": 5, …}}}`.

**2. By chain hash** — `{"chain_hash": "9f2c…"}` (64 hex) → same shape.

**3. Independent verification** — `{"job_id": "job_…", "verify_chain":
true}` → adds `"independent": {"body_matches_hash": true,
"signature_valid": true, "chain_continuous": true}`.

**4. Wrong caller's receipt** — `{"chain_hash": "…"}` for a receipt
minted under a different key → `{"found": false, …}`
(indistinguishable from unknown — deliberate, see caller scoping).

## Risk notes (the MEDIUM rating, addressed)

1. **Caller-scoped access (the audit's gating condition).** Receipts are
   minted against the auth subject. The Worker MUST scope lookups to the
   caller's subject and return "not found" (never "exists but not yours")
   for another caller's receipts — distinguishing would leak existence
   across tenants. The proposal's `found: false` ambiguity is deliberate.
2. **Read-only.** Per `docs/MCP-IDEMPOTENCY-DESIGN.md` (PR #223) rule 4,
   read-only tools do not need idempotency keys; servers ignore one if
   supplied. No double-charge surface.
3. **Independent verification is first-class.** The signed-body
   reconstruction recipe in skill.md (exact key order, sha256 hex,
   ed25519 over the UTF-8 bytes of that hex, signer = first-16-hex of
   sha256(spki_pem), chain continuity to GENESIS) is mirrored in the
   `independent` block so agents can verify without trusting the site —
   the trust gap the audit flags (PR #221 GAP-4/GAP-10 context).
4. **Auth.** Verdict lookup is per-key authenticated (Bearer <redacted>);
   the `/compute/api/chain` + `/keys.json` public inputs stay
   unauthenticated so anyone can re-verify published receipts.

## Worker-lane application

The live MCP surface is served by the Worker tree — this repo has no MCP
server code, so this doc is payload + instructions only.

1. **File:** `mcp.json` in the Worker tree (the catalog served at
   `https://www.getdasha.com/compute/mcp.json`). Append the
   `dasha_receipt_verify` tool entry. Do not touch the five existing
   tools.
2. **Backend wiring:** `GET …/compute/api/verify?hash=` with the one
   supplied lookup key (chain hash, `job_` id, or `request_id`); reject
   `rcp_` ids with `-32602`. Enforce caller-scoped access (dedupe-scope
   analogue: `(auth subject, tool name)` per PR #223's scoping principle).
   When `verify_chain=true`, also serve `GET …/compute/api/chain` +
   `/keys.json` inputs and compute the `independent` block server-side.
3. **Server Card hygiene:** a new tool is a card-versioning event — bump
   the card `version` per the Server Card rules (PR #220).
4. **Consistency:** mirror the entry in the agent skill
   (`…/compute/skill.md` — receipts are already described there; add a
   pointer to the tool), the server `instructions` string (PR #230), and
   the mcpservers.org listing body (`www-getdasha-com-compute-mcp-json`).
5. **Non-breaking constraint:** purely additive. `healthz`, `models`,
   `network`, `guest-keys`, `chat.completions` keep their names; the
   V1–V3 renames remain a scheduled breaking batch for the lane owner.

## Open questions (lane owner / Worker lane)

1. **Caller scoping confirm:** does the Worker receipt store index
   receipts by auth subject today, and can the verify endpoint filter on
   it without a schema migration?
2. **Guest-key receipts:** do `dgk_` guest keys mint receipts that are
   verifiable after the 24h key expires (receipt outlives key)? Recommend:
   yes — receipts are public-chain artifacts; scoping is on lookup, not
   on the chain.
3. **`verify_chain` cost:** chain re-walk on every call vs. cached
   verdicts — set a server-side cap (e.g., walk back N receipts max) and
   document it.
4. **`turns`:** should `turns` (only when already counted, per skill.md)
   be exposed in the receipt block, or kept out of the machine verdict?
   skill.md says "never invented" — the tool must echo, never compute.

## Explicitly out of scope

- The V1–V3 renames (breaking, lane-owner decision).
- `dasha_pricing` (proposal PR #231); `dasha_hosted_ask` (separate
  proposal PR); `readyz` (explicitly skipped, PR #230).
- Implementing or deploying the Worker change (tasks #47/#48, JOHN).
- The official registry submission (tasks #38/#39, JOHN).

**Related:** PR #228 (audit, V6) · PR #230 (`instructions` + V6 ranking) ·
PR #231 (`dasha_pricing` proposal) · PR #223 (idempotency design, GAP-3) ·
PR #221 (stateless-gap analysis) · PR #220 (card/dossier) · TASKS.md
#17/#15/#16/#18/#20.

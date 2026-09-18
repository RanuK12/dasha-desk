# MCP `dasha_pricing` tool — proposal (V6 top candidate)

**Dated:** 2026-09-18. **Status:** PROPOSAL — Worker lane decision.
**Non-breaking, additive:** one new tool; the five live tool names are
untouched (renames stay with the lane owner per the GAP-8 legacy-posture
decision, PR #221).

## What this is

The naming audit's V6 finding (docs/MCP-TOOL-NAMING-AUDIT.md, PR #228) is
informational: the skill.md documents endpoints the tool catalog never
exposes. The follow-up ranked the candidates (docs/MCP-SERVER-INSTRUCTIONS.md,
PR #230) and `dasha_pricing` came out **top** — "agents decide with price;
currently price only appears inside prose" — LOW risk (read-only,
unauthenticated). This doc is the concrete tool proposal: name, 2026-07-28
`title`, keyword-rich description, input/output schemas, example calls, and
Worker-lane application instructions. Canonical machine payload:
`compute/mcp-dasha-pricing-tool.json` (checked by
`compute/tests/mcp-dasha-pricing-tool.test.mjs`).

## Tool definition

- **`name`:** `dasha_pricing`
- **`title` (2026-07-28):** "Dasha pricing quote"
- **`description`:** Quote inference cost on the Dasha Compute Mac network
  before routing LLM jobs. Read-only: returns the standing rate card
  ($0.05 per job + $0.01 per 1k completion tokens; input tokens are not
  billed) and, when given a model, token counts, and a job count, breaks
  down the estimated cost per job and in total. Use with the Dasha models
  list to pick among qwen3-8b, gemma3-12b, gpt-oss-20b, qwen3-30b-a3b,
  gemma3-27b, gpt-oss-120b, then estimate before calling chat completions.
  It estimates — it never bills and never charges your key.

### Naming-rules compliance (audit R1–R5)

| rule | check | result |
|------|-------|--------|
| R1 charset/length | `[a-z0-9_]` only, 13 chars | pass |
| R2 service context | `dasha_` prefix (unambiguous in merged tool lists) | pass |
| R3 client compat | snake_case, dot-free, ≤ 64 chars | pass — clean name from the start, unlike `chat.completions` |
| R4 `title` | "Dasha pricing quote", human-readable, ≠ name | pass |
| R5 keyword coverage | dasha / mac / inference · pricing / cost / rate · llm / job / token / chat completion · qwen / gemma / gpt-oss | pass |

## Input schema

All inputs optional — a bare call returns the rate card alone.

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "model": {
      "type": "string",
      "description": "Model id the workload would run on (e.g. qwen3-8b, gemma3-12b, gpt-oss-20b, qwen3-30b-a3b, gemma3-27b, gpt-oss-120b). Optional; omit for the rate card alone."
    },
    "input_tokens": {
      "type": "integer", "minimum": 0,
      "description": "Prompt tokens per job. Not billed under the standing rate card; collected so per-model cards can price input tokens later."
    },
    "completion_tokens": {
      "type": "integer", "minimum": 0,
      "description": "Expected completion tokens per job. Only completion tokens are billed ($0.01 per 1k)."
    },
    "job_count": {
      "type": "integer", "minimum": 1, "default": 1,
      "description": "Number of jobs to cost. Defaults to 1."
    }
  }
}
```

## Output schema

```json
{
  "type": "object",
  "required": ["rate_card"],
  "properties": {
    "rate_card": {
      "type": "object",
      "required": ["per_job_usd", "per_1k_completion_tokens_usd", "currency"],
      "properties": {
        "per_job_usd": { "type": "number", "description": "Flat per-job fee in USD." },
        "per_1k_completion_tokens_usd": { "type": "number", "description": "Per-1k completion-token fee in USD." },
        "currency": { "type": "string" },
        "free_tier": { "type": "string" }
      }
    },
    "estimate": {
      "type": "object",
      "description": "Present whenever any input parameter is supplied.",
      "properties": {
        "model": { "type": "string" },
        "input_tokens_per_job": { "type": "integer" },
        "completion_tokens_per_job": { "type": "integer" },
        "job_count": { "type": "integer" },
        "breakdown_per_job_usd": {
          "type": "object",
          "properties": {
            "job_fee_usd": { "type": "number" },
            "completion_token_fee_usd": { "type": "number" },
            "per_job_total_usd": { "type": "number" }
          }
        },
        "total_usd": { "type": "number", "description": "job_count x per-job total, rounded to cents." },
        "assumptions": { "type": "object", "description": "Which inputs were supplied vs defaulted." }
      }
    }
  }
}
```

Formula: `total = job_count × (0.05 + completion_tokens / 1000 × 0.01)`.
Input tokens are explicitly unbilled — the schema still collects them so a
future per-model card can price them without a schema change.

## Example calls

**1. Single chat job** — `{"model": "qwen3-8b", "input_tokens": 500,
"completion_tokens": 300, "job_count": 1}` → per-job $0.053
($0.05 + 0.3 × $0.01), total $0.053.

**2. Batch** — `{"model": "gemma3-12b", "input_tokens": 2000,
"completion_tokens": 500, "job_count": 100}` → per-job $0.055,
total $5.50.

**3. Rate card only** — `{}` → just `rate_card`:
`{"per_job_usd": 0.05, "per_1k_completion_tokens_usd": 0.01,
"currency": "USD", "free_tier": "A free tier covers low-volume use."}`

## Standing rate card — and one open question

The payload ships the **standing rate card**: **$0.05 per job +
$0.01 per 1k completion tokens**. There is a reported discrepancy: the
dasha-local lane has been quoting **$0.06 per job + $0.012 per 1k
completion tokens**. This proposal does not resolve that — the payload
carries the standing card, and the decision on which card (or which card
for which lane) is **John's call**. When he decides, the Worker lane
updates the two numbers in the payload and re-publishes; the tool shape
does not change.

## Worker-lane application

The live MCP surface is served by the Worker tree — this repo has no MCP
server code, so this doc is payload + instructions only.

1. **File:** `mcp.json` in the Worker tree (the catalog served at
   `https://www.getdasha.com/compute/mcp.json`). Append the
   `compute/mcp-dasha-pricing-tool.json` `tool` entry to the `tools[]`
   array. Do not touch the five existing tools.
2. **Backend wiring:** read-only `GET .../compute/api/pricing` (per the
   audit's risk rating: unauthenticated). All four inputs are optional;
   pass them as query params (`?model=…&input_tokens=…&completion_tokens=…&
   job_count=…`); a bare GET returns the rate card alone. The Worker
   computes the estimate server-side with the formula above and returns
   `rate_card` + `estimate` per the output schema.
3. **Server Card hygiene:** a new tool is a card-versioning event — bump
   the card `version` per the Server Card rules (PR #220).
4. **Consistency:** mirror the entry in the agent skill
   (`.../compute/skill.md` pricing prose) and the mcpservers.org listing
   body (`www-getdasha-com-compute-mcp-json`); the server `instructions`
   string (PR #230) already mentions pricing and now has a tool to point at.
5. **Non-breaking constraint:** this is purely additive. `healthz`,
   `models`, `network`, `guest-keys`, `chat.completions` keep their names;
   the V1–V3 renames remain a scheduled breaking batch for the lane owner.

## Explicitly out of scope

- The V1–V3 renames (breaking, lane-owner decision).
- The other V6 candidates (Hosted Ask lane, receipt lookup/verify — medium
  risk; `readyz` — skip).
- Implementing or deploying the Worker change (tasks #47/#48, JOHN).
- The official registry submission (tasks #38/#39, JOHN).

**Related:** TASKS.md #17 (audit) · #15/#16/#18/#20 · PR #228 (audit, V1–V6) ·
PR #229 (V4/V5 backfill, open) · PR #230 (`instructions` + V6 ranking, open) ·
PR #220 (card/dossier) · PR #221 (GAP-7/8/10).

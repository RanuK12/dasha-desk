# MCP server `instructions` + V6 coverage — Worker-ready payload (PR #228 follow-up)

**Dated:** 2026-09-18. **Status:** Worker-ready payload, docs-only. **Non-breaking:**
no tool names change, so no JSON-RPC `-32602` behavior change under the
2026-07-28 MCP revision.

## What this is

Implements the remaining draftable, non-breaking half of the MCP tool-naming
audit (`docs/MCP-TOOL-NAMING-AUDIT.md`, PR #228 — AUDIT ONLY, still open):

- **Server `instructions` field.** The 2026-07-28 MCP revision advertises a
  server-level `instructions` string alongside the tool list (returned in the
  server's `initialize` result). In the tool-search / schema-deferral era
  (clients like Claude Code `defer_loading`), **tool names + server
  `instructions` are the discoverability lever** (audit R5) — this is the text
  tool-search routers rank on while schemas stay deferred. PR #228 drafted this
  string keyed to the *post-rename* names and said to ship it with the rename
  batch; the audit also notes the same text keyed to the *current* names is
  strictly better than no `instructions` at all. This doc ships the
  current-names version, so the Worker lane can apply it without waiting on the
  breaking rename decision.
- **V6 — coverage gap notes.** The audit's V6 finding (informational, not a
  rename): skill.md documents endpoints the catalog never exposes as tools.
  This doc analyzes each candidate for the Worker lane.

PR #229 (still open) backfills V4 (`title`) + V5 (keyword-rich descriptions)
keyed to current names. This doc is the third piece of the non-breaking batch:
V4 + V5 + `instructions` can all ship independently of the V1–V3 renames.

## Server `instructions` (copy-paste payload)

> You are using Dasha Compute, a decentralized LLM inference network served by
> community Apple Silicon Macs, with an OpenAI-compatible API.
> `chat.completions` runs a chat completion (OpenAI v1 chat/completions) on a
> community Mac — available models include qwen3-8b, gemma3-12b, gpt-oss-20b,
> qwen3-30b-a3b, gemma3-27b, gpt-oss-120b; if no Mac advertises the requested
> model it fails loudly with `no_mac_online`, never silently. `models` lists
> available LLM models with pricing. `network` shows which community Macs are
> advertising inference capacity. `guest-keys` mints a free 24-hour guest API
> key (3 per hour per IP) for chat and models. `healthz` checks coordinator
> health. Chat calls require a Bearer <redacted> key. Provider Macs can see prompts —
> never send sensitive data. Pricing is $0.05 per job + $0.01 per 1k
> completion tokens; a free tier covers low-volume use.

Keyword coverage (audit R5 — the text tool-search ranks on): `dasha`,
`inference`, `llm`, `mac`/`Apple Silicon Macs`, `qwen`, `gemma`, public model
ids (`qwen3-8b`, `gemma3-12b`, `gpt-oss-20b`, `qwen3-30b-a3b`, `gemma3-27b`,
`gpt-oss-120b`), `pricing`, `api key`. Length ~1 KB — fits catalog UIs and the
`initialize` result without dominating context.

When the rename batch lands (V1–V3, Worker lane owner), re-key the five
backticked names to the `dasha_*` names and ship the renamed string from the
audit §"Drafted server `instructions`". Until then, **this** string is the
one to apply.

## V6 — coverage gap notes (Worker lane decision)

The live skill documents endpoints the tool catalog never exposes. Candidates,
ranked by agent value vs. risk:

| candidate | endpoint (per skill.md) | value | risk | recommendation |
|-----------|-------------------------|-------|------|----------------|
| `dasha_pricing` | pricing endpoint | **Highest** — agents decide with price; currently price only appears inside prose | LOW (read-only, unauthenticated) | Top candidate for the first new tool. Additive = non-breaking. |
| Hosted Ask lane | `POST /compute/api/chat` | Medium-high — the primary Ask surface | MEDIUM — stateful, billed per call; needs cost + auth warning in description | Evaluate after the read-only set; if exposed, description must state it is billed like `chat.completions`. |
| receipt lookup/verify | receipt endpoints | Medium — agents verifying a completed job | MEDIUM — per-key scoping must hold; only expose if the Worker can enforce caller-scoped access | Lane-owner design decision; not in this batch. |
| `readyz` | readiness probe | Low — `healthz` already answers the agent's question ("is the coordinator reachable before routing?") | LOW | Skip as a tool; keep for ops. |

Rules for any new tool (from the audit, unchanged): snake_case, dot-free
(R3), ≤ 64 chars, `dasha_`-prefixed service context (R2), carry a `title`
(R4), keyword-rich description (R5). New tools are additive and non-breaking;
they still need the card `version` bump per the Server Card hygiene rules
(PR #220).

## Worker-lane application

The live MCP surface is served by the Worker tree — this repo has no MCP
server code (see audit "Scope"), so this doc is payload + analysis only.

1. **File:** `mcp.json` in the Worker tree (the catalog served at
   `https://www.getdasha.com/compute/mcp.json`).
2. **Where the field goes:** add a top-level `instructions` string to
   `mcp.json` with the payload above, so the Worker can surface it in catalog
   UIs and return it in the `initialize` result per the 2026-07-28 revision.
   Minimal shape:
   ```json
   {
     "name": "dasha-compute",
     "instructions": "You are using Dasha Compute, ...",
     "tools": [ /* unchanged */ ]
   }
   ```
3. **Consistency:** keep the prose aligned with the Server Card / registry
   dossier (PR #220), the agent skill at
   `https://www.getdasha.com/compute/skill.md`, and the mcpservers.org listing
   body (`www-getdasha-com-compute-mcp-json`).
4. **Non-breaking constraint (restated):** do NOT rename anything as part of
   this application. `chat.completions` keeps its dot, `healthz`/`models`/
   `network`/`guest-keys` keep their names — the V1–V3 renames are breaking
   changes (unknown name → JSON-RPC `-32602`) scheduled for the lane owner
   under the GAP-8 legacy-posture decision (PR #221). This payload, PR #229's
   V4/V5 backfill, and the current names compose cleanly.

## Explicitly out of scope

- Renames (`dasha_*` names, `dasha_chat_completions`) — breaking, lane-owner
  decision per audit V1–V3 and the task brief.
- V6 new-tool implementation — Worker lane decision; this doc is analysis only.
- Deploying or probing the live catalog (tasks #47/#48, JOHN).

**Related:** TASKS.md #17 (audit) · #15/#16/#18/#20 · PR #228 (audit, V1–V6) ·
PR #229 (V4/V5 backfill, open) · PR #220 (card/dossier) · PR #221 (GAP-7/8/10).

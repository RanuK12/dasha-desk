# MCP tool metadata backfill — title + description payload (PR #228 V4/V5)

**Status:** Worker-ready payload. **Non-breaking:** no tool names change, so no
JSON-RPC `-32602` behavior change under the 2026-07-28 revision.

## What this is

Implements the non-breaking half of the MCP tool-naming audit
(`docs/MCP-TOOL-NAMING-AUDIT.md`, PR #228 — AUDIT ONLY, ships the report):

- **V4 — `title` backfill.** Every tool gets a human-readable `title` for
  connector UIs per the 2026-07-28 MCP revision. Titles are taken from the
  audit's title column, applied to the *current* (unchanged) names.
- **V5 — keyword-rich descriptions.** Each description now covers the audit's
  R5 keyword expectations: `dasha`, `mac`, `inference`, `llm`, plus public
  model ids (`qwen3-8b`, `gemma3-12b`, `gpt-oss-20b`, `qwen3-30b-a3b`,
  `gemma3-27b`, `gpt-oss-120b`) where relevant — the text tool-search routers
  rank on while schemas stay deferred.

## Files

| file | purpose |
|------|---------|
| `compute/mcp-tool-catalog.json` | canonical backfill payload: all 5 tools with `title` + `description`, names byte-identical to the live inventory |
| `compute/tests/mcp-tool-catalog.test.mjs` | asserts: 5 tools, names match inventory exactly, every tool has a non-empty `title` ≠ `name`, descriptions meet per-tool keyword groups, models/chat name ≥3 public model ids, R1 charset + name uniqueness |

## Applying it (Worker lane)

The live MCP catalog is served by the Worker tree at
`https://www.getdasha.com/compute/mcp.json` (this repo has no MCP server code;
see audit "Scope"). To apply: copy each tool's `title` and `description` from
`compute/mcp-tool-catalog.json` into the live catalog entry with the same
`name`. Names must stay identical — any rename is the breaking batch for the
lane owner under the GAP-8 legacy-posture decision (alias window or card
`version` bump per PR #220).

Also update to match: the agent skill prose at
`https://www.getdasha.com/compute/skill.md` (mentions healthz/network/models
and guest-key prose) and the mcpservers.org listing body
(`www-getdasha-com-compute-mcp-json`).

## Explicitly out of scope

- Renames (`dasha_*` names, `dasha_chat_completions` for `chat.completions`) —
  breaking changes, lane-owner decision per audit V1–V3 and the task brief.
- The drafted server `instructions` string — ships with the rename batch; the
  audit notes the same text keyed to current names is strictly better than none.
- V6 coverage gap (`dasha_pricing` etc.) — Worker lane decision.

**Related:** TASKS.md #17 · PR #228 (audit) · PR #220 (card/dossier) ·
PR #221 (GAP-7/8/10).

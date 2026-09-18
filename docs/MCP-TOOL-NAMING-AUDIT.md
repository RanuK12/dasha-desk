# MCP tool naming & discoverability audit — Dasha Compute (task #17)

**Dated:** 2026-09-18. **Status:** AUDIT ONLY — no code changes, no renames shipped.
Renames are breaking changes (unknown tool name → JSON-RPC `-32602` under the
2026-07-28 revision, not an `isError` tool result) and are scheduled for the
Worker lane owner. This PR ships the audit report only.

**Scope.** The MCP server implementation lives in the Worker tree, which is not
cloned in this repo (see PR #221, GAP-10/11). This audit therefore inventories
the tools from the public, live tool surfaces: the static MCP catalog at
`https://www.getdasha.com/compute/mcp.json` (fetched 2026-09-18), the agent
skill at `https://www.getdasha.com/compute/skill.md`, and the mcpservers.org
listing (`www-getdasha-com-compute-mcp-json`, body verified 2026-09-13). All
three agree on the same five tools. There is no MCP server code in dasha-desk,
so the blast radius for any rename is entirely in the Worker tree + public
docs — nothing in this repo references these tool names (verified by grep).

## Tool inventory (verified live 2026-09-18)

| # | `name` | method | URL | auth | description |
|---|--------|--------|-----|------|-------------|
| 1 | `healthz` | GET | `…/compute/api/healthz` | none | "Coordinator health." |
| 2 | `models` | GET | `…/compute/api/v1/models` | none | "OpenAI-compatible model list." |
| 3 | `network` | GET | `…/compute/api/v1/network` | none | "Community Macs advertising." |
| 4 | `guest-keys` | POST | `…/compute/api/guest-keys` | none (3/hour/IP) | "Mint a 24h guest key. Copy once. Rate-limited." |
| 5 | `chat.completions` | POST | `…/compute/api/v1/chat/completions` | Bearer <redacted> | "OpenAI-compatible chat. Use base_url with the OpenAI SDK. Bearer <redacted>" |

None of the five carries a `title`. The catalog itself discloses: "Static MCP
catalog… Not a streamable MCP session."

## Rules applied

- **R1 — MCP spec naming (2025-11-25, carried into 2026-07-28).** Tool names
  SHOULD be 1–128 chars, SHOULD use only `[A-Za-z0-9_\-.]`, SHOULD be
  case-sensitive, SHOULD be unique within the server. Common format: snake_case
  (e.g. `search_users`).
- **R2 — Conflict-avoidance convention.** Include the service context in the
  name (`slack_send_message`, not `send_message`) so tools stay unambiguous in
  multi-server clients that merge tool lists.
- **R3 — Client compatibility.** OpenAI-API-style tool names must match
  `^[a-zA-Z0-9_-]+$` and stay ≤ 64 chars — **dots are not allowed**.
  Claude Code enforces a 64-char hard limit; Cursor silently filters tools when
  `server_name + tool_name` exceeds 60 chars.
- **R4 — 2026-07-28 revision.** A human-readable `title` is advertised alongside
  `name` for connector UIs; an unknown tool name returns JSON-RPC `-32602`
  (not an `isError` tool result). Renames are therefore breaking changes.
- **R5 — Tool-search era.** Clients defer schemas (Claude Code
  `defer_loading`); **tool names + server `instructions` are the discoverability
  lever**. Keyword coverage expected: inference, llm, mac, qwen, gemma, model
  ids (per PR #221 GAP-10).

## Findings

### V1 — `chat.completions` contains a dot — SEVERE (R3, R2, R5)

A dot in a tool name is spec-legal (R1) but client-hostile: the OpenAI API
pattern `^[a-zA-Z0-9_-]+$` rejects dots outright, so any OpenAI-API-compatible
client bridge, function-calling router, or name→identifier mapping layer will
drop or mangle this tool. The dot also collides visually with the OpenAI REST
path `chat/completions` and with dotted config-path conventions, and the name
carries zero Dasha/inference/Mac context (R2, R5).

- **Proposed rename:** `dasha_chat_completions`
- **Proposed `title`:** "Dasha chat completions"
- **Blast radius:** `mcp.json` catalog (Worker), skill.md prose, mcpservers.org
  listing body, any agent configs / docs pinned to `chat.completions`.

### V2 — `healthz`, `models`, `network`: generic bare names — MEDIUM (R2, R5)

Three of five tools are bare common nouns with no service context. In a
multi-server client (Claude Code, Cursor, any tool-search router) `models` and
`network` are among the most likely names to collide with another server's
tools, and tool-search for "mac inference providers" will never surface
`network`. `healthz` is equally anonymous. These pass R1/R3 but fail the R2
conflict-avoidance convention and R5 discoverability.

- **Proposed renames:** `dasha_health`, `dasha_models`, `dasha_network`
- **Proposed `title`s:** "Dasha coordinator health", "Dasha models list",
  "Dasha Mac network"
- **Blast radius:** `mcp.json` catalog (Worker), skill.md ("probing
  healthz/network/models"), mcpservers.org listing body.

### V3 — `guest-keys` is kebab-case and context-free — MEDIUM-LOW (R1-convention, R2, R5)

The only hyphenated name in a catalog that is otherwise dot/underscore-free;
R1's common format is snake_case and mixed styles read as accidental. The name
is verb-less ("Mint a 24h guest key" → lead with the verb) and carries no
service context (R2); agents searching "mint api key" / "guest key" get no hit
on the name itself (R5).

- **Proposed rename:** `dasha_mint_guest_key`
- **Proposed `title`:** "Mint Dasha guest key"
- **Blast radius:** `mcp.json` catalog (Worker), skill.md guest-key prose,
  mcpservers.org listing body.

### V4 — No tool carries `title` — MEDIUM (R4)

The 2026-07-28 revision advertises human-readable `title` alongside `name` for
connector UIs; connector surfaces that show titles will fall back to raw names
(`chat.completions`, `guest-keys`) — the worst possible display strings. This
is GAP-10's "backfill `title` on every tool" item. Fix is metadata-only,
non-breaking, and can ship independently of the renames.

### V5 — Descriptions are terse and keyword-poor — LOW-MEDIUM (R5)

In the tool-search era the description is the ranking text. Current copy and
what it misses:

| tool | current | missing keywords |
|------|---------|------------------|
| `healthz` | "Coordinator health." | dasha, mac, inference |
| `models` | "OpenAI-compatible model list." | llm, qwen, gemma, mac |
| `network` | "Community Macs advertising." | inference availability, provider, capacity |
| `guest-keys` | "Mint a 24h guest key. Copy once. Rate-limited." | api key, auth |
| `chat.completions` | "OpenAI-compatible chat. Use base_url with the OpenAI SDK. Bearer <redacted>" | inference, mac, model names |

Proposed copy lives with the rename table below. Description fixes are
non-breaking and can ship with V4.

### V6 — Coverage gap (informational, not a rename) — LOW

The skill.md documents endpoints the catalog never exposes as tools: `readyz`
(readiness), `pricing` (the pricing endpoint), receipt lookup/verify, and the
Hosted Ask lane (`POST /compute/api/chat`). A `dasha_pricing` tool would
arguably be the highest-value read-only addition for a paid inference API —
agents decide with price, and tool-search will never discover an endpoint that
isn't a tool. Worker lane decision; not part of the rename batch.

## Rename proposal (schedule as one breaking batch)

| current | proposed | `title` | why |
|---------|----------|---------|-----|
| `healthz` | `dasha_health` | Dasha coordinator health | R2 service context; R5 searchability |
| `models` | `dasha_models` | Dasha models list | R2: `models` is the highest-collision bare noun |
| `network` | `dasha_network` | Dasha Mac network | R2/R5: says what network of what |
| `guest-keys` | `dasha_mint_guest_key` | Mint Dasha guest key | snake_case (R1 convention), verb-led, R2 |
| `chat.completions` | `dasha_chat_completions` | Dasha chat completions | **R3: removes the dot**; R2/R5 context |

All proposed names are snake_case, dot-free, ≤ 64 chars, and (with a short
server name) inside Cursor's 60-char combined budget. **Do not ship the renames
alone:** coordinate with the GAP-8 legacy-posture decision — either
dual-register old names as aliases through a deprecation window, or cut over
with the card `version` bump per the Server Card hygiene rules (renaming a tool
is a card-versioning event, PR #220).

## Drafted server `instructions` (post-rename; keyword coverage)

> You are using Dasha Compute, a decentralized LLM inference network served by
> community Apple Silicon Macs, with an OpenAI-compatible API.
> `dasha_chat_completions` runs a chat completion (OpenAI v1 chat/completions)
> on a community Mac — available models include qwen3-8b, gemma3-12b,
> gpt-oss-20b, qwen3-30b-a3b, gemma3-27b, gpt-oss-120b; if no Mac advertises the
> requested model it fails loudly with `no_mac_online`, never silently.
> `dasha_models` lists available models with pricing.
> `dasha_network` shows which community Macs are advertising inference capacity.
> `dasha_mint_guest_key` mints a free 24-hour guest API key (3 per hour per IP)
> for chat and models.
> `dasha_health` checks coordinator health.
> Chat calls require a Bearer <redacted> key. Provider Macs can see prompts — never
> send sensitive data. Pricing is $0.05 per job + $0.01 per 1k completion tokens;
> a free tier covers low-volume use.

(Ship the `instructions` string with the renames; until then the same text keyed
to the current names is strictly better than no `instructions` at all.)

## What this PR does and does not do

- **Does:** ship this audit report. No doc in dasha-desk references the tool
  names, so there were no trivially-safe doc fixes to make here — the
  rename/backfill/`instructions` work all belongs to the Worker tree.
- **Does not:** rename anything, touch the live catalog, probe the live
  endpoint (tasks #47/#48, JOHN), or change the Server Card / registry dossier
  (PR #220) — those stay boolean on `capabilities.tools` until this audit's
  renames land (PR #221 GAP-10 gate).

**Related:** TASKS.md #17 (this audit) · #15/#16/#18/#20 · PR #220 (card +
dossier) · PR #221 (stateless gap analysis, esp. GAP-3 idempotency, GAP-7
unknown-tool semantics, GAP-8 legacy posture, GAP-10 naming).

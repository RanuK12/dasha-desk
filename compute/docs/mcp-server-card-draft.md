# MCP Server Card draft — Dasha Compute (task #16)

**Status:** DRAFT for review. Not deployed. Serving this card is a Worker change
and sits behind the deploy boundary (task #47) — it needs John's tap.

The card follows the **MCP Server Cards convention (SEP-2127)**: served as JSON
at `/.well-known/mcp/server-card.json` with `Content-Type: application/json`, and
it is written against the **2026-07-28 stateless revision** of the protocol.

## The JSON payload (copy-paste ready)

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  "name": "io.github.uuriko/dasha-compute-mcp",
  "version": "0.1.0",
  "title": "Dasha Compute",
  "description": "OpenAI-compatible inference served by idle Apple Silicon Macs. Query community LLMs (Qwen3, Gemma3, gpt-oss) over Streamable HTTP. Free tier for low-volume use; prepaid credits in USDC or $dasha. Alpha: providers can see prompts — non-sensitive workloads only.",
  "websiteUrl": "https://www.getdasha.com/compute",
  "repository": {
    "url": "https://github.com/Uuriko/dasha-desk",
    "source": "github"
  },
  "remotes": [
    {
      "url": "https://www.getdasha.com/compute/mcp",
      "type": "streamable-http"
    }
  ],
  "protocol": {
    "versions": ["2026-07-28"],
    "transports": ["streamable-http"],
    "stateless": true
  },
  "authentication": {
    "required": true,
    "note": "Free tier for low-volume use; prepaid USDC/$dasha credits beyond the free tier. Exact token scheme is on the live /compute page."
  },
  "capabilities": {
    "tools": true,
    "resources": false,
    "prompts": false
  },
  "contact": {
    "url": "https://www.getdasha.com/compute"
  }
}
```

### Fields marked TBD / confirm-before-deploy

- **`repository`** — this names dasha-desk because that is where this draft lives.
  But which repo owns the MCP docs is still John's call (task #37); the MCP
  server code itself is *not* in dasha-desk (the Worker tree is not cloned here).
  If the canonical home is elsewhere, the card's `name` and `repository` fields
  must change to match.
- **`remotes[].url`** — `https://www.getdasha.com/compute/mcp` is a placeholder
  endpoint. The mcpservers.org listing (slug
  `www-getdasha-com-compute-mcp-json`, badge already on this repo's README)
  confirms the server is listed, but the exact live endpoint URL was not
  reconfirmed in this draft. Do not serve the card with an unconfirmed URL —
  confirm against the live listing first.
- **`capabilities`** — `tools: true` reflects an MCP tool surface; the actual
  tool names/descriptions live in the Worker MCP implementation and are not
  visible from this repo. Live cards routinely omit per-tool detail; clients
  negotiate tools over the transport. The tool-name discoverability audit is
  task #17.

## How the card is served (for the deploy step)

1. Serve the JSON at **`/.well-known/mcp/server-card.json`** on `www.getdasha.com`.
2. Response headers: `Content-Type: application/json`, `Cache-Control: public, max-age=300`.
3. Add a discovery header on the main site so agents find the card without
   guessing the path: `Link: </.well-known/mcp/server-card.json>; rel="mcp"`.
4. Keep the payload in the Worker repo next to the MCP server code, not in
   dasha-desk, so it cannot drift from what the server actually does.

## Stateless-revision context (2026-07-28)

The card is metadata only; the breaking protocol changes land in the Worker
implementation (task #15 covers the migration brief; task #48 is the deploy +
credentials tap). The changes the card must be consistent with:

- **No protocol-level sessions.** `Mcp-Session-Id` is gone; any instance can
  serve any request. The card's `protocol.stateless: true` declares this.
- **No `initialize`/`initialized` handshake.** Every request carries protocol
  version, client info, and capabilities in `_meta`.
- **Required per-request headers** on every Streamable HTTP POST:
  `MCP-Protocol-Version: 2026-07-28` (must match `_meta`), `Mcp-Method`, and
  `Mcp-Name` on `tools/call`. Middleware that strips unknown headers will
  hard-break clients.
- **`server/discover` RPC** (servers MUST implement) advertises supported
  versions, capabilities, and self-reported server metadata — the runtime
  counterpart of this static card.
- **Tasks moved to an extension** (`io.modelcontextprotocol/tasks`, SEP-2663);
  long-running jobs use client-driven `tasks/get|update|cancel` polling, not the
  old experimental core Tasks API.
- **SSE resumability removed** — broken streams are re-issued by the client with
  a new request id, so Dasha tools should stay idempotent.
- **Deprecations with a 12-month runway (~mid-2027):** Roots, Sampling, Logging.
- Tighter OAuth 2.1 / OIDC alignment for HTTP auth.

Related task docs: #15 (stateless upgrade brief), #17 (tool naming audit),
#18 (NSA/CISA hardening checklist), #47 (serve the card), #48 (implement the
upgrade on the Worker).

## Card hygiene rules

- The card is self-reported metadata; it must never be a security decision for
  clients. Keep auth requirements and rate limits honest here or the card
  becomes a trust liability.
- Version the card with the server. Renaming a tool, changing the endpoint, or
  changing the auth model is a breaking change — bump `version` and re-check the
  card on deploy.

# Official MCP registry dossier — Dasha Compute (task #20)

**Status:** DRAFT for review. Submission to
[registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io) is
an account action under John's identity — **the submission tap itself is task
#38 (JOHN).** This dossier pre-fills every field so the tap is a paste job.

## Pre-filled `server.json`

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
  "name": "io.github.uuriko/dasha-compute-mcp",
  "description": "OpenAI-compatible inference served by idle Apple Silicon Macs. Query community LLMs (Qwen3, Gemma3, gpt-oss) over Streamable HTTP. Free tier for low-volume use; prepaid credits in USDC or $dasha.",
  "version": "0.1.0",
  "repository": {
    "url": "https://github.com/Uuriko/dasha-desk",
    "source": "github"
  },
  "websiteUrl": "https://www.getdasha.com/compute",
  "remotes": [
    {
      "url": "https://www.getdasha.com/compute/mcp",
      "type": "streamable-http"
    }
  ]
}
```

### Field notes (what's filled, what's not)

| Field | State | Detail |
| --- | --- | --- |
| `name` | DRAFT | Follows the registry's `io.github.<owner>/<server>` convention. ⚠️ Owner namespace binds to whoever authenticates (GitHub OIDC), see gaps. |
| `description` | READY | One sentence; mirrors the Server Card (task #16) copy. |
| `version` | DRAFT | `0.1.0` placeholder; must match the shipped server version at publish time. |
| `repository.url` | DRAFT | dasha-desk because the draft lives here — see gap #1. |
| `websiteUrl` | READY | Live page: `https://www.getdasha.com/compute`. |
| `remotes[].url` | **UNCONFIRMED** | Placeholder. The mcpservers.org listing (slug `www-getdasha-com-compute-mcp-json`) proves a live server exists, but its exact endpoint URL was not reconfirmed while writing this. The registry checks that the remote is publicly reachable — confirm the real endpoint before publish. |
| `packages[]` | **ABSENT** | No npm/PyPI/Go package exists for the Dasha MCP server. `remotes`-only listings are accepted, so this is not a hard blocker, but it is a gap if the registry flow expects a published package for ownership verification. |
| Auth / token scheme | **UNCONFIRMED** | The MCP endpoint's actual auth (API key, free-tier gating, OAuth) lives in the Worker tree, which is not in this repo. Confirm before writing auth hints anywhere public. |

## Submission checklist

1. [ ] **Repo ownership settled (John, task #37).** `server.json` must live in
   the repo whose GitHub identity publishes, and `name` must be
   `io.github.uuriko/<that-repo>`. If the MCP server code is in the Worker
   tree, `server.json` belongs there, not here.
2. [ ] **Live MCP endpoint URL confirmed** against the mcpservers.org listing
   and a live `server/discover` probe (2026-07-28 stateless wire).
3. [ ] **Auth model documented** (what the endpoint requires, free-tier limits).
4. [ ] **Stateless upgrade shipped** on the Worker (tasks #15/#48): required
   per-request headers, no session handshake, `server/discover` implemented.
5. [ ] **Server Card serving** at `/.well-known/mcp/server-card.json` (task
   #47) — points registries and agents at the same metadata.
6. [ ] **Version pinned** — `version` in `server.json` matches the shipped
   server.
7. [ ] `mcp-publisher` CLI installed:
   `curl -L https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s)_$(uname -m).tar.gz | tar xz`
   (or `brew install mcp-publisher`).
8. [ ] **John runs the tap** (task #38):
   ```bash
   mcp-publisher validate     # lint the manifest against the live schema
   mcp-publisher login github # GitHub OIDC; namespace binds to his identity
   mcp-publisher publish      # from the directory holding server.json
   ```
9. [ ] **Verify the listing:**
   `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=dasha"`
   — the server should appear with its `remotes` (streamable-http) entry.
10. [ ] **Re-publish on every version bump** — version drift between the registry
   entry, the Server Card, and the live server erodes agent trust. Make this a
   release-checklist line.

## Gaps found

1. **Which repo owns the MCP docs/server is unresolved (task #37, JOHN).**
   dasha-desk contains the docs but *not* the MCP server code (Worker tree is
   not cloned here). The registry binds the namespace to the publishing GitHub
   identity, so this dossier cannot be finalized until the canonical repo is
   named. The `name`/`repository` fields above assume dasha-desk only
   provisionally.
2. **No published package.** There is no npm/PyPI/Go artifact for the Dasha
   MCP server, so the registry entry would be `remotes`-only. Confirm with the
   live `mcp-publisher` schema at tap time whether that's still accepted for
   this server, or whether a lightweight published package is required.
3. **Live endpoint URL unconfirmed.** The exact public MCP endpoint (path and
   host) was not reconfirmed from this repo; the placeholder above must be
   replaced with the real URL from the mcpservers.org listing.
4. **Auth model undocumented from this repo's vantage point.** Free tier + paid
   credits are known from the /compute page, but the endpoint's actual token
   scheme is a Worker-side fact — verify before publishing anything agents will
   rely on.
5. **Stateless upgrade status unknown.** If the live server still runs the
   session-based wire, the registry entry should not promise `2026-07-28`
   support. Reconcile with tasks #15/#48 before publish.
6. **Brand sign-off (task #50, JOHN).** Name and logo usage on the official
   registry is a brand decision — John's call before the tap.

## After the official registry lands

Community indexes largely auto-ingest the official registry; submit manually
only where it buys a curated listing sooner: mcp.so, Glama, PulseMCP, Smithery,
the Awesome MCP Servers list (GitHub PR), Cursor MCP Directory, Anthropic
connector directory (needs the `remotes` entry).

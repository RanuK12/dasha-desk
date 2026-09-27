# MCP idempotency-key design — billed inference tools under stateless MCP

Status: design proposal (docs-only). Closes the design half of **GAP-3** in
`docs/MCP-STATELESS-GAP-ANALYSIS.md` (CRITICAL). The Worker-side implementation
lives in the Worker tree, behind the deploy boundary (TASKS.md #47/#48 — JOHN).

## Problem in one paragraph

The MCP 2026-07-28 revision deleted SSE resumability: when a stream breaks, the
client **re-issues `tools/call` with a new request id**. Request ids therefore
cannot be the dedupe key — they are new on every re-issue by design. Dasha
tools trigger *billed* work (provider Macs run inference, free-tier quota
burns, paid credits burn). Without a client-supplied idempotency key plus
server-side dedupe, a re-issued call mints a duplicate provider job:
double-charge, double quota burn, double provider payout, duplicate metering
records. This design is the contract both sides implement against.

## Key format

Opaque client-chosen string, one per logical operation:

- Recommended generation: UUID v7 (`uuidv7()`), or
  `dasha-idem-<uuidv7>` when a prefix helps log grep. Time-sortability is a
  nice-to-have for debugging; exact-string equality is the only semantic.
- Constraints: **8–128 chars**, charset `[A-Za-z0-9._~-]`, non-empty. Servers
  MUST reject out-of-spec keys with `-32602` (invalid params) before any
  dispatch — fail closed, never "fix up" a malformed key.
- Lifecycle: the client MUST generate one key per user-intended call and reuse
  the *same* key across all re-issues/retries of that call. A new user intent
  gets a new key. SDKs should expose `idempotencyKey` generation as a helper
  and persist the key for the lifetime of the retry budget.
- The key is **not** a secret; it may appear in logs, metering records, and
  task handles. It is scoped by the auth subject, so cross-tenant key reuse is
  meaningless by construction.

## Client contract

1. Every call to a **billed** tool carries `idempotency_key`. Carriage point:
   **tool argument** named `idempotency_key`, accepted as an alias in the
   JSON-RPC `_meta` object for clients that strip unknown tool args
   (`_meta.idempotencyKey` also accepted for SDK v2 camelCase clients).
   Server normalizes all three spellings to one canonical key; if both are
   present and differ, reject with `-32602`.
2. On re-issue (broken stream, timeout, transport retry) the client reuses the
   **same** key with the **same** arguments. Changing arguments under the same
   key is a client bug and is rejected (see Collision behavior).
3. The client SHOULD treat a 2026-07-28 stateless server as
   retry-at-most-with-same-key: bounded retry budget (e.g. 3 attempts), then
   surface to the user. Never generate a fresh key mid-retry to "get unstuck".
4. Read-only tools (`tools/list`, `server/discover`, status reads) do not need
   keys; servers MUST ignore a key there rather than error.
5. Migration behavior: before the enforcement flip (below), calls without a key
   still dispatch but the server attaches a `Dasha-Idempotency: none`
   diagnostic hint in the result `_meta` so integrators can see the exposure.

## Server dedupe: window, store, TTL

- **Dedupe scope:** `(auth subject, tool name, idempotency key)`. The auth
  subject is derived per-request from credentials (see GAP-4) — never from
  session state, which no longer exists. Tool name is part of the scope so the
  same key reused against a different tool fails closed rather than cross-
  dispatching.
- **Window/TTL:** **24 hours** from first sight. Rationale: longest expected
  billed job is minutes-to-an-hour (provider Macs, large-context runs); 24h
  covers client retry storms, delayed re-issues, and next-day debugging
  replays, while bounding storage. Entries expire silently; an expired key is a
  new operation.
- **Store:** a server-side atomic check-and-set keyed on the dedupe scope.
  Implementation is Worker-side (tasks #47/#48); the design requires atomicity
  because the failure mode is *concurrent* re-issue — two `tools/call`s with
  the same key landing at once must never mint two jobs. A Durable Object with
  SQLite storage (atomic insert-if-absent in one transaction) is the intended
  backing; Workers KV is **not** acceptable as the primary dedupe store (no
  atomic check-and-set under concurrency). Read replicas may serve completed-
  result replays.
- **Entry states:** `pending` (job dispatched, not finished), `complete`
  (result snapshot attached), `failed` (error snapshot attached, job not
  retried). A repeat key on `pending` MUST NOT dispatch a new job — return the
  pending status (or the task handle under the SEP-2663 tasks extension, per
  GAP-9). A repeat key on `complete` returns the stored result; on `failed`,
  returns the stored error (fail closed: the client retries with a new key if
  the failure was transient — document this in the error payload).
- **Argument hashing:** store `sha256` of the canonicalized non-key arguments.
  On repeat key, compare the hash; mismatch → collision error (below), match →
  safe replay. This is what makes replay safe: the server proves the repeat is
  the same call, not a different call reusing a key.
- **Payout/settlement tie-in:** the provider-job ledger and the settlement
  layer MUST key mints on `(auth subject, tool, idempotency key)` — never mint
  two payouts against one key, and never let the ledger diverge from the MCP
  dedupe store. If they are different datastores, the job-mint path goes
  through the dedupe store's atomic claim first.
- **Metering tie-in (task #24 / PR #219):** the canonical gateway usage record
  carries the idempotency key. Replays of a completed key MUST NOT append new
  usage rows; the first completion's record is the single source of truth.
  Analytics queries dedupe on the key where needed as a belt-and-suspenders
  rule.

## Collision behavior

| Case | Server response |
|---|---|
| Same scope, same arg-hash, state `pending` | Return pending status / task handle (GAP-9). No new job. |
| Same scope, same arg-hash, state `complete` | Return stored result byte-for-byte (with `Dasha-Idempotency: replay` in result `_meta`). |
| Same scope, same arg-hash, state `failed` | Return stored error; do not re-dispatch. |
| Same scope, **different** arg-hash | `-32602` invalid params, message: `idempotency key reused with different arguments` (client bug — fail closed). |
| Key malformed / >128 chars / bad charset | `-32602` before any dispatch. |
| Same key, different tool name or different subject | Treated as distinct operations (scope includes both). |

## Migration path

1. **Design + doc (this PR).** Worker team reviews; registry/card stay gated.
2. **Implement server-side** in the Worker tree (JOHN taps #47/#48):
   dedupe store, key normalization, replay paths, metering/payout tie-ins.
3. **Opt-in period (~30 days):** servers accept keys, dispatch without them,
   emit the `Dasha-Idempotency: none` hint. Client SDKs/docs add key
   generation. Monitor what fraction of billed calls arrive without keys.
4. **Enforcement flip:** billed `tools/call` without a valid key is rejected
   (`-32602`, message names the missing key). Announce in the card changelog
   and bump the card's `capabilities` note. Read-only tools unaffected.
5. **Load-test the dedupe path** (concurrent same-key storms, 24h TTL sweep)
   before any "exactly-once" language appears anywhere public.
6. **Retire the legacy no-key path** only after the enforcement flip has held
   for a full TTL window with zero production incidents.

## What the registry / Server Card must NOT promise until this is implemented

⛔ Registry promise gates (bind on PR #220 card and the task-20 dossier):

- Do NOT call the tools "safe to retry" or "idempotent" in any listing copy.
- Do NOT use the words "exactly-once", "no double billing", or "safe to
  re-issue" until: server dedupe is live, the 24h window and atomic claim are
  verified under concurrent re-issue load, and the metering tie-in is proven
  (no duplicate usage rows in a load-test replay).
- Do NOT describe a retry contract ("resend with the same key") in the card
  until the enforcement flip ships — documenting a contract the server doesn't
  enforce trains clients into a false sense of safety.
- Until then, the card's tooling section may only say: billed tools exist;
  clients should expect a future idempotency-key requirement. (This is the
  GAP-3 gate from the gap analysis, restated in card terms.)

## Open questions for the Worker team

- Exact backing for the dedupe store in the current Worker architecture (new
  Durable Object vs. extending an existing job-tracking DO).
- Where the argument-hash canonicalization lives (shared with gateway-side
  metering or duplicated).
- Whether the tasks-extension `tasks/get` polling responses should embed the
  idempotency key so a re-issued poll can be matched even if the client lost
  the task handle.

# OCM review — bugs, security/correctness, speed

**Date:** 2026-09-11  
**Reviewed commit:** `8be0520` (`main`, installer hardware-id naming, #187)  
**Reviewer:** Cloud Agent (Grok Bot lane), read-only of `ocm/`  
**Owner:** Graham (`mlgraham`). GRAHAM-INTEGRATE lock honored: no login-skin rewrite, no product refactor.

This is a **docs-only** report. No production code was changed. Do not merge #44. `dasha-lobby` was not touched.

`ocm/.gitignore` excludes `docs/` as an operator notebook. This file is force-added as a public review, the same way `PROVIDER-PROTOCOL.md` is tracked. It contains no hostnames, account ids, or credentials.

## Collision and mailbox

| Check | Result |
| --- | --- |
| Open Graham PRs (`author:mlgraham is:open`) | none |
| Open PRs mentioning `ocm` | none |
| #44 | closed historically; **do not merge** |
| Mailbox #167 | closed 2026-09-06 by Graham; he asked agents not to use that Conversation as a channel. This review did not reopen or comment there. |

## How this was checked

Independent read of `ocm/gateway/*`, `ocm/agent/*`, `ocm/scripts/*`, `ocm/tests/*`, and `ocm/docs/PROVIDER-PROTOCOL.md`. Findings below are from source, not from prior PR prose. Several helper modules (`quota.mjs`, `request.mjs`) exist on disk but are **not imported** by `server.mjs`.

Fleet hunt (2026-09-11T12:35Z): live GET of `/compute/ocm/provider/status` and `/provider/healthz` vs canonical `/healthz` and `/status`. See P2-14.

Commands not run as a merge gate: `cd ocm && npm test` was not required for a docs-only report. Existing tests already cover the “looks solid” items.

## Severity legend

| Sev | Meaning |
| --- | --- |
| P0 | Live credential leak, auth bypass, or billable double-clear under the current process model |
| P1 | Clear correctness/security hazard before money or external providers; should be next Graham work |
| P2 | Real gap, alpha-tolerable if documented; fix when touching that file |
| P3 | Hygiene, speed, or docs drift |

**P0 found: none.** Provider tokens are not in WebSocket URLs. Failover stops after the first client byte. Enrollment redeem is atomic on Postgres.

---

## Severity-ranked backlog

### P1

| ID | Title | Evidence | Suggested Graham fix |
| --- | --- | --- | --- |
| P1-1 | Concurrent chat requests can overdraw the same balance | `handleChat` checks `ledger.balance` once, then dispatches (`server.mjs:781-786`). `quota.mjs` implements in-process reservations for exactly this TOCTOU and is **never imported**. | Wire `QuotaReservations` into `handleChat` / `runJob`. Not a one-liner. |
| P1-2 | Chat handler never calls `normalizeChatRequest` | `handleChat` parses JSON and only requires `model` + non-empty `messages` (`server.mjs:788-794`). `request.mjs:56-80` rejects tools/multimodal/`temperature`, caps messages (128 / 256 KiB) and completion tokens (512). Callers can send huge or unsupported bodies that are silently ignored. | Call `normalizeChatRequest` and map `TypeError` → 400. One-file, but changes the public API surface — Graham-owned. |
| P1-3 | Ledger write failure after a committed response still returns success | `meter()` swallows `ledger.clear` errors (`server.mjs:876-884`). Streaming `onDone` still writes `[DONE]` and ends 200 (`940-953`). Later `balance()` fails closed via `#requireHealthy()`, but in-flight requests that already passed the gate can complete unrecorded. README already lists this as a hard gate. | Fail the process/health immediately; do not claim usage in the HTTP body if clear failed. Larger than one line. |
| P1-4 | No rate limits on signup, sign-in, enroll, or recovery | POSTs at `server.mjs:390`, `496`, `716`, `453` have no IP/account throttle. Recovery caps **outstanding links per account** at 3 (`460`), not requests per IP. Online guessing of `ocm_live_*` / `ocm_enroll_*` is unconstrained. | Reverse-proxy or in-process buckets. Larger. |
| P1-5 | Session HMAC secret can be the admin bearer token | `createGateway` default: `OCM_SESSION_SECRET \|\| OCM_ADMIN_TOKEN \|\| 'dev-session-secret'` (`server.mjs:248-250`). `session.mjs:26-27` replaces only the public `dev-session-secret` string with an ephemeral key. If session secret is omitted and admin token is set, the admin bearer **forges console cookies**. Deploy script writes both (`scripts/deploy-gateway.sh:56-57`) — this is a misconfig footgun, not a live proof. | Drop `OCM_ADMIN_TOKEN` from the fallback; refuse to start in production without a dedicated session secret. One-file, Graham-owned. |

### P2

| ID | Title | Evidence | Notes |
| --- | --- | --- | --- |
| P2-1 | Recovery credential in URL query string | Link is `https://${consoleHost}/recover/confirm?t=${rec.token}` (`server.mjs:461-462`). GET peeks (`469-471`). Provider WS correctly **refuses** query-string tokens (`995-998`). Recovery is the remaining credential-in-URL path (browser history, ALB logs, Referer). Feature is dark until `OCM_RECOVERY_ENABLED=1`. | Documented UX tradeoff. Move token to POST body or fragment when recovery is turned on. |
| P2-2 | Unhandled exceptions echo `err.message` to clients | `server.mjs:760-761`. Can leak driver/path text from admin JSON parse (`598`, `609`) or ledger. | Generic 500 + server log. One-file. |
| P2-3 | Admin bearer compared with `!==` | `server.mjs:594`. Credentials and session HMAC use `timingSafeEqual` (`accounts.mjs:57-60`, `session.mjs:45`). | Use `timingSafeEqual` on equal-length buffers. One-file. |
| P2-4 | Empty `OCM_INVITE_CODE` + any invite-box text grants tokens | Wrong-code check requires `inviteCode` truthy (`server.mjs:407-408`). Grant is `offered && (!inviteCode \|\| offered === inviteCode)` (`420-422`). If the env var is unset, typing anything in the invite field grants; leaving it empty does not. Credits are not money, but this is a silent grant bypass. | Grant only when a configured code matches. One-file. |
| P2-5 | Agent cancel does not send a terminal message | `agent.py:315-316` breaks the loop on cancel with no `done`/`error`. Gateway holds `host.inflight` until job timeout (`server.mjs:896-906`: 120s warm / 300s cold). `MAX_INFLIGHT_PER_HOST = 2` (`74`). Cancelled work can block routing. **Zero** `cancel` tests under `ocm/tests/`. Protocol gate #5 is therefore unevidenced. | Send `{t:"error", message:"cancelled"}` or clear inflight on cancel. |
| P2-6 | `--doctor` does not prove the MLX model is loadable | Doctor lists env-derived model names (`agent.py:403-408`, `214-218`). Install gate is “doctor passes” (`install.sh:349-350` region). First real job pays cold Metal load (~75s, `server.mjs:28-31`). | Optional `--doctor --load`, or fail if weights are missing. |
| P2-7 | Fresh install does not checksum `agent.py` | Gateway **serves** `/agent.py.sha256` (`server.mjs:646-657`). Installer checksums `install.sh` (`install.sh:539-542`) but fetches `agent.py` without `shasum -c` (`335-336`). Doctor build mismatch is informational (`agent.py:214-216`). | Mirror the installer checksum pin. |
| P2-8 | Install verify puts the provider token on curl argv | Enrollment uses `--data @-` on purpose (`install.sh:176-187`). Verify then does `-H "Authorization: Bearer $OCM_HOST_TOKEN"` (`254-257`). Local `ps` can see the token for the life of that curl. Same pattern in `ocm-agent-token`. | Curl config / netrc / stdin header. |
| P2-9 | CSRF on console POSTs is SameSite-only | All mutating forms (`console.mjs:197-201`, `326-329`) have no CSRF field. Cookie is `HttpOnly; SameSite=Strict` (`session.mjs:52-54`). Fine against classic cross-site POST; weak against same-site sibling / future cookie policy. | Per-session CSRF or Origin check. Not a login-skin rewrite. |
| P2-10 | Admin `/network` is unbounded HTML | `renderNetwork` dumps every account, host, funnel row, and recent request (`console.mjs:476-496`). Plus a second `ledger.summary()` after `stats()` already called it (`311`, `484`). | Cap/paginate. Speed + mobile. |
| P2-11 | `whatNext` HTML interpolates secrets unescaped | `renderSecret` escapes the primary `<code>` (`console.mjs:205-209`) but signup/recovery `whatNext` embeds `${cred.secret}` raw (`server.mjs:426-431`, `488-490`). Secrets are base64url today. | Escape or pass structured fields. |
| P2-12 | `ocm-agent-token` rewrites `agent.env` non-atomically | `grep` + redirect + `cat` (`install.sh:469-471`). Crash mid-write can truncate the env file. | `mv` from a same-dir temp, as the agent download already does. |
| P2-13 | Hosts advertise models before Metal load | Agent `hello` uses `RUNTIME.models()` without loading (`agent.py:347-353`). Gateway marks warm only after first chunk (`server.mjs:922-924`). Routing prefers warm hosts; overflow still hits cold (`MAX_INFLIGHT_PER_HOST = 2`). | Optional preload or a `ready` bit. Documented alpha, but it is the main consumer-latency cost. |
| P2-14 | `GET /provider/status` and `/provider/healthz` 404; agents probe the wrong paths | Gateway has no those predicates. Liveness is `GET /healthz` (`server.mjs:670-677`). Public HTML status is console `GET /status` (`378-380`) or `/console/status` on any host. API-host `GET /status` is deliberately 404 (`status-page.test.mjs:124-126`). Unmatched paths fall through to `no route for GET …` (`759`). Live 2026-09-11T12:35Z: www `/compute/ocm/provider/status` and `/compute/ocm/provider/healthz` → **404** `no route for GET /provider/status` (and `…/healthz`); `/compute/ocm/healthz` **200** `{"ok":true,"service":"ocm-gateway"}`; `/compute/ocm/status` **200** HTML. Same 404s on `api.ocm.getdasha.com` and `ocm.getdasha.com`. Route inventory lists `/healthz` and `/console/status` only (`route-inventory.test.mjs:41-62`). Provider guide nav links `/status`, not `/provider/status` (`console.mjs:199`). | **Either** add thin aliases (`/provider/status` → `renderStatus`, `/provider/healthz` → same JSON as `/healthz`) and declare them in the route inventory, **or** document the canonical URLs in the provider guide / `/provider` page so naive probes stop guessing. Do not invent a third health contract. See table below. |

#### P2-14 canonical URLs (agents and lobby proxy)

The live Worker prefixes OCM with `/compute/ocm` (`x-dasha-edge: compute-ocm`) and strips that prefix before the gateway. So `/compute/ocm/provider` is the recruiting guide (`/provider`), and `/compute/ocm/provider/status` is **not** “status of the provider page” — it is a non-route `/provider/status`.

| Intent | Canonical gateway path | Live (www prefix) | Do not use |
| --- | --- | --- | --- |
| Liveness JSON | `GET /healthz` | `/compute/ocm/healthz` (also `api.ocm.getdasha.com/healthz`) | `/provider/healthz`, `/compute/ocm/provider/healthz` |
| Public status HTML | `GET /status` on the **console** host; `GET /console/status` on any host | `/compute/ocm/status`, `ocm.getdasha.com/status` | `/provider/status`, `/compute/ocm/provider/status` |
| Public status JSON | `GET /v1/network` | `/compute/ocm/v1/network` | guessing under `/provider/…` |
| Provider guide | `GET /provider` (console) | `/compute/ocm/provider` | — |

`/status` on the **API** host is 404 by design (`status-page.test.mjs:124-126`). Probes that hit `api.ocm.getdasha.com/status` should use `/healthz` or `/v1/network`.

### P3

| ID | Title | Evidence |
| --- | --- | --- |
| P3-1 | `clearCookieHeader` omits `Secure` | `session.mjs:56-57` vs set-cookie `Secure` at `52-54`. |
| P3-2 | 401 credential failures retry forever at max backoff | `agent.py:382-397`. Operational noise after revoke/rotate. |
| P3-3 | `"401" in str(exc)` is a substring match | `agent.py:382`. |
| P3-4 | Dashboard calls `ledger.summary()` twice | `stats()` at `console.mjs:71`; `renderDashboard` calls it again at `311`. |
| P3-5 | Inline CSS + `no-store` on every HTML page | `STYLE` ~3.5 KB (`console.mjs:99-182`); `cache-control: no-store` (`server.mjs:218-222`) also on public `/status` and `/provider`. |
| P3-6 | Reflected `notice`/`error` query params | Escaped (`console.mjs:351-352`) so not XSS; still phishing UX via `/?notice=…` (`server.mjs:336-345`). |
| P3-7 | `/v1/provider/verify` returns account email | `server.mjs:709-710`. Requires a valid provider token; e2e asserts it. |
| P3-8 | Protocol doc still mentions a loopback query-token path | `PROVIDER-PROTOCOL.md:22`. Gateway comment says that fallback is **gone** (`server.mjs:995-998`). |
| P3-9 | README / server comment point at missing `ocm/docs` files | README “Start here” lists `ARCHITECTURE.md`, `BENCHMARKS.md`, `OVERLAP.md`, `AWS-ACCOUNT.md`. Only `PROVIDER-PROTOCOL.md` exists under `ocm/docs/`. `server.mjs:6` cites `docs/ARCHITECTURE.md`. |
| P3-10 | `socket-watch.sh` duplicate init; tracks only `hosts[0]` | `scripts/socket-watch.sh:41-51`. |
| P3-11 | Default agent token `host-dev-token` if env missing | `agent.py:37`. Doctor catches it; reconnect still hammers. |
| P3-12 | Agent `session()` has no JSON parse guard | `agent.py:355-356`. Malformed gateway frame crashes → reconnect. |
| P3-13 | Postgres ledger has no dedicated tests | Unique index + `ON CONFLICT` (`pg-ledger.mjs:36-38`, `162-190`) are production path when `DATABASE_URL` is set; suite uses JSONL `Ledger`. |

---

## What looks solid (do not “fix”)

These match the review focus and already have tests. Leave them alone under GRAHAM-INTEGRATE.

| Area | Evidence | Tests |
| --- | --- | --- |
| Failover only before first client byte | `committed` set on first stream write (`server.mjs:927-934`); loop exits on `outcome.committed` (`827`); non-stream commits only in `onDone` (`956-957`) | `e2e.test.mjs`, `stabilization.test.mjs:184+` |
| One settlement under racing terminal events | `claimSettlement()` state machine (`857-871`) | `stabilization.test.mjs:146-181` |
| Ledger idempotency by `jobId` | JSONL replay (`ledger.mjs:109-116`); PG unique index + conflict (`pg-ledger.mjs:36-38`, `162-190`) | `stabilization.test.mjs` (JSONL) |
| Accounting unhealthy → `balance()` fails closed | `#requireHealthy()` | `stabilization.test.mjs` |
| No provider tokens in WS URLs | Header-only (`server.mjs:995-998`); agent `extra_headers` (`agent.py:328-340`) | `stabilization.test.mjs`, `route-inventory.test.mjs`, `agent-smoke.py` |
| Session cookies | `HttpOnly; SameSite=Strict`; optional `Secure` (`session.mjs:52-54`); HMAC + `timingSafeEqual` (`38-49`); session bound to credential id; revoke clears live session (`server.mjs:328-334`, `587-589`) | `e2e.test.mjs` |
| Signup cannot takeover by email | `server.mjs:393-401`, `412-417` | `security-regressions.test.mjs`, `e2e.test.mjs` |
| Developer key ≠ provider token | WS rejects `ocm_live_` (`1017`); verify distinguishes kinds (`693-701`) | `e2e.test.mjs` |
| Enrollment: hashed, 15 min, atomic PG redeem, no oracle | `accounts.mjs:200-232`; installer stdin body (`install.sh:176-187`) | `enrollment.test.mjs`, `installer-security.test.mjs` |
| Revoke-by-id; labels exact match only | Console posts `credential_id` (`console.mjs:326-329`); `findByLabel` is `label = $2` (`accounts.mjs:275-286`); admin requires unique exact label (`server.mjs:627-638`) | `revocation.test.mjs` |
| XSS escaping of labels / emails / host ids | Shared `esc()` (`console.mjs:12-13`) | Indirect via status/funnel tests |
| Open redirects | Fixed relative `Location` only | `route-inventory.test.mjs` |
| Recovery (when enabled): no email oracle, GET peek, POST consume, 3-link cap | `server.mjs:443-467` | `recovery.test.mjs` |
| WS payload caps / binary rejection | `ws.mjs` | `security-regressions.test.mjs` |
| Secrets hashed at rest | `accounts.mjs:10-14` | `e2e.test.mjs` |
| Rejection logs token **shape**, never plaintext | `server.mjs:1005-1023` | `host-rejection.test.mjs` |
| Public `/v1/network` and `/status` carry no account identity | `server.mjs:738-754` | `route-inventory.test.mjs`, `status-page.test.mjs` |
| Warm-aware routing + cold job timeout | `WARM_TTL_MS`, `COLD_JOB_TIMEOUT_MS` (`28-31`, `71`) | `e2e.test.mjs` |
| Agent reconnect backoff + jitter | `agent.py:369-397` | Indirect via socket tests |
| Installer: token not in launchd argv; `agent.env` 0600 | `install.sh:355-368` | `installer-security.test.mjs` |
| `install.sh` update checksum | `install.sh:539-542` | `installer-security.test.mjs` |
| Mobile text-size-adjust / table wrap already considered | `console.mjs:103-129`, `175-180` | — |

JSONL `clear()` is check-then-append **without an await** (`ledger.mjs:109-121`, `appendFileSync`). In one Node process that is atomic. Do not “fix” it with a mutex unless the file I/O becomes async or multiple processes share one JSONL file. Production should keep using Postgres.

---

## Speed notes (document only)

| Surface | Observation | Backlog |
| --- | --- | --- |
| Model cold start | First tokens require MLX load (~75s called out at `server.mjs:28-31`). Agent does not preload (`agent.py` `_ensure` on first job). Gateway gives cold hosts 300s. | P2-6, P2-13. Preload is product, not a drive-by. |
| Warm routing | Works: first chunk sets `host.warm`; pick prefers warm. Saturation (`inflight >= 2`) still sends work to a cold host. | Capacity / preload, not a bug. |
| Cancel → slot leak | See P2-5. This is the cheapest routing-capacity win. | Agent terminal on cancel. |
| Socket reconnect | Exponential backoff + 30% jitter, cap 60s. Sound. 401s sit at max backoff forever (P3-2). | Exit after N 401s so launchd stops. |
| Console page weight | Viewport + `text-size-adjust` already present. Cost is inline CSS on every `no-store` response, large `/provider` `<pre>` blocks, and unbounded admin `/network`. | P2-10, P3-5. Extract `/assets/console.css` with a long cache for public pages only. |
| Dashboard ledger | Two `summary()` calls per view (P3-4). Cheap on JSONL; wasted on Postgres. | Reuse `stats()` payload. |
| Chat bounds | Unwired `MAX_OUTPUT_TOKENS = 512` and message caps (P1-2) are also a DoS/speed control. | Wire `request.mjs`. |

---

## Easier login / use (document only — implementation may be lobby proxy)

GRAHAM-INTEGRATE lock: **do not** restyle the OCM console login or invent a new auth product here. Notes for humans and agents:

1. **Sign-in is paste-a-developer-key**, not email+password. Landing shows Sign in and Create account side by side; people submit the wrong form. A lobby proxy that already has a session could mint/exchange a key and set `ocm_session` without changing OCM’s credential model.
2. Developer key field is `type="password"` + `autocomplete="off"` — password managers are discouraged. Agents cannot recover a lost key unless recovery is enabled.
3. Recovery (`OCM_RECOVERY_ENABLED`) ships **dark**. Lost-key is a dead end in default alpha.
4. Email on signup is a label, not proof (`accounts.mjs:34-37`). Recovery is the first mailbox check.
5. Keys and enrollment codes are shown **once**, no copy button. Closing the tab loses the only secret.
6. Provider path is already the easy one: enrollment code → installer stdin → machine-bound token. Keep that; do not revert to pasted `ocm_host_` in docs.
7. Agents have HTML forms + cookie for enroll/revoke/redeem. First-class REST is `/admin/*` (bearer) only. A lobby proxy should call admin or a future account API, not scrape the console.
8. Session lasts 12 hours (`session.mjs:19`). Revoking the key used to sign in also kills the browser session — correct, surprising.
9. `/provider` already contains the agent prompt in `<details>`. Installer still needs a human at the hidden prompt; full unattended enroll is not claimed.
10. **Health/status probes:** use `/healthz` and `/status` (or `/console/status`), not `/provider/status` or `/provider/healthz` (P2-14). A lobby proxy that only documents `/compute/ocm/provider` will keep attracting `/provider/status` guesses.

Lobby-proxy sketch (not in this PR): getdasha `/login` session → server-side `POST /admin/credentials` or a new `POST /v1/console/exchange` → `Set-Cookie: ocm_session`. That keeps OCM’s HMAC cookie and revoke-by-credential-id behavior.

---

## Recommended next Graham slices (smallest first)

Do not start these from this PR. Each is one claim.

1. **P1-5** session-secret / admin-token split (one file, deploy-script already correct).
2. **P1-2** wire `normalizeChatRequest` + tests for tools / oversized messages.
3. **P1-1** wire `QuotaReservations` + a concurrent-overdraw test.
4. **P2-14** thin `/provider/status` + `/provider/healthz` aliases **or** one sentence on the provider guide naming `/healthz` and `/status`. Cheap; stops fleet 404s. Do not change the `/healthz` JSON shape.
5. **P2-5** cancel → terminal + e2e (protocol gate #5).
6. **P2-4** invite grant only when a configured code matches.
7. **P2-7 / P2-8** installer: checksum `agent.py`; keep verify token off argv.
8. Rate limits (P1-4) at the ALB or a tiny in-process bucket — before inviting strangers to `/signin`.
9. Accounting fail-closed at the HTTP boundary (P1-3) before any money language.

---

## Hard gates still open (from README; this review agrees)

Before external provider traffic or money:

- Provider credentials never in WS URLs or proxy logs — **code path is clean**; rotate any historical URL-logged token (human).
- Usage clearing at-most-once under duplicate/racing terminals — **in-process settlement is tested**; PG unique index exists; **quota reservation is not wired**.
- Accounting fail-closed after committed-response write failure — **partial** (P1-3).
- Character/4 metering must be replaced before billing — still approximate (`server.mjs:85-95`).
- Community providers see raw prompts — unchanged trust boundary.
- No production deploy, payout, or Solana settlement from this stack.

---

## Why this PR is docs-only

The lock asked for a review report, and a tiny code PR only if there was a **clear P0/P1 with a 1-file obvious fix and no Graham PR collision**.

- No P0.
- The 1-file P1s (session-secret fallback, invite-grant footgun, `request.mjs` call) change startup or the public chat contract. That is Graham’s product lane.
- Wiring `quota.mjs` is more than one file.
- No open Graham PR to collide with; still not worth a drive-by.

No merge or deploy performed.

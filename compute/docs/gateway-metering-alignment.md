# Gateway-side metering alignment (task #24)

Cross-repo companion to the ocm-telemetry verified-billing program
(`~/workspace/tasks/ocm-telemetry/TASKS.md`, tasks #1–#50; reference repo
`Uuriko/dasha-ocm-telemetry`). It maps the compute/ kit's
**provider-reported** usage onto the blueprint's asks — real tokenizer,
gateway-measured tokens, cost-telemetry hook — with a phased cutover plan.
No code changes, no provider-term changes: alignment and interfaces only.

## 1. Terminology lock (shared with ocm-telemetry)

Both repos use these terms with these meanings; do not re-define them
locally:

| term | meaning |
|---|---|
| canonical usage record | gateway counts win; provider-reported numbers are carried as separate, never-trusted fields |
| discrepancy ratio | `(reported − gateway) / gateway × 100`, signed; positive = inflation |
| tolerance bands | per-model, from `tolerancesForModel()` (`src/tolerances.js` in ocm-telemetry): measured from the tokenizer eval, not guessed |
| residual exposure | `maxSubThresholdProfitPct(model)` — the largest inflation invisible to counts for that model |
| evidence package | per-job bundle: bytes-in, chunk boundaries + arrival times, stream finish, model, host — gateway-signed, hash-chained |
| never-trusted | every host-reported numeric is tagged untrusted at ingestion; billing paths read only gateway-measured fields |
| withheld | a figure that cannot be computed is null, never zeroed or silently estimated |

## 2. How the kit reports usage today (the gap)

- `compute/provider/agent.py` → `usage_from()`: `prompt_tokens` comes from
  Ollama's `prompt_eval_count`, `completion_tokens` from Ollama's
  `eval_count` — **self-reported by the provider's local Ollama**. Posted to
  the coordinator at `POST /v1/providers/jobs/{id}/result` as `usage`.
- `compute/coordinator/server.mjs` → `finalUsage()`: **prefers
  provider-reported usage**; falls back to a chars/4 estimate flagged with
  `X-Dasha-Usage-Estimated: true` so nobody mistakes it for measured data.
- Streaming: the provider posts `report_chunk(delta=content)` per chunk and
  a final chunk with `usage`; the coordinator relays SSE to the client and
  returns the accounted usage in the final chunk.

This is exactly the self-reported billing the ocm-telemetry program exists
to close: the coordinator bills (when billing exists) on numbers the host
supplies.

## 3. The mapping: kit fields → canonical record

| kit field (today) | canonical record field | trust status |
|---|---|---|
| `usage.prompt_tokens` (Ollama `prompt_eval_count`) | `provider_reported.input_tokens` | never-trusted |
| `usage.completion_tokens` (Ollama `eval_count`) | `provider_reported.output_tokens` | never-trusted |
| *(new)* count over the request bytes the coordinator shipped | `canonical.input_tokens` | trusted (gateway-measured) |
| *(new)* count over the streamed chunk bytes the coordinator relayed | `canonical.output_tokens` | trusted (gateway-measured) |
| `finish_reason` as observed by the coordinator | `stream_finish` | trusted (gateway-observed) |
| `X-Dasha-Usage-Estimated` chars/4 fallback | stays as the labeled fallback; shadow mode records it alongside, never as the canonical count | labeled, never billed |

The coordinator is the metering point: it terminates the client SSE
stream, receives every provider chunk, and ships the request bytes. No
new network hop is required — only recording what the coordinator
already sees.

## 4. Blueprint asks → kit touchpoints

### 4.1 Real tokenizer (ocm-telemetry task #5)

Gateway-side counting for the kit lives in `finalUsage()`'s successor:
input tokens are counted from request bytes with the model's real
tokenizer, or with calibrated chars/token while the tokenizer eval gate
(`billingReady()`, ocm-telemetry `src/tokenizer.js`) passes. The per-model
tolerance table (`tolerancesForModel`) supplies the discrepancy bands;
uncalibrated models keep conservative defaults and stay out of verified
billing.

### 4.2 Gateway-measured tokens + chunk-level metering (ocm-telemetry task #4)

The coordinator already observes every chunk via `report_chunk`. The
metering addition is recording per-chunk **arrival timestamp + byte
length** (not just relaying content), so the output token stream is
reconstructible independently of the host's final `usage` field. Design
notes the kit must respect: client-disconnect mid-stream (partial evidence
is still evidence), and failover re-dispatch dedup (retried chunks must
not double-count).

### 4.3 Cost-telemetry hook (dasha-desk task #25)

Provider cost telemetry (powermetrics joules/job) is emitted in the
provider **heartbeat**, not in `usage` — it is a separate channel with its
own privacy rule (no PII leaves the machine). Alignment rule: cost
telemetry stays provider-reported-but-labeled (stored, never billed —
the same rule the kit's `ttft_ms_host` analog follows) until a
gateway-side verification path exists for it. Billing reconciliation
reads only token counts.

## 5. Evidence-package format (shared with ocm-telemetry task #6)

The coordinator emits one bundle per job; field names match the
ocm-telemetry evidence package so either side can produce or consume:

```json
{
  "job_id": "…", "model": "qwen3-8b", "host_id": "…",
  "bytes_in": 12345,
  "chunks": [{"seq": 0, "bytes": 87, "arrived_at": "2026-09-17T22:00:00.000Z"}],
  "stream_finish": "stop",
  "provider_reported": {"input_tokens": 900, "output_tokens": 1200},
  "gateway_signature": "…", "prev_hash": "…"
}
```

`stream_finish` uses the ocm-telemetry vocabulary (`stop`, `length`,
`truncated`, `client-disconnect`, `failover`).

## 6. Phased cutover (mirrors ocm-telemetry tasks #28/#29)

- **Phase 1 — Shadow.** The coordinator dual-writes gateway-measured and
  provider-reported columns per job (one atomic write); zero billing
  impact, zero provider-term changes. Operator-only discrepancy dashboard
  using the shared tolerance bands. Entry: John's tap (ocm-telemetry
  task #31).
- **Phase 2 — Discrepancy review.** Per-host scorecards from shadow data;
  dispute process defined. Provider terms amended with the audit right
  (tasks #32/#33 — John's taps).
- **Phase 3 — Verified billing.** Payouts computed from gateway-verified
  counts. John's explicit approval + date + rollback plan (task #36).
- **Kill switch:** a single config flag stops the meter; column-drop
  cleanup returns the schema to pre-shadow shape.

The alpha kit has no billing yet — the shadow ledger is the accounting
that future billing will trust, which is why the alignment lands now,
before money exists.

## 7. Open questions (for John / review)

1. Retention window for prompt-byte evidence (ocm-telemetry task #47) —
   bytes are user PII with a retention clock.
2. Shadow start date (task #31).
3. Whether the meter lives in the coordinator process or a sidecar
   (ocm-telemetry task #18).
4. Per-category eval-gate trigger: qwen3-8b's CJK counting error (24.6%)
   exceeds ±10% while the overall eval passes — retire chars/token for
   CJK-heavy traffic, or gate on the overall figure only?

## 8. Consistency statement

Written against ocm-telemetry PRs #2 (reconcile), #3 (shadow-mode), #4
(red-team simulator) and the task-#30 tolerance calibration
(`src/tolerances.js`) + task-#13 fingerprint probe interface
(`src/fingerprint.js`): same terminology (§1), same evidence-package
format (§5), same tolerance language (per-model bands, residual
exposure). Where this doc and the ocm-telemetry specs disagree, the
ocm-telemetry spec wins and this doc gets a correction PR.

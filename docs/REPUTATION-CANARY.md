# Reputation & canary sampling design v2

Status: design doc, ready for review. No code changes proposed here; phases are
ordered so each one ships independently.

Scope: the `compute/` kit coordinator (`compute/coordinator/server.mjs`) and
provider agent (`compute/provider/agent.py`) — the architecture that is live
today. The `ocm/` stack gets the same treatment as a follow-up once one future
stack is declared (see the OCM blueprint audit).

## 1. Problem

The OCM blueprint audit found trust staging stops at invite-only:
account-bound + machine-bound tokens, and nothing else. Concretely missing:

- **Canary/duplicated sampling** — a host can return whatever it likes and the
  coordinator has no independent check.
- **Reputation with stake** — the coordinator keeps no per-provider history at
  all. Today `server.mjs` stores providers in an in-memory map with only
  `id`, `name`, `models`, `hardware`, and `lastSeenAt` (30s freshness window).
  Lease assignment is first-eligible-provider-wins from `Map` iteration order.
- **Usage honesty** — billing still trusts provider-reported `result.usage`
  (with a chars/4 fallback flagged `X-Dasha-Usage-Estimated`).

The audit's ranked fix is explicit: *"Add the trust-staging middle rung:
duplicated sampling. Canary requests duplicated across two hosts with output
comparison, logged to the ledger."* This doc turns that into a buildable plan.

Design constraints (non-negotiable):

- Invite-only staging stays. Nothing here opens the network.
- The trust boundary does not move: per `compute/THREAT_MODEL.md`, the
  provider process and the person controlling that machine can read prompts
  and outputs. Canary probes must be designed for that world, not pretend
  otherwise.
- No new PII leaves a provider machine. Scores are computed coordinator-side.

## 2. Sampling rate (concrete)

- **Duplicated-sampling rate: 2%** of eligible completed jobs, sampled at
  lease time (not at result time, so the provider cannot condition on it).
- **Coverage floor:** every provider seen in the last 24h gets at least one
  canary pair per rolling 24h window, even on quiet days. The floor dominates
  when 2% of volume rounds to zero.
- **Eligibility:** non-streaming jobs only in v1 (stream comparison is a
  harder problem and belongs in v3). A canary pair requires **two online
  providers** supporting the same public model id; single-provider models are
  scored on deterministic probes only (section 4).
- **Spend cap:** canary work is paid at the normal rate card ($0.05/job +
  $0.01/1k completion tokens), so 2% duplication costs ≈2% of job spend plus
  the floor. The coordinator enforces a daily canary budget; when it is
  exhausted, sampling pauses and the pause is logged.

## 3. Canary job injection (indistinguishable by construction)

- The coordinator marks the job **server-side only**: `job.canary = {
  probeId, nonce }`. The wire shape `publicJob()` already strips jobs down to
  `{ id, model, messages, temperature, max_tokens, stream }`, so as long as
  canary metadata is never added to `publicJob()`, there is **no wire marker**
  for a provider to detect. Canary jobs are byte-identical in shape to normal
  jobs.
- Pairing: the coordinator leases the same canary prompt to two eligible
  providers as two independent jobs (normal lease flow, 90s leases,
  `cleanupLeases()` expiry semantics unchanged). The second lease is issued
  only after the first provider's identity is committed, so neither provider
  can observe the pairing.
- Deterministic probes run with **temperature forced to 0** and a fixed
  `max_tokens`, so identical stacks should produce near-identical output.
- Rotation: the probe set is versioned (`canary-probes/vN.json`); prompts
  rotate out after first exposure to any given provider, so a provider cannot
  memorize answers. Pairing partners are chosen randomly among eligible
  providers.

Why duplicated real-shape jobs instead of a separate probe endpoint: a
separate endpoint is trivially detectable and gameable. The whole point is
that the provider cannot tell.

## 4. Scoring

Each canary pair produces three numbers, all coordinator-side:

1. **Correctness** — deterministic probes (arithmetic, code evaluation, JSON
   transforms with known answers): normalized exact match after
   whitespace/case folding. Open-ended probes: cosine similarity of a
   coordinator-computed embedding against the reference embedding, plus a
   length-sanity band. Pairwise agreement between the two providers is
   recorded separately from agreement with the reference.
2. **Honesty** — drift between provider-reported `usage.total_tokens` and the
   coordinator's chars/4 estimate on the same job. Occasional drift is
   expected (estimates are crude); *systematic* under/over-reporting flags.
3. **Availability/speed** — already observable: poll freshness (30s window),
   lease-expiry rate, and tokens/sec from reported usage over wall time.

Per-provider record (in-memory v1, persisted v2):

```
providerScore = {
  correctnessEwma,   // α = 0.1 per canary outcome, seeded 0.5 (neutral)
  pairAgreementEwma,
  honestyDriftEwma,
  leaseExpiryRate,
  speedEwma,         // tokens/sec
  canariesSeen,      // count, for confidence weighting
  quarantined        // bool + reason
}
```

New providers start neutral (0.5), not trusted: neutrality plus the coverage
floor means a new provider is probed before it earns meaningful volume.

## 5. Canary ledger

Every canary outcome is appended to a coordinator-side append-only log
(`canary-ledger.jsonl`, one JSON object per line):

```
{ ts, probeId, probeVersion, model, providerA, providerB,
  scoreA, scoreB, pairAgreement, honestyDriftA, honestyDriftB, leaseExpired }
```

The ledger is the audit's "logged to the ledger" requirement. Prompt text
is *not* written to the ledger — only `probeId` (the probe set itself is the
record of what was asked). v2 can hash outputs for dispute evidence without
storing them.

## 6. Bond/stake sketch (phase 2, sketch only)

Reputation alone handles mistakes; stake handles malice. Sketch, not spec:

- Stake is a **$dasha bond posted to escrow**, held in a treasury-less pool
  contract in the style of the settlement v2 design (anyone funds, rage-quit
  always available on uncommitted funds, no operator custody). Slashing is
  only on **provable** canary failure — i.e., a deterministic probe both
  providers in the pair got wrong in the same way is evidence of nothing;
  one provider diverging from reference *and* from its pair on a
  deterministic probe, repeatedly, is evidence.
- Slashing requires a dispute window (stake-weighted duels per the
  settlement v2 governor sketch) — the coordinator's score is advisory, the
  contract is decisive.
- Caps: slash per incident ≤ 10% of bond; total slash ≤ bond; bond floor set
  so the bond exceeds one day's expected canary earnings (otherwise gaming
  is profitable).
- Phase 1 ships **stake-free**: reputation and quarantine only. Stake enters
  as a pilot after the scoring has a month of ledger history to calibrate
  against.

Open questions: bond denomination, who holds the dispute keys, whether the
ledger is public.

## 7. How results feed provider ranking

Scores drive three coordinator behaviors, in this order:

1. **Lease assignment.** Replace first-eligible-wins with
   score-weighted choice among eligible providers: providers above the
   correctness floor (0.4) split traffic proportional to
   `correctnessEwma × availability`, with a small exploration fraction (5%)
   reserved for neutral/new providers so the ranking cannot ossify.
2. **Quarantine.** A provider whose `correctnessEwma` drops below 0.4, or
   whose honesty drift exceeds 3× the fleet median for a full day, stops
   receiving leases until an operator reviews. Quarantine is a lease-side
   refusal — the provider still polls, still sees 204s, and the reason is
   operator-visible, not provider-visible (no new wire surface to game).
3. **Network surface.** `GET /v1/network` already reports `providers_online`
   and `models_available`; v2 adds a `trust_tier` per model (e.g.
   `established` when ≥2 non-quarantined providers with ≥20 canaries each
   support it). The console renders the tier. No per-provider scores are
   published — scores are coordinator-internal to avoid targeted gaming.

What this does *not* do: it does not change the trust boundary (prompts
remain visible to providers), it does not verify hardware claims, and it
does not replace the invite-only gate. It is the middle rung, not the top.

## 8. Anti-gaming notes

- Indistinguishability is the whole defense: no wire marker, same lease
  flow, same timeouts, random pairing, rotating probes.
- Pair disagreement where *both* providers miss the reference is scored as
  a probe problem (probe retired), not a provider problem.
- The honesty metric uses the coordinator's own estimate, which is crude —
  so it only fires on systematic drift, never on a single job.
- Synthetic probes (not duplicated real user jobs) are used for canary
  content in v1, so canary sampling never doubles a real user's prompt
  exposure across providers.

## 9. Rollout

- **Phase 0 — shadow scoring.** Implement the score record and ledger;
  sample and score, but change nothing about lease assignment. Calibrate
  thresholds against real data.
- **Phase 1 — live duplicated sampling + quarantine floor.** 2% sampling,
  coverage floor, score-weighted lease assignment, quarantine below the
  floor.
- **Phase 2 — stake pilot.** Bond escrow per section 6, calibrated from the
  phase-1 ledger.
- **Phase 3 — stream canaries + published tiers.** Tackle stream-job
  comparison and surface trust tiers on `/v1/network`.

Each phase is independently shippable and independently revertible. Phase 0
is a pure-addition coordinator change: no provider agent changes required
(the provider already reports everything scoring needs).

## 10. Review questions for the maintainer

1. Is 2% + the 24h coverage floor the right sampling budget, or should the
   floor be per-model rather than per-provider?
2. Should the canary ledger be public (transparency) or operator-only
   (probe-set secrecy)? Note prompt text is never in the ledger either way.
3. For the phase-2 bond: $dasha-denominated with the +10% payout bonus
   economics, or a stable denomination? Who holds dispute keys?
4. Does score-weighted lease assignment need John's sign-off as a routing
   policy change, or is it inside the coordinator's normal discretion?

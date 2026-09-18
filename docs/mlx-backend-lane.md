# MLX backend lane — provider agent design

Task #9 of the dasha-desk 50-task sprint (`~/workspace/tasks/dasha-desk/TASKS.md`).
Design-doc only. No code changes in this PR; implementation is a follow-up.

**Why.** Live Mac supply is Dasha Compute's binding constraint. The cheapest
speedup available on Apple Silicon in 2026 is the MLX inference path:
Ollama's own numbers show ~1.6x prefill and ~2x decode over its GGUF/Metal
path, and the vllm-mlx research paper shows 21–87% higher throughput than
llama.cpp on Apple Silicon. The live `/compute` Provide page already tells
providers **"Prefer MLX when you can · Ollama ≥0.33.1"** — this design makes
the provider agent actually do that.

## 1. Core design decision

**Two MLX lanes, one backend interface, Ollama-first.**

- **Phase 1 lane — Ollama with MLX weights (`DASHA_BACKEND=mlx`).** No new
  process to supervise. Ollama ≥0.19 can pull and serve MLX-optimized model
  weights through its existing daemon on `OLLAMA_URL`; the agent keeps
  speaking the same `/api/chat` protocol. This is the lane the live page's
  "Prefer MLX" directive already points at, and it's what most providers
  will run.
- **Phase 2 lane — standalone `mlx_lm.server` process.** For models outside
  Ollama's MLX weight matrix (e.g. `gpt-oss` family) and for higher-memory
  Macs that want an always-resident OpenAI-compatible server. The agent
  supervises the subprocess on `DASHA_MLX_URL` (default `http://127.0.0.1:8080`).
- **Fallback is a hard rule, not a hope:** every MLX lane degrades to the
  current GGUF/Ollama path when the MLX weight, memory gate, or server is
  unavailable. Jobs never hard-fail on backend selection; they hard-fail
  only when every path is exhausted.

Ollama's MLX support matrix (mid-2026) covers Qwen 3/3.5/3.6 (incl. MoE
variants), Gemma 3/4, Llama, Mistral, Phi, and GLM-4 MoE; `gpt-oss` is not
in it. That's why Phase 2 exists.

## 2. Backend abstraction (agent.py)

Introduce a small `InferenceBackend` interface; the existing Ollama functions
become its first implementation.

```python
class InferenceBackend:
    name: str                      # "ollama" | "ollama-mlx" | "mlx-server"
    def run(self, job) -> dict: ...            # non-streaming; returns provider result shape
    def stream(self, job, cancelled) -> bool: ...
    def installed_models(self) -> set[str]: ...
    def doctor_check(self) -> tuple[str, str]: ...  # ("ok"|"warn"|"fail", detail)
    def backend_report(self) -> dict: ...           # for poll-payload hardware reporting
```

Migration sketch, no behavior change when unset:

- `run_ollama` / `stream_ollama` / `installed_models` move into
  `OllamaBackend` verbatim; `main()` constructs the backend from the env
  contract below and calls `backend.run(job)` / `backend.stream(job, cancelled)`.
- `benchmark()` gains a `backend` field per row (aligns with task 11's
  `benchmark.json` schema) and TTFT measurement via a streamed request.
- `doctor()` gains a `backend` section: chip, unified-memory gate, Ollama
  version MLX-capability, per-model weight kind (mlx vs gguf), standalone
  server health when Phase 2 is on.
- The poll payload's `hardware` report gains `backend`, `backend_detail`
  (e.g. `mlx-weights` vs `gguf-fallback`), so the coordinator can prefer
  MLX-capable providers for latency-sensitive jobs (future task; Phase 4).

## 3. Environment contract

| Variable | Default | Meaning |
|---|---|---|
| `DASHA_BACKEND` | `ollama` | `ollama` (current GGUF path) or `mlx` (Phase 1: Ollama daemon with MLX weights) |
| `DASHA_MLX_SERVER` | `off` | `on` enables the Phase 2 standalone `mlx_lm.server` process |
| `DASHA_MLX_URL` | `http://127.0.0.1:8080` | Base URL of the supervised mlx-lm server |
| `DASHA_MLX_PORT` | `8080` | Port for the supervised server |
| `DASHA_MLX_MODEL_MAP` | unset | `public=hf-repo-id` pairs for Phase 2 (e.g. `gpt-oss-20b=mlx-community/gpt-oss-20b-bf16`) |
| `DASHA_BACKEND_FALLBACK` | `ollama` | Reserved: always falls back to Ollama GGUF; no other value honored |

`run-provider` / `dasha-compute` must export the new vars (they currently
export a fixed list: `DASHA_COORDINATOR_URL DASHA_PROVIDER_ID
DASHA_PROVIDER_KEY DASHA_MODEL_MAP DASHA_BENCHMARK_PATH`); `install.sh`
must write `DASHA_BACKEND` into `provider.env`. Detection logic:

1. Apple Silicon check: `platform.machine() == "arm64"` on macOS.
2. Memory gate: ≥32 GB unified memory (Ollama 0.19's MLX hard requirement).
3. Ollama version ≥0.19 via `GET /api/version` (repo already asks for ≥0.33.1).
4. Per-model MLX weight presence: `ollama show <tag>` / tags listing
   inspected for the MLX weight marker; missing → that model serves GGUF
   with a `doctor --mlx` pull hint (`ollama pull` of the MLX tag).
5. If any of 1–3 fail, `DASHA_BACKEND=mlx` behaves as `ollama` and the
   poll payload reports `backend_detail: "gguf-fallback:<reason>"`.

Streaming over mlx-lm's OpenAI-compatible endpoint uses SSE
`/v1/chat/completions`; chunk mapping reuses `report_chunk` as-is
(`delta`/`done`/`usage`), with `usage_from` adapted to OpenAI `usage`
fields.

## 4. Process supervision (Phase 2)

`mlx_lm.server` is launched as `subprocess.Popen([sys.executable, "-m",
"mlx_lm.server", "--model", <repo>, "--host", "127.0.0.1", "--port",
<DASHA_MLX_PORT>])`, one supervised process per mapped model (the reference
`mlx_lm.server` is single-model; multi-model routing is out of scope for
Phase 2 — the agent restarts the process when switching models).

- Readiness: poll `GET /health` until 200 (30s budget), then mark backend ready.
- Restart: crash → log stderr tail, exponential backoff (5s→60s), resume.
- Shutdown: agent SIGINT/SIGTERM handler terminates children first; the
  LaunchAgent plist already routes provider stdout/stderr to
  `~/Library/Logs/Dasha Compute/`, so server logs are captured without
  new files.
- Port conflict: if `DASHA_MLX_PORT` is taken by an existing `mlx_lm.server`
  (matching model), attach to it instead of launching a second one.
- Job failure while the server is up but erroring: 2 consecutive inference
  errors → backend marked degraded, agent falls back to Ollama for the next
  job and reports `backend_detail: "mlx-degraded"`.

Note: the `mlx-lm` Python package must be installed in `DASHA_PYTHON`.
`install.sh` should detect-and-offer (`pip install mlx-lm` into the agent
venv) rather than hard-require, keeping the base install light for
GGUF-only Macs.

## 5. Model catalog mapping (MLX lane)

Public ids are the coordinator-facing ids from `DASHA_MODEL_MAP`
(`qwen3-8b`, `gemma3-12b`, `gpt-oss-20b`, `qwen3-30b-a3b`, `gemma3-27b`,
`gpt-oss-120b`). Throughput multipliers are source-anchored estimates —
all numbers below are **relative to the GGUF/Ollama baseline on the same
chip** and need [MAC-VERIFY] confirmation (section 8).

| Public id | MLX weights in Ollama matrix | Expected MLX gain | Memory tier notes |
|---|---|---|---|
| `qwen3-8b` | Yes (Qwen 3) | ~2x decode, ~1.6x prefill | 32GB+ MLX; 8/16GB stays GGUF (memory gate) |
| `gemma3-12b` | Yes (Gemma 3) | ~2x decode, ~1.6x prefill | 32GB+ MLX; ~8GB weights @4-bit |
| `gpt-oss-20b` | No (gpt-oss outside matrix) | Phase 2 only (~1.5–2x via mlx-lm) | 32GB+; community MLX export needed |
| `qwen3-30b-a3b` | Yes (Qwen 3 MoE) | ~2x decode on MoE-heavy workloads | 64GB+ recommended (MoE @4-bit ≈ 17GB, headroom for KV) |
| `gemma3-27b` | Yes (Gemma 3) | ~2x decode | 64GB+ recommended |
| `gpt-oss-120b` | No | GGUF only for now | 96GB+ tier; ~60–80GB @4-bit, no Ollama MLX weights |

Anchors:

- **Ollama official (Mar 2026, via MacRumors/AppleInsider):** prefill
  1,154 → 1,810 tok/s (~1.57x), decode 58 → 112 tok/s (~1.93x); requires
  >32GB unified memory; Qwen3.5-first at launch.
- **Independent lab (Sep 2026, M3 Max 128GB, Ollama 0.20.5):** decode
  36.72 → 78.97 tok/s (**~2.15x**, tight variance across trials); warm-cache
  prefill up to ~7.3x (67 → 1,495 tok/s as KV cache warms). MLX's real win
  compounds in multi-turn/agentic workloads that reuse context.
- **vllm-mlx paper (arXiv:2601.19139, Jan 2026):** 21–87% higher throughput
  than llama.cpp across 0.6B–30B models; up to 525 tok/s on M4 Max; 4.3x
  aggregate throughput at 16 concurrent requests with continuous batching.
- **panbanda/mlx-server (M4 Max 128GB, single-request decode):** mlx_lm vs
  llama.cpp — Llama-3.2-1B-4bit 421 vs 314 tok/s; Qwen3-1.7B-4bit 293 vs
  216; Qwen3-30B-A3B-8bit 86 vs 83.

## 6. Quantization guidance (MLX lane)

- **Default: MLX 4-bit.** Matches Ollama's GGUF Q4 default footprint and
  keeps decode memory-bandwidth-bound in the same regime.
- **NVFP4 where offered** (Ollama 0.19+ MLX preview): reported accuracy
  retention with lower bandwidth than 4-bit — prefer when the tag exists.
- **8-bit** only when the provider has headroom and the coordinator flags a
  quality-sensitive job class; ~2x the weight memory for single-digit
  quality points.
- **Quality data point:** vlm-bakeoff (Apple M5 Max, Aug 2026,
  ScreenSpot-v2 full 1,272-item set) — MLX 4-bit macro avg 79.7 vs bf16
  80.8: 4-bit keeps nearly all of bf16 quality at half the time. GGUF Q4_K_M
  scored 77.1 on the same protocol.

(Complements task 13's quantization guidance doc; task 12's memory-tier
catalog is the consumer of the table in section 5.)

## 7. Fallback rules (exact)

1. `DASHA_BACKEND=mlx` requested but Ollama <0.19 / not Apple Silicon /
   <32GB → serve as `ollama` (GGUF), report `gguf-fallback:gate`.
2. MLX weights missing for a mapped model → serve that model GGUF,
   report per-model weight kind; `doctor` prints the pull command.
3. Phase 2 server fails readiness or degrades (2 consecutive errors) →
   jobs route to Ollama for the remainder of the session, report
   `mlx-degraded`; recover on next agent restart.
4. Any backend raising on a job → error is reported to the coordinator
   exactly as today (`provider inference failed: <Type>`); the backend
   selection itself is never the reported failure reason.
5. `--doctor` exits nonzero under the same rule as today (coordinator,
   backend, or any configured model unavailable), extended with the
   backend section in section 2.
6. The mlx-lm standalone server binds 127.0.0.1 only. It never accepts
   LAN traffic; the coordinator path is unchanged (outbound polling).

## 8. [MAC-VERIFY] — benchmarks to run on a real Mac

Run on at least one machine per chip tier (M1 base 16GB for the GGUF
control, M2/M3 32GB+, M4 64GB+ for MLX) before Phase 1 ships:

- [ ] Per model × backend × chip: decode tok/s, prefill tok/s, TTFT
      (`dasha-compute benchmark --json` with the `backend` field; task 11).
- [ ] Streaming chunk-parity: same prompt via `ollama` and `ollama-mlx`
      lanes, first-token and final-content diff logged (must be empty
      at temperature 0 modulo sampling nondeterminism).
- [ ] Memory gate: MLX lane on a <32GB Mac must auto-fallback to GGUF
      with `gguf-fallback:gate` in the poll payload — assert the report,
      not just the speed.
- [ ] Phase 2: server crash during a job → job routes to Ollama, provider
      stays up, `mlx-degraded` reported; restart → server re-attaches.
- [ ] Power: powermetrics joules/job per backend (feeds task 25
      cost-telemetry) — MLX is expected to be cheaper per token, which
      matters for the earnings calculator (task 6) MLX toggle.

## 9. Rollout phases

- **Phase 0 — this doc.** Review + merge.
- **Phase 1 — Ollama MLX lane.** `InferenceBackend` ABC, `OllamaBackend`
  refactor, `DASHA_BACKEND=mlx` via MLX weights, doctor/benchmark backend
  sections, install.sh/provider.env/run-provider env pass-through.
  [MAC-VERIFY] items 1–3 green before merge of the implementation PR.
- **Phase 2 — standalone mlx-lm server.** Subprocess supervision, port
  management, per-model mapping, [MAC-VERIFY] item 4. `gpt-oss-20b`
  becomes the first Phase-2-only model.
- **Phase 3 — vllm-mlx evaluation.** Task 14's spike (continuous batching,
  prefix caching) decides whether the lane adopts vllm-mlx for
  multi-request workloads; the paper's 4.3x aggregate number is the
  bar to reproduce on our Macs.
- **Phase 4 — coordinator routing.** Use the new `backend` poll fields to
  prefer MLX providers for latency-sensitive jobs. Requires Worker-side
  work (deploy boundary — JOHN task when scheduled).

## 10. Out of scope / related

- Model pulls and disk management (task 8's contributor guide covers
  `DASHA_MODEL_MAP` picks; the MLX pull hints slot in there).
- Ollama 0.19 MLX-mode go/no-go detail (task 10) — this doc assumes the
  repo's ≥0.33.1 line; task 10's research note should be kept consistent
  with the matrix in section 5.
- Earnings calculator MLX toggle (task 6) consumes the verified
  multipliers from section 8, not the estimates in section 5.

## Sources

- Ollama MLX announcement, Mar 31 2026 — prefill 1,154→1,810 tok/s,
  decode 58→112 tok/s, >32GB gate, Qwen3.5-first:
  <https://www.macrumors.com/2026/03/31/ollama-now-runs-faster-apple-silicon-macs/>
  and <https://appleinsider.com/articles/26/03/31/ollama-is-supercharged-by-mlxs-unified-memory-use-on-apple-silicon>
- Independent Ollama MLX benchmark, Sep 2026 (M3 Max 128GB, Ollama 0.20.5)
  — decode ~2.15x, warm prefill ~7.3x:
  <https://github.com/ravsau/ai-tutorials/blob/HEAD/ollama-mlx-benchmark/README.md>
- Ollama MLX integration plan — supported families (Qwen 3/3.5/3.6,
  Gemma 3/4, Llama, Mistral, Phi, GLM-4 MoE), 2–3x inference claim:
  <https://github.com/yuriteixeira/llama-mac/blob/HEAD/plans/OLLAMA.md>
- vllm-mlx paper, arXiv:2601.19139 (Jan 2026) — 21–87% over llama.cpp,
  525 tok/s peak on M4 Max, 4.3x aggregate at 16 concurrent:
  <https://arxiv.org/pdf/2601.19139v2>
- mlx-server decode table (M4 Max 128GB) — mlx_lm vs llama.cpp vs Ollama:
  <https://github.com/panbanda/mlx-server>
- vlm-bakeoff MLX vs GGUF (Apple M5 Max, Aug 2026) — 4-bit vs bf16 quality:
  <https://github.com/ivanfioravanti/vlm-bakeoff>
- Repo ground truth: `compute/provider/agent.py` (Ollama-only provider),
  `compute/provider/run-provider` + `dasha-compute` (fixed env export
  list), `docs/COMPUTE.md` ("Prefer MLX when you can · Ollama ≥0.33.1").

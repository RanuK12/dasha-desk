# Ollama 0.19 MLX-mode research note

TASKS.md item 10. Research-only pass, 2026-09-18. Question: should the
Dasha Compute provider stack **require** Ollama ≥ 0.19?

**TL;DR — recommendation: NO-GO on a hard 0.19 requirement.** Treat 0.19 as
*detect-and-prefer*: nudge it on MLX-eligible Macs (>32 GB unified memory),
keep GGUF tags for the rest of the fleet. The headline ~2× numbers only
materialize on NVFP4/MLX-native models; the installed base's Q4_K_M GGUF
models see ~zero gain, and a hard floor would shrink provider supply — the
network's binding constraint. Revisit triggers are listed at the end.

## 1. What changed in Ollama 0.19

Released 2026-03-31 as a **preview**. On Apple Silicon, Ollama replaced the
llama.cpp/Metal inference path with a new backend built on **Apple's MLX
framework**, which treats unified memory as the architectural primitive
instead of porting a cross-platform C++ engine through Metal shaders.
Previously, macOS inference ran through llama.cpp's Metal backend — the
same engine as Windows/Linux, not tuned for Apple Silicon's memory design.

Operationally important details:

- **MLX is automatic.** No CLI flag or env var: on Apple Silicon with an
  Ollama binary ≥ 0.19, the MLX runner engages on its own (the runner
  spawns with `--mlx-engine`). Existing `ollama pull`/`ollama run` flows
  keep working.
- **Dual runners coexist.** 0.19 ships both the MLX runner and the legacy
  llama.cpp runner side by side. Models the MLX runner can't serve fall
  back to llama.cpp.
- **Below the memory gate it falls back automatically** to the old
  llama.cpp/Metal path (verified in community reports, June 2026).

## 2. Model support matrix (Qwen3.5-first, what's next)

| Model / tag family | 0.19 MLX status | Notes |
|---|---|---|
| Qwen3.5 35B-A3B (NVFP4, e.g. `qwen3.5:35b-a3b-coding-nvfp4`, ~21 GB) | **Supported — the launch model** | Recommended NVFP4 tag from the launch post; MoE, only a few experts fire per token |
| Gemma 4 | **Slated for 0.20** (in development as of mid-2026) | Per community engine notes, June 2026 |
| Community `-mlx-*` tags on ollama.com (e.g. `*-mlx-4bit`) | Supported on "a recent Ollama with the MLX engine" | MLX-native weights; will **not** run on the standard GGUF engine |
| Existing GGUF library (Q4_K_M and other K-quants) | **Runs on the legacy llama.cpp runner — no MLX speedup** | MLX natively handles Q4_0/Q4_1/Q8_0; K-quant formats have no planned MLX support |
| Non-Apple-Silicon / ≤32 GB Macs | Falls back to llama.cpp/Metal automatically | No user action needed, but also no gain |

Two consequences for Dasha: (a) the DASHA_MODEL_MAP defaults
(`qwen3:8b`, `gemma3:12b`) are GGUF tags that **do not touch the MLX path**
today — upgrading the binary alone changes nothing for them; (b) MLX
coverage is a *model-tag* property, not just a binary-version property, so
any "require 0.19" policy must be paired with a model-tag migration
(G NVFP4/MLX-native tags in DASHA_MODEL_MAP).

## 3. The >32 GB unified-memory gate

Ollama's requirement: **a Mac with more than 32 GB of unified memory**.
Also Apple Silicon only, macOS 13+.

- Base-config Macs (8/16/24 GB — the bulk of consumer hardware providers
  are likely to volunteer) are **structurally excluded** from the MLX path.
- Installers that want to provision NVFP4/MLX models must gate on
  `uname -m = arm64` **and** `sysctl -n hw.memsize` (> 32 GB), else the
  ~21 GB pull is dead weight on machines that can never use it.
- A hard 0.19 requirement does not just fail slow machines — it *evicts*
  them from the provider pool if doctor/installer enforces it.

## 4. Reported numbers

Official (Ollama launch post; Qwen3.5-35B-A3B int4):

| Metric | 0.18 (Metal) | 0.19 (MLX) | Change |
|---|---|---|---|
| Prefill | 1,154 tok/s | 1,810 tok/s | **+57%** |
| Decode | 57.8 tok/s | 112 tok/s | **+93%** |

Independent check (dev.to, M4 Max, Qwen3.5-35B-A3B int4): same table,
1,154 → 1,810 prefill / 57.8 → 112 decode. At 112 tok/s a 500-token
response renders in under 5 s.

Counter-evidence — the gains are **conditional**, not universal:

- **Existing Q4_K_M models see ~nothing** (zenn.dev, M5 Max 64 GB,
  `/api/generate` `prompt_eval_duration`/`eval_duration`, 3-run averages):
  qwen3.5 9.7B short-prompt decode 58.1 → 58.3 tok/s (flat); glm-ocr
  2.2 GB short-prompt decode 232.4 → 196.8 tok/s (**regression**, attributed
  to dual-runner overhead); long-prompt prefill mostly flat or slightly
  down. Conclusion: *"0.19 alone doesn't make it faster — you only get the
  benefit after switching to NVFP4 models."*
- **Tuned llama.cpp ≈ MLX on some hardware** (geeks-accelerator research,
  M3 Ultra, 25-turn agentic session on qwen3-coder-30b-a3b 4-bit, 262k
  context): MLX+Q8 KV 320 ms median TTFT / 42.4 tok/s vs Ollama
  (llama.cpp + flash attention + Q8 KV) 306 ms / 43.5 tok/s — dead even.
  Their finding: *tuning (Q8 KV cache, flash attention) matters more than
  backend choice* on that workload; the MLX advantage shows against
  *untuned* baselines.

## 5. M5 GPU Neural Accelerators

On M5, M5 Pro, and M5 Max, Ollama 0.19 leverages the new **GPU Neural
Accelerators** (one per GPU core) to accelerate both TTFT and tokens/s.
These chips show the largest improvements. This is a hardware-gated bonus
on top of the MLX backend — M1–M4 Macs get the unified-memory MLX win but
not the accelerator uplift.

## 6. NVFP4 and cache improvements (shipped in the same release)

- **NVFP4 support** (NVIDIA's 4-bit format): holds accuracy while cutting
  memory bandwidth and storage. This is the quant format the headline
  numbers were measured with — the speedup story is really an
  *NVFP4-on-MLX* story.
- **Cache improvements**: lower memory utilization, intelligent
  checkpointing, smarter eviction, and cross-conversation cache reuse.
  Disproportionately helps agentic coding tools (Claude Code, OpenCode,
  Codex) with shared system prompts — directly relevant to Dasha's
  developer-consumer workloads.

## 7. What this means for the Dasha provider stack

- **install.sh** (97 lines, LaunchAgent + Keychain flow; does not manage
  Ollama itself today): if it ever provisions models, gate NVFP4 pulls on
  `arm64` + `hw.memsize` > 32 GB. Do not add an Ollama ≥ 0.19 hard
  requirement — it would reject healthy ≤32 GB providers.
- **`dasha-compute --doctor`** (`compute/provider/agent.py`): add an
  *advisory* Ollama-version row — probe `GET /api/version`, parse semver,
  and on Apple Silicon + >32 GB + <0.19 print an upgrade nudge (the
  crabcc-labs pattern: green when MLX auto-on, yellow with upgrade hint
  otherwise, "not applicable" off-Darwin/arm64). Advisory, not failing:
  doctor is the onboarding funnel's front door (cf. TASKS items 2–3).
- **`dasha-compute --benchmark`**: the existing benchmark contract reports
  decode tok/s from `eval_duration`. Worth adding `prompt_eval_count` /
  `prompt_eval_duration` → **prefill tok/s** and the Ollama server version
  to the report, so the fleet can attribute MLX gains per-machine instead
  of arguing from press numbers (cf. TASKS item 11's schema work).
- **DASHA_MODEL_MAP**: keep GGUF defaults for fleet coverage; add
  NVFP4/MLX-native tags as opt-in mappings for >32 GB providers
  (e.g. a `qwen3.5-35b-nvfp4` public id). Model coverage, not binary
  version, is what unlocks the speedup.
- **Related in-flight work**: MLX backend lane design (TASKS 9), benchmark
  harness spec (TASKS 11), model catalog by memory tier (TASKS 12), and the
  doctor gap-spec checks (TASKS 2) should all treat "0.19 + NVFP4 tag +
  >32 GB" as one *eligibility tier*, not a fleet floor.

## 8. Recommendation: go / no-go

**NO-GO on requiring Ollama ≥ 0.19.** Reasons:

1. The >32 GB gate excludes most consumer Macs; supply is the binding
   constraint — a hard floor shrinks the provider pool for zero gain on
   excluded machines.
2. The speedup is model-tag-conditional: our default-mapped GGUF tags get
   ~nothing from the binary upgrade (independent measurement: flat to
   slightly regressed on Q4_K_M).
3. Coverage is still Qwen3.5-first; the rest of the coordinator's model
   ids (qwen3-8b, gemma3-12b, gpt-oss-20b, qwen3-30b-a3b, gemma3-27b,
   gpt-oss-120b) have no MLX-native story yet.

**GO on detect-and-prefer**: advisory doctor nudge for MLX-eligible Macs,
prefill + server-version in benchmark output, NVFP4 tags as opt-in
DASHA_MODEL_MAP entries, installer-side `hw.memsize` gating if model
provisioning is ever added.

**Revisit when**: Gemma 4 lands in the MLX path (0.20+); NVFP4/MLX-native
tags exist for the coordinator's public model ids; or the eligible share
of the provider fleet (track via benchmark reports) crosses ~50%.

## Sources

- MacRumors, "Ollama Now Runs Faster on Macs Thanks to Apple's MLX
  Framework" (2026-03-31) —
  https://www.macrumors.com/2026/03/31/ollama-now-runs-faster-apple-silicon-macs/
- 9to5Mac, "Ollama adopts MLX for faster AI performance on Apple silicon"
  (2026-03-31) —
  https://9to5mac.com/2026/03/31/ollama-adopts-mlx-for-faster-ai-performance-on-apple-silicon-macs/
- AppleInsider, "Ollama is supercharged by MLX's unified memory use on
  Apple Silicon" (2026-03-31) —
  https://appleinsider.com/articles/26/03/31/ollama-is-supercharged-by-mlxs-unified-memory-use-on-apple-silicon
- Mac Observer, "Apple Silicon Macs run local AI faster with Ollama's new
  MLX support" —
  https://www.macobserver.com/news/apple-silicon-macs-run-local-ai-faster-with-ollamas-new-mlx-support/
- dev.to, "Ollama MLX on Apple Silicon in 2026" (M4 Max benchmark table) —
  https://dev.to/jovan_chan_9500711396d4e6/ollama-mlx-on-apple-silicon-in-2026-what-2x-faster-inference-means-for-m-series-mac-users-4j4c
- zenn.dev, independent M5 Max 64 GB 0.18-vs-0.19 measurement (Q4_K_M
  shows no gain; NVFP4 required) —
  https://zenn.dev/luoxi/articles/ollama-019-mlx-benchmark
- geeks-accelerator/ollama-herd, "mlx-vs-ollama-adoption-2026" (tuned
  parity finding; NVFP4 note) —
  https://github.com/geeks-accelerator/ollama-herd/blob/HEAD/docs/research/mlx-vs-ollama-adoption-2026.md
- crabcc-labs/crabcc #110 (MLX-awareness in a system-check script;
  `qwen3.5:35b-a3b-coding-nvfp4` 21 GB / 32 GB RAM row) —
  https://github.com/crabcc-labs/crabcc/commit/8c5f124c6c02f0d6fa2300c34942df8ddc2c3b76
- sound-recreation-agent #33 (engine note: >32 GB gate, auto-fallback,
  Gemma 4 slated for 0.20) —
  https://github.com/uribrecher/sound-recreation-agent/issues/33
- nivintw/dotfiles #57 (hardware gating snippet: arm64 + hw.memsize;
  verified on 0.30.10) —
  https://github.com/nivintw/dotfiles/issues/57

*Research note only — no code, no manifest, no deploy. Deploy boundary
respected: nothing here ships to providers without a follow-up PR.*

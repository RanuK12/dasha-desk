# Apple Silicon model catalog by memory tier

A provider-facing guide: which models to advertise from your Mac, based on how
much unified memory it has. All picks map to real coordinator model ids — if a
model is not in `compute/coordinator/server.mjs` it is not in this catalog.

*Data-freshness note: figures below were last verified 2026-09-18 (community
sources + coordinator source code). Memory needs vary by quant, context length,
and what else your Mac is doing — verify on your own hardware (see the honesty
note at the end).*

## Coordinator model ids this catalog uses

The Dasha coordinator (`compute/coordinator/server.mjs`) knows these six
public model ids. The provider's `DASHA_MODEL_MAP` maps each public id to the
Ollama tag you pull locally. Only the two marked defaults ship in the default
`DASHA_MODEL_MAP` (`qwen3-8b=qwen3:8b,gemma3-12b=gemma3:12b` in
`compute/provider/agent.py`); everything else you add to your own map.

| Public id | Ollama tag (suggested) | 4-bit size | Min memory (coordinator) | Context | In default map |
|---|---|---|---|---|---|
| `qwen3-8b` | `qwen3:8b` | ~5.2 GB | 8 GB | 32K | yes |
| `gemma3-12b` | `gemma3:12b` | ~8.1 GB | 16 GB | 131K | yes |
| `gpt-oss-20b` | `gpt-oss:20b` | ~14 GB (MXFP4) | 16 GB | 131K | no |
| `qwen3-30b-a3b` | `qwen3:30b` | ~19 GB | 24 GB | 32K | no |
| `gemma3-27b` | `gemma3:27b` | ~17 GB | 24 GB | 131K | no |
| `gpt-oss-120b` | `gpt-oss:120b` | ~65 GB (MXFP4) | 96 GB | 131K | no |

Suggested tags beyond the two defaults follow the standard Ollama library
naming (`gpt-oss:20b` / `gpt-oss:120b` from OpenAI's own Ollama guide;
`qwen3:30b` is the 30B-A3B MoE). Confirm with `ollama pull <tag>` on your Mac
before adding a mapping.

Note the coordinator's `min_memory_gb` is a floor for *weights alone* — it does
not budget for the OS, the Ollama runtime, or KV cache (see "memory math"
below). Staying at or above the floor does not guarantee comfortable serving.

## Memory math (the rough guide)

A 4-bit model needs roughly **0.6–0.7 GB per billion parameters** resident
(Q4_K_M ≈ 0.58 GB/B plus runtime overhead). Then reserve:

- **macOS + Ollama + agent runtime:** ~4 GB on 8–16 GB Macs, ~6–8 GB on
  32–64 GB Macs, ~8–10 GB on 96 GB+ Macs.
- **KV cache:** grows with context length × model size. The 131K-context
  models (`gemma3-12b`, `gpt-oss-20b`, `gemma3-27b`, `gpt-oss-120b`) can hold
  tens of GB of KV cache at full context — the biggest hidden cost on the
  16–48 GB tiers. Halving the context you actually use roughly halves KV
  memory; `num_ctx` / `OLLAMA_CONTEXT_LENGTH` are Ollama-side knobs, not Dasha
  settings.
- **Concurrent jobs:** each loaded model keeps its weights resident, so two
  models loaded at once cost the sum of their weights. Dasha assigns jobs to
  the model the coordinator requested — load only what you advertise.

Rule of thumb: pick the biggest model that leaves **at least 4 GB free** for
KV cache and system headroom at the context lengths you expect.

## Per-tier table

"Usable for models" is total memory minus a realistic OS/runtime reserve. Chip
examples are what shipped at each tier across M1–M5.

| Tier | Chip examples | Usable for models | Recommended 4-bit picks | Notes |
|---|---|---|---|---|
| 8 GB | M1/M2/M3 base (Air, mini, iMac) | ~3–4 GB | `qwen3-8b` | Minimum viable provider tier. Weights (~5.2 GB) fit but leave almost no KV headroom — keep contexts short and the Mac otherwise idle. Not a workhorse. |
| 16 GB | M1/M2/M3/M4 base (Air, mini, iMac, MBP) | ~10–11 GB | `qwen3-8b`, `gemma3-12b` | `gpt-oss-20b` (~14 GB) is *possible* — the coordinator allows it at 16 GB — but it leaves nearly no KV headroom; treat as tight and reduce context. |
| 24 GB | M2/M3/M4 base option, M4 Pro 24 | ~17–18 GB | + `gpt-oss-20b`, `gemma3-27b` (~17 GB), `qwen3-30b-a3b` (~19 GB) | Sweet spot for a single 20–30B-class model. Both 27–30B picks carry the coordinator's 24 GB floor. |
| 36 GB | M3 Pro 36, M3 Max 36, M4 Max 36 (Studio) | ~28 GB | all of the above, with comfortable KV | Eligible for the Ollama MLX backend (see below). Long contexts become practical on 27–30B models. |
| 48 GB | M3 Max 48, M4 Pro 48 | ~40 GB | all 27–30B picks with big contexts | `gpt-oss-120b` (~65 GB) does **not** fit here. |
| 64 GB | M1/M2/M3/M4 Max 64, M5 Pro (max 64) | ~54 GB | 27–30B models with maximum contexts; run two smaller models concurrently | Still short of `gpt-oss-120b`. Best tier for heavy 30B-class serving. |
| 96 GB | M2/M3 Max 96, M5 Ultra base config | ~85 GB | + `gpt-oss-120b` (~65 GB) | Coordinator floor for the 120B class; ~20 GB left for KV at long contexts. |
| 128 GB+ | M2/M3 Ultra (128/192), M4 Max 128, M5 Max (128), M5 Ultra (up to 512) | 120 GB+ | `gpt-oss-120b` comfortably, even long-context or alongside a smaller model | The 128K-context flagship fits with headroom to spare. |

## Ollama's MLX backend (the 32 GB gate)

Ollama 0.19 (March 2026) added an Apple MLX inference backend on Apple Silicon
(~2× decode in independent benchmarks, ~93% decode / ~57% prefill on M5 Max in
Ollama's own numbers, plus NVFP4 support). It has a hard floor: **32 GB or more
unified memory**. Below that, Ollama silently falls back to its llama.cpp/Metal
path — no error, no change in behavior. The preview initially accelerated a
limited set of models; support widens over time.

This is entirely Ollama-side and transparent to Dasha: the provider agent calls
your local Ollama the same way either way. Practically, it means 32 GB+ Macs
(36 GB tier and up) get faster serving for the same advertised models — a
reason to prefer 36 GB over 24 GB if you are sizing a machine *for* providing.

## M5 notes

M5 Pro and M5 Max (announced March 2026) top out at 64 GB and 128 GB of unified
memory respectively, with Apple's new "Fusion Architecture" scaling and
GPU Neural Accelerators that Ollama's MLX numbers favor. The M5 Ultra, announced
August 2026 for the Mac Studio, scales to **512 GB** of unified memory
(base config 96 GB; the 512 GB configuration was expected to ship late 2026 —
check current availability before sizing around it). Anything at the
128 GB+ row applies to M5 Max/Ultra machines.

## How to choose (provider steps)

1. Check your Mac's unified memory (Apple menu → About This Mac).
2. Find your tier in the table above; budget with the memory math.
3. Pick the biggest recommended model(s) for your tier — bigger models
   generally do better work per job, but only if they leave KV headroom.
4. Extend `DASHA_MODEL_MAP` at install time (see `compute/README.md`). Examples:

   ```bash
   # 8–16 GB tier (16 GB example)
   DASHA_MODEL_MAP=qwen3-8b=qwen3:8b,gemma3-12b=gemma3:12b ./install.sh

   # 24–64 GB tier
   DASHA_MODEL_MAP=qwen3-8b=qwen3:8b,gemma3-12b=gemma3:12b,gpt-oss-20b=gpt-oss:20b,qwen3-30b-a3b=qwen3:30b,gemma3-27b=gemma3:27b ./install.sh

   # 96 GB+ tier — add the 120B class
   DASHA_MODEL_MAP=... ,gpt-oss-120b=gpt-oss:120b ./install.sh
   ```

5. Pull each mapped tag in Ollama (`ollama pull <tag>`), then verify the full
   chain before serving: `dasha-compute doctor`, then
   `dasha-compute benchmark` to measure real throughput on your Mac. If a
   model thrashes (memory pressure, swapping), drop down a tier or shorten
   context — the benchmark will tell you the truth.

## Honesty note

This is not performance or financial advice. Model sizes, memory needs, and
chip options are community-verified figures that change as Apple ships new
hardware and quant formats evolve; the coordinator's declared sizes and floors
(`size_gb`, `min_memory_gb`) are the only Dasha-side source of truth, and your
Mac's own `dasha-compute benchmark` run is the only figure that matters for
*your* machine. When in doubt, advertise the smaller model — a fast small
model earns more trust than a thrashing big one.

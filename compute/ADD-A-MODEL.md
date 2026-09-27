# Add a model — provider guide

**Kit:** the `compute/` open-alpha kit (this directory). Inference runs through
**Ollama only** in this kit — see [MLX status](#mlx-status-what-prefer-mlx-actually-means)
before planning around the live page's "Prefer MLX" line.

Two different moves live under "add a model":

1. **Serve another model on your Mac** — extend your own `DASHA_MODEL_MAP`.
   No repo changes, no review.
2. **Propose a new model to the shared catalog** — a PR against
   `coordinator/server.mjs`. Reviewed and merged by [@Uuriko](https://github.com/Uuriko).

## Prerequisites

- **macOS on Apple Silicon.** `./install.sh` exits on non-Darwin machines
  (`if [ "$(uname -s)" != Darwin ]`), and the inference paths are Apple-Silicon
  builds.
- **Ollama** installed and serving on `http://127.0.0.1:11434`
  (override with `OLLAMA_URL`). The kit
  guidance requires **Ollama ≥0.33.1**. This guide does not guarantee a
  particular Ollama inference backend.
- **Models on the internal SSD.** The live Provide guidance is explicit here;
  large weights on external volumes are slow and the doctor will not warn you
  about it.
- **Enough unified memory for the model.** The coordinator's catalog carries a
  `min_memory_gb` per model id — this is the declaration you must respect (and
  submit, for new catalog entries):

  | Public id     | Ollama tag example | Weights | min_memory_gb |
  |---------------|--------------------|---------|---------------|
  | qwen3-8b      | qwen3:8b           | ~5.2 GB | 8             |
  | gemma3-12b    | gemma3:12b         | ~8.1 GB | 16            |
  | gpt-oss-20b   | gpt-oss:20b        | ~14 GB  | 16            |
  | gemma3-27b    | gemma3:27b         | ~17 GB  | 24            |
  | qwen3-30b-a3b | qwen3:30b-a3b      | ~19 GB  | 24            |
  | gpt-oss-120b  | gpt-oss:120b       | ~65 GB  | 96            |

  (From the `models` array in `coordinator/server.mjs`. The "Ollama tag example"
  column is what a provider maps the public id to — see below.)

- `python3` and a provider token, if you have not installed yet
  (see `compute/README.md` §2).

## Step 1 — pick the public id and the Ollama tag

`DASHA_MODEL_MAP` is a comma-separated list of `public-id=ollama-tag` pairs
(parsed in `provider/agent.py::model_map`). The **public id** is what consumers
request and what the coordinator routes on (`job["model"]` → your map); the
**Ollama tag** is what must exist in your local Ollama.

- To serve an **existing catalog model**, use its exact public id
  (e.g. `gemma3-12b`) and any Ollama tag that runs that weight
  (e.g. `gemma3:12b`, or a quant variant like `gemma3:12b-instruct-q4_K_M`).
- To serve a **new public id**, you must also open the catalog PR
  ([step 5](#step-5-optional-propose-a-new-public-id-to-the-shared-catalog)) —
  jobs only route to ids the coordinator knows.

Example for an existing provider:

```bash
DASHA_MODEL_MAP=qwen3-8b=qwen3:8b,gemma3-12b=gemma3:12b
```

## Step 2 — pull the model

```bash
ollama pull qwen3:8b
```

Repeat for every tag in your map. The agent never pulls for you — the doctor
fails on missing models and prints the exact `ollama pull` commands.

## Step 3 — set the model map

For an already-installed provider, edit the env file the installer wrote and
restart:

```bash
# no spaces — the installer rejects them (see troubleshooting)
printf "DASHA_MODEL_MAP='%s'\n" "qwen3-8b=qwen3:8b,gemma3-12b=gemma3:12b" >> \
  "$HOME/Library/Application Support/Dasha Compute/provider.env"
dasha-compute restart
```

On a fresh install, pass the map into `./install.sh` exactly as
`compute/README.md` §2 shows:

```bash
DASHA_PROVIDER_ID=your-provider-id \
DASHA_MODEL_MAP=qwen3-8b=qwen3:8b,gemma3-12b=gemma3:12b \
./install.sh
```

`provider.env` also carries `DASHA_BENCHMARK_PATH` (pointed at
`$APP_DIR/benchmark.json`), so benchmarks are written there on every install.

## Step 4 — verify with doctor and benchmark

```bash
dasha-compute doctor      # exits nonzero on any failure
dasha-compute benchmark   # measures throughput, writes benchmark.json
```

`--doctor` checks the gateway (`DASHA_COORDINATOR_URL`), Ollama, and
model availability; newer releases also check platform, capacity, credentials,
and installed service state. `--benchmark`
runs `DASHA_BENCHMARK_TOKENS` tokens (default 64, clamped to 16–256) through
each installed mapped model and prints rows like:

```json
{
  "model": "gemma3-12b",
  "ollama_model": "gemma3:12b",
  "tokens": 64,
  "seconds": 3.21,
  "tokens_per_second": 19.94
}
```

together with `measured_at` and `hardware` (system, machine, Python,
`memory_gb`). The agent attaches benchmark data to its poll payload when available.
A benchmark records one run; it does not guarantee future throughput. **Keep this file** — it is
the `benchmark.json` submission your catalog PR needs.

Sanity-run one job before trusting the service:

```bash
DASHA_COORDINATOR_URL=<your-coordinator> DASHA_MODEL_MAP=... python3 provider/agent.py --once
```

## Step 5 (optional) — propose a new public id to the shared catalog

If the model you want to serve is not one of the six catalog ids, the
coordinator cannot route jobs to it until it lands in the `models` array in
`compute/coordinator/server.mjs`. Open a PR that:

1. Adds one entry to `models` in `compute/coordinator/server.mjs`:
   `{ id, object: "model", owned_by: "community", context_length,
   size_gb, min_memory_gb, status: "alpha" }`.
   - `size_gb` — the weights on disk, rounded up (from `ollama list`).
   - `min_memory_gb` — the smallest Mac that can serve it; err high, never low.
   - `context_length` — the model's published context window.
   - `status: "alpha"` — every catalog model ships alpha; promotion is a
     separate decision.
2. **Attaches your `benchmark.json`** output (the full file from step 4,
   run on the Mac you will serve from) in the PR body or as a linked gist.

The installer writes `benchmark.json` to `$APP_DIR/benchmark.json` on every
install; if you benchmarked with the installed service, that is the file to
submit. Do not hand-edit the numbers.

## Verification checklist

- [ ] `ollama list` shows every tag in your `DASHA_MODEL_MAP`.
- [ ] `dasha-compute doctor` exits 0 and confirms mapped models are installed.
- [ ] `dasha-compute benchmark` exits 0 and `benchmark.json` was written
      (`measured_at` + one row per model).
- [ ] `python3 provider/agent.py --once` completes a real job end to end.
- [ ] The provider shows up in the coordinator's network view with the new
      model in `models_available`.
- [ ] Catalog PR (if applicable): new id in `models`, `benchmark.json`
      attached, `min_memory_gb` declared.

## MLX status — what the kit actually runs

This `compute/` kit calls Ollama's `/api/chat`; it does not choose or verify
Ollama's internal backend. It has no implemented `DASHA_BACKEND` switch.
The separate `ocm/agent/agent.py` implements an MLX provider; its configuration
is not interchangeable with this kit's `DASHA_MODEL_MAP`.

Use a model tag supported by your installed Ollama version and verify the
actual measured throughput. Proposed backend designs are not installed features.

## Troubleshooting

1. **`models failed · missing: <tag>`** (doctor exits 1).
   The tag is not in Ollama. Run the exact command the doctor prints:
   `ollama pull <tag>`, then rerun `dasha-compute doctor`.

2. **`DASHA_MODEL_MAP contains no valid public=ollama mappings`** (agent
   exits immediately).
   The variable is empty or malformed in the agent's environment. On an
   installed service it lives in `$HOME/Library/Application Support/Dasha
   Compute/provider.env` — edit it, then `dasha-compute restart`. Format is
   `public-id=ollama-tag` pairs separated by commas; pairs without `=` or with
   empty sides are silently dropped (`model_map()` in `agent.py`).

3. **`Invalid model map.`** (from `./install.sh`).
   The installer only accepts characters in `A-Za-z0-9_.:,=-` — **no spaces**.
   `qwen3-8b = qwen3:8b` fails even though the agent itself would tolerate it.

4. **`gateway failed` in doctor output.**
   `DASHA_COORDINATOR_URL` is wrong or unreachable. Fresh installs default to
   `https://lobby.getdasha.com/compute/api`; local testing uses
   `http://127.0.0.1:8787`. The installer refuses anything that is not HTTPS
   or localhost HTTP. The doctor prints the URL it tried.

5. **The new model gets no jobs.**
   The provider only receives jobs for models it actually has installed
   (the `available` filter at startup), and the coordinator only routes ids
   in its catalog. If your public id is new, the catalog PR has to land
   first — jobs addressed to an unknown id have nowhere to go.

6. **`benchmark.json` is missing or stale.**
   The installer runs the benchmark once and stores the path in
   `provider.env` (`DASHA_BENCHMARK_PATH`). Rerun it by hand:
   `DASHA_MODEL_MAP=... DASHA_BENCHMARK_PATH=<path> python3 provider/agent.py
   --benchmark`. Without this file the poll payload carries no benchmark
   data and the coordinator cannot tell how fast you are.

## Where to ask for help

- **Questions / setup help:** [Discussions](https://github.com/Uuriko/dasha-desk/discussions).
- **Bugs in the kit:** [open an issue](https://github.com/Uuriko/dasha-desk/issues/new/choose) —
  paste the full `dasha-compute doctor` and `dasha-compute benchmark` output.
- **Catalog-model proposals:** open the PR (see step 5); maintainer
  [@Uuriko](https://github.com/Uuriko) reviews and merges.
- **Security problems with the kit:** follow `SECURITY.md` — do not post them
  in Discussions.

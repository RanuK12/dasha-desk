#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets==13.1", "mlx-lm>=0.28; sys_platform == 'darwin' and platform_machine == 'arm64'"]
# ///
"""
OCM host agent.

Holds one persistent OUTBOUND WebSocket to the gateway and never accepts an inbound
connection — that is what makes this installable by a non-technical Mac owner
(docs/ARCHITECTURE.md). Reconnection is routine, not exceptional: the socket is
expected to drop, and API Gateway caps a connection at two hours regardless.

  uv run ocm/agent/agent.py --doctor
  uv run ocm/agent/agent.py --doctor --load     # also loads the model and times it
  uv run ocm/agent/agent.py --benchmark
  OCM_GATEWAY_URL=ws://127.0.0.1:8080 uv run ocm/agent/agent.py
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
import random
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

from websockets.legacy.client import connect

GATEWAY_URL = os.getenv("OCM_GATEWAY_URL", "ws://127.0.0.1:8080")
HOST_TOKEN = os.getenv("OCM_HOST_TOKEN", "host-dev-token")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
AGENT_ID = os.getenv("OCM_AGENT_ID") or f"{platform.node().split('.')[0]}-{os.getpid()}"
REGION = os.getenv("OCM_REGION", "local")
# A host advertises its models at hello long before Metal has loaded anything, so the
# gateway used to learn that a machine was warm only from its first chunk — and the
# consumer who triggered that chunk paid the ~75s load. `ready` tells the gateway
# whether the primary model (the first one advertised) is resident right now.
# OCM_PRELOAD=1 loads it at start and again whenever it stops being resident, so no
# request pays the cold start. Off by default in the alpha: a preload holds ~4.5 GB
# before any work has arrived, on a machine somebody is still using.
PRELOAD = os.getenv("OCM_PRELOAD", "").strip().lower() in {"1", "true", "yes", "on"}


def _self_sha256():
    """This agent's version: the SHA-256 of the file it is running from.

    The gateway hashes the agent.py it serves the same way. Equal means current;
    anything else means `ocm-agent-update` has work to do. A hash cannot be forgotten
    at release time the way a version number can.
    """
    try:
        with open(__file__, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except Exception:                        # noqa: BLE001
        return None


AGENT_BUILD = _self_sha256()
MAX_BACKOFF = 60.0


def _http_json(url, payload=None, timeout=30):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _http_base():
    """The HTTPS origin matching the WebSocket gateway URL."""
    return GATEWAY_URL.rstrip("/").replace("wss://", "https://").replace("ws://", "http://")


def verify_token(timeout=15):
    """Ask the gateway whether this provider token is usable.

    Returns (ok, message). A wrong token is the single most common reason a new
    provider never appears, and until this existed the only symptom was a 401 on
    the socket that looks exactly like the gateway being down.
    """
    if not HOST_TOKEN or HOST_TOKEN == "host-dev-token":
        return False, "OCM_HOST_TOKEN is not set — put your provider token in /etc/ocm/agent.env"
    req = urllib.request.Request(
        f"{_http_base()}/v1/provider/verify",
        headers={"Authorization": f"Bearer {HOST_TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.load(r)
        return True, f"accepted for {body.get('email') or body.get('account_id')}"
    except urllib.error.HTTPError as exc:
        try:
            detail = json.load(exc)["error"]["message"]
        except Exception:                    # noqa: BLE001
            detail = f"HTTP {exc.code}"
        return False, detail
    except Exception as exc:                 # noqa: BLE001
        return False, f"could not reach {_http_base()}: {exc}"


def _job_max_tokens(job):
    """The gateway's per-request completion budget, never above the operator's
    OCM_MAX_TOKENS if that is set. Older gateways send no budget; then the env or the
    runtime default applies, as before."""
    def as_int(value):
        try:
            n = int(value)
            return n if n > 0 else None
        except (TypeError, ValueError):
            return None
    want = as_int(job.get("max_tokens"))
    cap = as_int(os.getenv("OCM_MAX_TOKENS"))
    if want and cap:
        return min(want, cap)
    return want or cap


def capabilities(models, ready=None):
    """The record advertised at handshake (PDF §03 step 4).

    `ready` is whether the primary model is resident; None leaves the field out, which
    is what agents before the ready bit sent and what the gateway reads as unknown.
    """
    mem = 0
    try:
        mem = round(int(subprocess.run(["sysctl", "-n", "hw.memsize"],
                                       capture_output=True, text=True).stdout.strip()) / 1024**3)
    except Exception:
        pass
    chip = platform.processor() or platform.machine()
    try:
        out = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"],
                             capture_output=True, text=True).stdout.strip()
        if out:
            chip = out
    except Exception:
        pass
    caps = {
        "id": AGENT_ID,
        "chip": chip,
        "arch": platform.machine(),
        "memory_gb": mem,
        "region": REGION,
        "runtime": RUNTIME.name,
        "build": AGENT_BUILD,
        "models": models,
        # thermal_headroom needs `powermetrics` (root) — deliberately omitted rather
        # than faked; the gateway treats it as optional.
    }
    if ready is not None:
        caps["ready"] = bool(ready)
    return caps


def status_frame(ready):
    """What the agent sends when residency changes after hello."""
    return {"t": "status", "ready": bool(ready)}


class OllamaRuntime:
    """Local runtime for development and for Intel Macs, which cannot run MLX."""

    name = "ollama"

    def models(self):
        tags = _http_json(f"{OLLAMA_URL}/api/tags", timeout=5).get("models", [])
        names = [m["name"] for m in tags]
        mapping = os.getenv("OCM_MODEL_MAP", "").strip()
        if not mapping:
            return names
        out = []
        for pair in mapping.split(","):
            if "=" in pair:
                public, local = pair.split("=", 1)
                if local.strip() in names:
                    out.append(public.strip())
        return out or names

    def local_name(self, model):
        for pair in os.getenv("OCM_MODEL_MAP", "").split(","):
            if "=" in pair:
                public, local = pair.split("=", 1)
                if public.strip() == model:
                    return local.strip()
        return model

    def ready(self, model):
        """Is the model resident in Ollama right now? False when Ollama cannot say."""
        try:
            running = _http_json(f"{OLLAMA_URL}/api/ps", timeout=5).get("models", [])
        except Exception:                    # noqa: BLE001
            return False
        local = self.local_name(model)
        return any(m.get("name") == local or m.get("model") == local for m in running)

    def load(self, model):
        """Load the model and keep it resident. Blocking.

        A chat with no messages is Ollama's documented way to load without generating;
        a model that is not pulled is a 404, which raises.
        """
        _http_json(f"{OLLAMA_URL}/api/chat",
                   {"model": self.local_name(model), "messages": [], "stream": False},
                   timeout=600)

    def stream(self, model, messages, cancelled, max_tokens=None):
        """Yield content deltas. Blocking; run in a worker thread."""
        options = {}
        if max_tokens:
            options["num_predict"] = int(max_tokens)
        payload = {"model": self.local_name(model), "messages": messages,
                   "stream": True, "options": options}
        req = urllib.request.Request(f"{OLLAMA_URL}/api/chat",
                                     data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as resp:
            for raw in resp:
                if cancelled.is_set():
                    return
                line = raw.decode().strip()
                if not line:
                    continue
                obj = json.loads(line)
                delta = (obj.get("message") or {}).get("content", "")
                if delta:
                    yield delta
                if obj.get("done"):
                    return


class MlxRuntime:
    """
    Apple Silicon runtime.

    MLX is the chosen runtime (decision #3): `mlx_lm` speaks the OpenAI chat schema
    natively, and it was verified running on Metal *headless* on an EC2 mac-m4 — no
    GUI session, no VNC. See docs/BENCHMARKS.md.

    The model is loaded once and held resident; that is the whole point of a
    dedicated provider, and reloading per request would dominate latency.
    """

    name = "mlx"

    def __init__(self):
        self._model = None
        self._tokenizer = None
        self._loaded = None
        # Jobs run in a thread pool, so two requests arriving before the first load
        # finishes would both enter load() — roughly 9 GB instead of 4.5 for a 7B
        # model, plus a torn read of _model/_tokenizer/_loaded. Cold start is exactly
        # when a second request is most likely, because the first one is slow.
        self._lock = threading.Lock()

    def _model_id(self, public_name):
        for pair in os.getenv("OCM_MODEL_MAP", "").split(","):
            if "=" in pair:
                pub, local = pair.split("=", 1)
                if pub.strip() == public_name:
                    return local.strip()
        return public_name

    def models(self):
        mapping = os.getenv("OCM_MODEL_MAP", "").strip()
        if mapping:
            return [p.split("=", 1)[0].strip() for p in mapping.split(",") if "=" in p]
        return [os.getenv("OCM_MLX_MODEL", "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit")]

    def _ensure(self, model):
        target = self._model_id(model)
        if self._loaded == target:
            return self._model, self._tokenizer
        with self._lock:
            # Re-check: another thread may have loaded it while we waited.
            if self._loaded != target:
                from mlx_lm import load
                model_obj, tokenizer = load(target)
                self._model, self._tokenizer = model_obj, tokenizer
                self._loaded = target
        return self._model, self._tokenizer

    def ready(self, model):
        """Is this exact model the one held resident right now? Cheap; no IO."""
        return self._loaded == self._model_id(model)

    def load(self, model):
        """Load the weights and hold them resident. Blocking; raises when they cannot
        be loaded, which is the whole point of `--doctor --load`."""
        self._ensure(model)

    @staticmethod
    def _eos_ids(tok):
        ids = set()
        for attr in ("eos_token_ids", "eos_token_id"):
            v = getattr(tok, attr, None)
            if isinstance(v, (list, tuple, set)):
                ids |= {int(x) for x in v}
            elif isinstance(v, int):
                ids.add(v)
        return ids

    @staticmethod
    def _stop_strings(tok):
        """Chat templates end a turn with a marker the model may emit as text."""
        marks = {"<|im_end|>", "<|endoftext|>", "<|eot_id|>", "</s>"}
        for attr in ("eos_token",):
            v = getattr(tok, attr, None)
            if isinstance(v, str) and v:
                marks.add(v)
        return marks

    def stream(self, model, messages, cancelled, max_tokens=None):
        from mlx_lm import stream_generate
        mdl, tok = self._ensure(model)
        prompt = tok.apply_chat_template(messages, add_generation_prompt=True)
        eos = self._eos_ids(tok)
        stops = self._stop_strings(tok)
        # Belt and braces: filter the EOS token by id, and also cut on the literal
        # turn-end marker. Qwen's template emits `<|im_end|>` as ordinary text under
        # some tokenizer configs, which otherwise leaks straight into the response.
        for response in stream_generate(mdl, tok, prompt,
                                        max_tokens=int(max_tokens or 512)):
            if cancelled.is_set():
                return
            token = getattr(response, "token", None)
            text = response.text or ""
            if token is not None and token in eos:
                return
            for mark in stops:
                if mark and mark in text:
                    head = text.split(mark, 1)[0]
                    if head:
                        yield head
                    return
            if text:
                yield text
            if getattr(response, "finish_reason", None):
                return


def _pick_runtime():
    """MLX on Apple Silicon, Ollama otherwise. Override with OCM_RUNTIME."""
    choice = os.getenv("OCM_RUNTIME")
    if choice == "mlx":
        return MlxRuntime()
    if choice == "ollama":
        return OllamaRuntime()
    return MlxRuntime() if platform.machine() == "arm64" else OllamaRuntime()


RUNTIME = _pick_runtime()


async def run_job(ws, job, jobs):
    """Stream one job back over the socket, honouring cancellation.

    Every job ends with exactly one terminal frame, and a cancelled job is no
    exception: it answers with `error: cancelled` the moment the cancel lands. The
    gateway frees the host's routing slot when it sends the cancel, so this is not
    what unblocks routing; it is what lets the gateway, and anyone reading either
    log, tell "stopped promptly" from "never heard back" (protocol gate #5).

    The wait races the runtime's queue against the cancel event, so a cancel that
    arrives during a cold model load is answered at once rather than after the
    first token finally shows up. The runtime itself stops at its next token, which
    is the soonest a blocking generator can be asked to.
    """
    job_id = job["id"]
    cancelled = jobs[job_id]
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def produce():
        try:
            for delta in RUNTIME.stream(job["model"], job["messages"], cancelled,
                                        max_tokens=_job_max_tokens(job)):
                loop.call_soon_threadsafe(queue.put_nowait, ("chunk", delta))
            loop.call_soon_threadsafe(queue.put_nowait, ("done", None))
        except Exception as exc:                                  # noqa: BLE001
            loop.call_soon_threadsafe(queue.put_nowait, ("error", str(exc)))

    loop.run_in_executor(None, produce)
    stop = asyncio.ensure_future(cancelled.wait())
    try:
        while True:
            item = asyncio.ensure_future(queue.get())
            await asyncio.wait({item, stop}, return_when=asyncio.FIRST_COMPLETED)
            if cancelled.is_set():
                item.cancel()
                await ws.send(json.dumps({"t": "error", "id": job_id, "message": "cancelled"}))
                break
            kind, value = item.result()
            if kind == "chunk":
                await ws.send(json.dumps({"t": "chunk", "id": job_id, "delta": value}))
            elif kind == "done":
                await ws.send(json.dumps({"t": "done", "id": job_id}))
                break
            else:
                await ws.send(json.dumps({"t": "error", "id": job_id, "message": value}))
                break
    finally:
        stop.cancel()
        jobs.pop(job_id, None)


def _connect(url):
    """Open the host socket with the token as an Authorization header.

    The token goes in a header, never the URL. A query string is recorded verbatim
    by every proxy and load balancer in the path, so a query-string token wrote a live
    provider credential into ALB access logs on every reconnect.

    `websockets` is pinned to 13.1, where the legacy client takes `extra_headers`
    (14.0 renamed it). Keep the pin and this call in step.
    """
    return connect(
        url,
        extra_headers={"Authorization": f"Bearer {HOST_TOKEN}"},
        ping_interval=20,
        ping_timeout=20,
        max_size=8 * 1024 * 1024,
    )


async def session():
    models = RUNTIME.models()
    if not models:
        raise RuntimeError("runtime reports no models")
    primary = models[0]
    url = f"{GATEWAY_URL.rstrip('/')}/host/connect"
    loop = asyncio.get_running_loop()

    def resident():
        # Ollama answers this over HTTP; keep it off the event loop.
        return loop.run_in_executor(None, RUNTIME.ready, primary)

    reported = await resident()
    async with _connect(url) as ws:
        await ws.send(json.dumps({"t": "hello", "agent": capabilities(models, ready=reported)}))
        jobs: dict[str, asyncio.Event] = {}

        async def report_ready():
            """One small status frame, only when residency actually changed."""
            nonlocal reported
            now = await resident()
            if now != reported:
                reported = now
                try:
                    await ws.send(json.dumps(status_frame(now)))
                except Exception:            # noqa: BLE001  socket gone; next hello says
                    pass

        async def preload():
            if await resident():
                return
            print(f"preloading {primary} …", flush=True)
            started = time.time()
            try:
                await loop.run_in_executor(None, RUNTIME.load, primary)
                print(f"preloaded {primary} in {time.time() - started:.1f}s", flush=True)
            except Exception as exc:         # noqa: BLE001
                print(f"preload failed for {primary}: {exc}", file=sys.stderr, flush=True)
            await report_ready()

        def after_job(_task):
            # A job may have loaded the primary model, or replaced it with another one.
            # Say so, and with OCM_PRELOAD bring the primary back once the host is idle.
            async def settle():
                await report_ready()
                if PRELOAD and not jobs and not reported:
                    await preload()
            asyncio.create_task(settle())

        if PRELOAD:
            asyncio.create_task(preload())
        async for raw in ws:
            msg = json.loads(raw)
            if msg.get("t") == "welcome":
                print(f"connected as {msg['host_id']} · {RUNTIME.name} · {len(models)} model(s)"
                      f" · {'model loaded' if reported else 'model not loaded'}", flush=True)
            elif msg.get("t") == "job":
                jobs[msg["id"]] = asyncio.Event()
                asyncio.create_task(run_job(ws, msg, jobs)).add_done_callback(after_job)
            elif msg.get("t") == "cancel":
                ev = jobs.get(msg.get("id"))
                if ev:
                    ev.set()


async def forever():
    """Reconnect with exponential backoff and jitter. Dropping is expected."""
    delay = 1.0
    complained = False
    while True:
        try:
            await session()
            delay = 1.0                      # a clean close is not a failure
            complained = False
        except Exception as exc:             # noqa: BLE001
            # A 401 will never fix itself by waiting, so it must not be logged
            # like a dropped socket. Retrying is still right — the operator may
            # fix the token underneath us — but the log has to say what is wrong.
            if "401" in str(exc):
                if not complained:
                    good, detail = verify_token()
                    print(f"REFUSED BY GATEWAY: {detail}", file=sys.stderr, flush=True)
                    print("  This is a credential problem, not a network problem. "
                          "Retrying will not fix it.", file=sys.stderr, flush=True)
                    print("  Fix: sudo /opt/ocm/bin/ocm-agent-token  "
                          "(issue one in the console under New provider token; "
                          "the helper prompts and does not take the token on argv)",
                          file=sys.stderr, flush=True)
                    complained = True
                delay = MAX_BACKOFF
            else:
                print(f"disconnected: {exc}; retrying in {delay:.1f}s", file=sys.stderr, flush=True)
            await asyncio.sleep(delay + random.uniform(0, delay * 0.3))
            delay = min(delay * 2, MAX_BACKOFF)


def doctor(load=False):
    """Exit nonzero when the local chain cannot serve a request.

    Plain `--doctor` is fast and only lists what the runtime says it has; that is what
    the installer gates on. `--doctor --load` also loads the primary model through the
    same path a job takes and times it, so missing or broken weights fail here rather
    than on the first consumer's request.
    """
    ok = True
    models = []
    try:
        models = RUNTIME.models()
        print(f"runtime   {RUNTIME.name}: ok ({len(models)} model(s): {', '.join(models[:4])})")
    except Exception as exc:                 # noqa: BLE001
        print(f"runtime   {RUNTIME.name}: FAIL {exc}")
        ok = False
    if load and models:
        model = models[0]
        print(f"load      {model} … (downloads the weights the first time)", flush=True)
        started = time.time()
        try:
            RUNTIME.load(model)
            secs = time.time() - started
            if RUNTIME.ready(model):
                print(f"load      ok in {secs:.1f}s — resident")
            else:
                print(f"load      FAIL after {secs:.1f}s — loaded without error, "
                      "but the runtime does not report it resident")
                ok = False
        except Exception as exc:             # noqa: BLE001
            print(f"load      FAIL after {time.time() - started:.1f}s: {exc}")
            ok = False
    elif load:
        print("load      skipped — the runtime reported no model to load")
        ok = False
    caps = capabilities([])
    print(f"host      {caps['chip']} · {caps['memory_gb']} GiB · {caps['arch']}")
    if caps["arch"] != "arm64":
        print("          note: not Apple Silicon — MLX is unavailable on this machine")
    print(f"gateway   {GATEWAY_URL}")
    # Build check: the one-command update exists; this is what says when to run it.
    # Informational only — an old build still serves, so it does not fail the doctor.
    print(f"build     {(AGENT_BUILD or 'unknown')[:12]}", end="", flush=True)
    try:
        with urllib.request.urlopen(f"{_http_base()}/agent.py.sha256", timeout=15) as r:
            served = r.read().decode().split()[0]
        if served == AGENT_BUILD:
            print(" — current")
        else:
            print(f" — UPDATE AVAILABLE ({served[:12]} is served)")
            print("          run: sudo /opt/ocm/bin/ocm-agent-update")
    except Exception as exc:                 # noqa: BLE001
        print(f" — could not compare with the gateway: {exc}")
    # The check that matters. A local runtime that works proves nothing about
    # whether this machine is allowed to join the network.
    good, detail = verify_token()
    print(f"token     {'ok — ' + detail if good else 'FAIL ' + detail}")
    if not good:
        print()
        print("          Fix: issue a provider token in the console under")
        print("          New provider token, then:")
        print("            sudo /opt/ocm/bin/ocm-agent-token")
        ok = False
    if not load:
        print("next      --doctor --load  proves the weights actually load and times it "
              "(slow the first time; downloads ~4.5 GB)")
    return 0 if ok else 1


def benchmark():
    models = RUNTIME.models()
    if not models:
        print("no models"); return 1
    model = os.getenv("OCM_BENCH_MODEL", models[0])
    n = int(os.getenv("OCM_BENCH_TOKENS", "32"))
    print(f"benchmarking {model} for ~{n} tokens …", flush=True)
    start, chars = time.time(), 0
    for delta in RUNTIME.stream(model, [{"role": "user", "content": "Count from one to twenty."}],
                                threading.Event(), max_tokens=n):
        chars += len(delta)
    secs = time.time() - start
    print(f"{chars} chars in {secs:.1f}s  ≈ {chars/4/secs:.1f} tok/s (approx)")
    return 0


def main():
    ap = argparse.ArgumentParser(description="OCM host agent")
    ap.add_argument("--doctor", action="store_true", help="check the local chain and exit")
    ap.add_argument("--load", action="store_true",
                    help="with --doctor: load the model through the runtime and time it")
    ap.add_argument("--benchmark", action="store_true", help="measure local throughput and exit")
    a = ap.parse_args()
    if a.load and not a.doctor:
        ap.error("--load goes with --doctor")
    if a.doctor:
        sys.exit(doctor(load=a.load))
    if a.benchmark:
        sys.exit(benchmark())
    try:
        asyncio.run(forever())
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    main()

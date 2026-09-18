#!/usr/bin/env python3
"""Dasha Compute v0.3 provider: outbound polling and Ollama inference."""

import argparse
import json
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

COORDINATOR = os.getenv("DASHA_COORDINATOR_URL", "http://127.0.0.1:8787").rstrip("/")
PROVIDER_KEY = os.getenv("DASHA_PROVIDER_KEY", "dasha-local-provider")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
PROVIDER_ID = os.getenv("DASHA_PROVIDER_ID", f"mac-{uuid.uuid5(uuid.NAMESPACE_DNS, socket.gethostname()).hex[:12]}")
PROVIDER_NAME = os.getenv("DASHA_PROVIDER_NAME", socket.gethostname())
RUNNING = True


def coordinator_path(local_path, public_path):
    return f"{COORDINATOR}{public_path if COORDINATOR.endswith('/compute/api') else local_path}"


def model_map():
    raw = os.getenv("DASHA_MODEL_MAP", "qwen3-8b=qwen3:8b,gemma3-12b=gemma3:12b")
    result = {}
    for pair in raw.split(","):
        public, separator, local = pair.partition("=")
        if separator and public.strip() and local.strip():
            result[public.strip()] = local.strip()
    return result


MODELS = model_map()

# Ollama version floor, pinned in one place. Must match the "Ollama ≥0.33.1"
# requirement in compute/README.md (the live Provide page's floor).
OLLAMA_MIN_VERSION = (0, 33, 1)

# Per-public-id catalog facts mirrored from coordinator/server.mjs (the
# add-a-model catalog is the source of truth — keep this table in sync).
# size_gb drives the G6 disk-need estimate; min_memory_gb drives the G11
# memory-fit check.
MODEL_SPECS = {
    "qwen3-8b": {"size_gb": 5.2, "min_memory_gb": 8},
    "gemma3-12b": {"size_gb": 8.1, "min_memory_gb": 16},
    "gpt-oss-20b": {"size_gb": 14, "min_memory_gb": 16},
    "qwen3-30b-a3b": {"size_gb": 19, "min_memory_gb": 24},
    "gemma3-27b": {"size_gb": 17, "min_memory_gb": 24},
    "gpt-oss-120b": {"size_gb": 65, "min_memory_gb": 96},
}


def make_request(url, method="GET", payload=None, token=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "dasha-compute-provider/0.3"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, data=data, headers=headers, method=method)


def request_json(url, method="GET", payload=None, token=None, timeout=90):
    request = make_request(url, method, payload, token)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status == 204:
                return None
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {error.code}: {detail[:300]}") from error


def hardware(include_benchmarks=True):
    result = {"system": platform.system(), "machine": platform.machine(), "release": platform.release(), "python": platform.python_version()}
    try:
        result["memory_gb"] = round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024 ** 3, 1)
    except (ValueError, OSError, AttributeError):
        pass
    benchmark_path = os.getenv("DASHA_BENCHMARK_PATH")
    if include_benchmarks and benchmark_path:
        try:
            with open(benchmark_path, encoding="utf-8") as source:
                saved = json.load(source)
            result["benchmarked_at"] = saved["measured_at"]
            result["benchmarks"] = saved["results"]
        except (OSError, ValueError, KeyError):
            pass
    return result


def usage_from(result):
    prompt = int(result.get("prompt_eval_count") or 0)
    completion = int(result.get("eval_count") or 0)
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}


def installed_models():
    tags = request_json(f"{OLLAMA_URL}/api/tags", timeout=5)
    return {item.get("name") for item in tags.get("models", [])}


def run_ollama(job):
    result = request_json(
        f"{OLLAMA_URL}/api/chat",
        method="POST",
        payload={"model": MODELS[job["model"]], "messages": job["messages"], "stream": False, "options": {"temperature": job.get("temperature", 0.7), "num_predict": job.get("max_tokens", 1024)}},
        timeout=600,
    )
    return {"content": str((result.get("message") or {}).get("content") or ""), "finish_reason": "stop", "usage": usage_from(result)}


def report(job_id, result):
    return request_json(coordinator_path(f"/v1/providers/jobs/{job_id}/result", f"/providers/jobs/{job_id}/result"), method="POST", payload={"provider_id": PROVIDER_ID, **result}, token=PROVIDER_KEY)


def renew_lease(job_id):
    return request_json(coordinator_path("", f"/providers/jobs/{job_id}/heartbeat"), method="POST", payload={"provider_id": PROVIDER_ID}, token=PROVIDER_KEY, timeout=10)


def keep_lease(job_id, lease_seconds, stop, cancelled):
    while not stop.wait(min(30, max(5, lease_seconds // 3))):
        try:
            response = renew_lease(job_id)
            if response.get("cancelled"):
                cancelled.set()
                return
        except Exception as error:
            print(f"heartbeat failed {job_id}: {error}", file=sys.stderr)


def report_chunk(job_id, **chunk):
    return request_json(coordinator_path(f"/v1/providers/jobs/{job_id}/chunk", f"/providers/jobs/{job_id}/chunk"), method="POST", payload={"provider_id": PROVIDER_ID, **chunk}, token=PROVIDER_KEY)


def stream_ollama(job, cancelled):
    if cancelled.is_set():
        return False
    request = make_request(
        f"{OLLAMA_URL}/api/chat",
        method="POST",
        payload={"model": MODELS[job["model"]], "messages": job["messages"], "stream": True, "options": {"temperature": job.get("temperature", 0.7), "num_predict": job.get("max_tokens", 1024)}},
    )
    final = {}
    with urllib.request.urlopen(request, timeout=600) as response:
        for raw_line in response:
            if cancelled.is_set():
                return False
            if not raw_line.strip():
                continue
            event = json.loads(raw_line.decode("utf-8"))
            if event.get("error"):
                raise RuntimeError(str(event["error"]))
            final = event
            content = str((event.get("message") or {}).get("content") or "")
            if content:
                report_chunk(job["id"], delta=content)
    if cancelled.is_set():
        return False
    if final.get("done") is not True:
        raise RuntimeError("Ollama stream ended before completion")
    report_chunk(job["id"], done=True, finish_reason="stop", usage=usage_from(final))
    return True


def _parse_version(text):
    match = re.match(r"^\s*v?(\d+)\.(\d+)(?:\.(\d+))?", str(text or ""))
    if not match:
        return None
    return tuple(int(part or 0) for part in match.groups())


def _unified_memory_gb():
    # DASHA_DOCTOR_TEST_MEMORY_GB is a test-only hook so the memory-fit check
    # can be exercised without a real 8 GB Mac. Never set it in production.
    override = os.getenv("DASHA_DOCTOR_TEST_MEMORY_GB")
    if override is not None:
        try:
            return float(override)
        except ValueError:
            return None
    if platform.system() == "Darwin":
        try:
            out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5)
            if out.returncode == 0:
                return int(out.stdout.strip()) / 1024**3
        except (OSError, ValueError):
            pass
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3
    except (ValueError, OSError, AttributeError):
        return None


def _ollama_models_dir():
    return os.path.expanduser(os.getenv("OLLAMA_MODELS", "~/.ollama"))


def _free_disk_gb(path):
    # DASHA_DOCTOR_TEST_DISK_FREE_GB is a test-only hook so the disk check can
    # be exercised without filling a real disk. Never set it in production.
    override = os.getenv("DASHA_DOCTOR_TEST_DISK_FREE_GB")
    if override is not None:
        return float(override)
    return shutil.disk_usage(path).free / 1024**3


def _estimate_tag_size_gb(tag):
    """Conservative upper-bound download size for an Ollama tag not in MODEL_SPECS."""
    low = tag.lower()
    for marker, size_gb in (("120b", 70), ("70b", 40), ("32b", 20), ("30b", 20), ("27b", 20), ("20b", 14), ("13b", 14), ("12b", 14), ("8b", 6), ("7b", 6)):
        if marker in low:
            return size_gb
    return 10.0


def _missing_model_size_gb(public_id, tag):
    spec = MODEL_SPECS.get(public_id)
    if spec:
        return spec["size_gb"]
    return _estimate_tag_size_gb(tag)


def _check_gateway(ctx):
    if COORDINATOR.endswith("/compute/api"):
        # Live path: the verify POST is also the token check (G7). A 401 here
        # means the gateway is reachable but the key is wrong — report that as
        # the key check's failure, not a gateway outage.
        try:
            health = request_json(
                coordinator_path("/healthz", "/providers/verify"),
                method="POST", payload={"provider_id": PROVIDER_ID}, token=PROVIDER_KEY, timeout=5,
            )
        except RuntimeError as error:
            if str(error).startswith("HTTP 401"):
                ctx["key_rejected"] = True
                return ("pass", f"coordinator reachable — key verdict below · {COORDINATOR}", None)
            ctx["gateway_ok"] = False
            return ("fail", str(error), None)
        except Exception as error:
            ctx["gateway_ok"] = False
            return ("fail", str(error), None)
        ctx["gateway_ok"] = True
        return ("pass", f"{health.get('name', PROVIDER_ID)} · {COORDINATOR}", None)
    try:
        health = request_json(coordinator_path("/healthz", "/providers/verify"), timeout=5)
    except Exception as error:
        ctx["gateway_ok"] = False
        return ("fail", str(error), None)
    ctx["gateway_ok"] = True
    return ("pass", f"v{health.get('version', 'unknown')} · {COORDINATOR}", None)


def _check_ollama(ctx):
    try:
        installed = installed_models()
    except Exception as error:
        return ("fail", str(error), "is Ollama running? start it, then re-run: dasha-compute doctor")
    ctx["installed"] = installed
    # G5: fingerprint the server — port 11434 may be bound by a stale Ollama
    # or something else entirely, which would make the model list meaningless.
    try:
        version_body = request_json(f"{OLLAMA_URL}/api/version", timeout=5)
    except Exception:
        version_body = None
    if not isinstance(version_body, dict) or "version" not in version_body:
        netloc = urllib.parse.urlparse(OLLAMA_URL).netloc or OLLAMA_URL
        return (
            "fail",
            f"{netloc} does not answer as Ollama (is another service bound there?)",
            "set OLLAMA_URL to your Ollama, or free the port: lsof -ti tcp:11434 | xargs kill",
        )
    ctx["ollama_version_raw"] = version_body.get("version")
    netloc = urllib.parse.urlparse(OLLAMA_URL).netloc or OLLAMA_URL
    return ("pass", f"{len(installed)} model(s) in library · {netloc}", None)


def _check_ollama_version(ctx):
    floor = ".".join(str(part) for part in OLLAMA_MIN_VERSION)
    raw = ctx.get("ollama_version_raw")
    if "ollama_version_raw" not in ctx:
        return ("skip", "Ollama unreachable — version not checked", None)
    parsed = _parse_version(raw)
    if parsed is None:
        return ("warn", f"Ollama version unreadable ({raw!r}) — cannot confirm ≥ {floor}", "run: brew upgrade ollama")
    if parsed < OLLAMA_MIN_VERSION:
        return ("fail", f"found {raw}, need ≥ {floor}", "run: brew upgrade ollama")
    return ("pass", f"{raw} ≥ {floor}", None)


def _check_models(ctx):
    installed = ctx.get("installed")
    if installed is None:
        return ("skip", "Ollama unreachable — model list not checked", None)
    missing_pairs = [(public, local) for public, local in MODELS.items() if local not in installed]
    ctx["missing_pairs"] = missing_pairs
    if missing_pairs:
        return (
            "fail",
            "missing: " + ", ".join(local for _, local in missing_pairs),
            " or ".join(f"ollama pull {local}" for _, local in missing_pairs),
        )
    ready = [f"{public}→{local}" for public, local in MODELS.items()]
    return ("pass", f"ready: {', '.join(ready)}" if ready else "no models configured", None)


def _check_disk(ctx):
    # G6: a small free disk passes the Ollama check but dies mid-`ollama pull`.
    missing_pairs = ctx.get("missing_pairs")
    if missing_pairs is None:
        return ("skip", "Ollama unreachable — disk need not computed", None)
    if not missing_pairs:
        return ("pass", "all mapped models installed — nothing to pull", None)
    need_gb = sum(_missing_model_size_gb(public, tag) for public, tag in missing_pairs)
    models_dir = _ollama_models_dir()
    try:
        free_gb = _free_disk_gb(models_dir)
    except (OSError, ValueError) as error:
        return ("skip", f"cannot read free disk on {models_dir} ({error})", None)
    missing_tags = ", ".join(tag for _, tag in missing_pairs)
    detail = f"need ~{need_gb:.1f} GB for missing models ({missing_tags}), have {free_gb:.1f} GB free on {models_dir}"
    if free_gb >= need_gb * 1.5:  # headroom for temp files + KV cache
        return ("pass", detail, None)
    return ("fail", detail, "free space with: ollama rm <unused-model> — or shrink DASHA_MODEL_MAP")


def _check_memory_fit(ctx):
    # G11: warn-only — an 8 GB Mac registering gpt-oss-120b would OOM at first
    # job. The provider may still serve only the smaller mapped models.
    mem_gb = _unified_memory_gb()
    if mem_gb is None:
        return ("skip", "could not read unified memory", "see ADD-A-MODEL.md memory tiers")
    too_big = [public for public in MODELS if MODEL_SPECS.get(public, {}).get("min_memory_gb", 0) > mem_gb]
    viable = [public for public in MODELS if public not in too_big]
    if too_big:
        detail = "; ".join(f"{public} needs ≥ {MODEL_SPECS[public]['min_memory_gb']} GB unified memory" for public in too_big)
        detail += f" — this Mac has {mem_gb:.0f} GB; jobs on those models will likely OOM"
        remediation = f"serve only: {', '.join(viable)}" if viable else "shrink DASHA_MODEL_MAP to smaller models"
        return ("warn", detail, remediation)
    return ("pass", f"all mapped models fit in {mem_gb:.0f} GB unified memory", None)


def _check_key(ctx):
    # G7: validate the provider token against the coordinator's verify
    # endpoint. The token itself is never printed — only whether it validated.
    rejected = "coordinator rejected the provider token (401) — re-register this Mac on getdasha.com/compute → Provide"
    remediation = "run: dasha-compute uninstall, then re-run install.sh with a fresh key"
    if COORDINATOR.endswith("/compute/api"):
        # Live path: the gateway check already POSTed verify; reuse its verdict.
        if ctx.get("key_rejected"):
            return ("fail", rejected, remediation)
        if ctx.get("gateway_ok"):
            return ("pass", "coordinator accepted the provider token", None)
        return ("skip", "coordinator unreachable — token not checked", None)
    try:
        request_json(
            coordinator_path("/v1/providers/verify", "/providers/verify"),
            method="POST", payload={"provider_id": PROVIDER_ID}, token=PROVIDER_KEY, timeout=5,
        )
    except RuntimeError as error:
        message = str(error)
        if message.startswith("HTTP 401"):
            return ("fail", rejected, remediation)
        if message.startswith("HTTP 404"):
            return ("skip", "this coordinator has no verify endpoint — token not checked", None)
        return ("skip", f"could not verify token ({message})", None)
    except Exception as error:
        return ("skip", f"could not verify token ({error})", None)
    return ("pass", "coordinator accepted the provider token", None)


# Check registry: (machine name, display area, check fn). Each fn takes a
# shared ctx dict (earlier checks stash facts later checks reuse) and returns
# (status, detail, remediation) with status in pass|fail|warn|skip.
DOCTOR_CHECKS = [
    ("gateway", "gateway", _check_gateway),
    ("ollama", "ollama", _check_ollama),
    ("ollama-version", "ollama-version", _check_ollama_version),
    ("models", "models", _check_models),
    ("disk", "disk", _check_disk),
    ("memory-fit", "models", _check_memory_fit),
    ("key", "key", _check_key),
]


def _emit_check(area, status, detail, remediation):
    word = {"pass": "ok", "fail": "failed", "warn": "warn", "skip": "skip"}[status]
    line = f"{area:<10} {word} · {detail}"
    if status in ("fail", "warn"):
        print(line, file=sys.stderr)
        if remediation:
            if area == "models" and status == "fail":
                # keep the classic two-line pull hint
                print(f"{'pull':<10} {remediation}", file=sys.stderr)
            else:
                print(f"{'hint':<10} {remediation}", file=sys.stderr)
        return 1 if status == "fail" else 0
    print(line)
    return 0


def doctor(json_output=False):
    if not json_output:
        print("Dasha Compute provider doctor")
        print(f"hardware  {platform.system()} {platform.machine()} · Python {platform.python_version()}")
    ctx = {}
    results = []
    failures = 0
    for name, area, check in DOCTOR_CHECKS:
        try:
            status, detail, remediation = check(ctx)
        except Exception as error:
            status, detail, remediation = "fail", f"{type(error).__name__}: {error}", None
        results.append({"name": name, "area": area, "status": status, "detail": detail, "remediation": remediation})
        if not json_output:
            failures += _emit_check(area, status, detail, remediation)
        elif status == "fail":
            failures += 1
    if json_output:
        print(json.dumps({"checks": results, "exit_code": failures}, indent=2))
    return failures


def benchmark():
    installed = installed_models()
    rows = []
    tokens = max(16, min(256, int(os.getenv("DASHA_BENCHMARK_TOKENS", "64"))))
    for public, local in MODELS.items():
        if local not in installed:
            continue
        started = time.monotonic()
        result = request_json(f"{OLLAMA_URL}/api/chat", method="POST", payload={"model": local, "messages": [{"role": "user", "content": "In one paragraph, explain why local AI compute is useful."}], "stream": False, "options": {"temperature": 0, "num_predict": tokens}}, timeout=600)
        elapsed = time.monotonic() - started
        generated = int(result.get("eval_count") or 0)
        duration = int(result.get("eval_duration") or 0) / 1_000_000_000
        rows.append({"model": public, "ollama_model": local, "tokens": generated, "seconds": round(elapsed, 3), "tokens_per_second": round(generated / (duration or elapsed), 2)})
    report = {"measured_at": int(time.time() * 1000), "hardware": hardware(False), "results": rows}
    benchmark_path = os.getenv("DASHA_BENCHMARK_PATH")
    if benchmark_path:
        with open(benchmark_path, "w", encoding="utf-8") as output:
            json.dump(report, output)
    print(json.dumps(report, indent=2))
    return 0 if rows else 1


def stop(_signum, _frame):
    global RUNNING
    RUNNING = False


def main():
    parser = argparse.ArgumentParser(description="Run or inspect a Dasha Compute Ollama provider")
    parser.add_argument("--doctor", action="store_true", help="check the coordinator, Ollama and mapped models")
    parser.add_argument("--json", action="store_true", help="with --doctor: emit machine-readable JSON instead of human lines")
    parser.add_argument("--benchmark", action="store_true", help="measure configured Ollama model throughput")
    parser.add_argument("--once", action="store_true", help="poll once and exit")
    args = parser.parse_args()
    if not MODELS:
        raise SystemExit("DASHA_MODEL_MAP contains no valid public=ollama mappings")
    if args.doctor:
        raise SystemExit(doctor(json_output=args.json))
    if args.benchmark:
        raise SystemExit(benchmark())
    try:
        available = {public: local for public, local in MODELS.items() if local in installed_models()}
    except Exception as error:
        raise SystemExit(f"Ollama unavailable: {error}") from error
    if not available:
        raise SystemExit("No configured Ollama model is installed. Run with --doctor for pull commands.")
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print(f"dasha-compute provider {PROVIDER_NAME} ({PROVIDER_ID})")
    print("models: " + ", ".join(f"{public} → {local}" for public, local in available.items()))
    backoff = 1
    while RUNNING:
        try:
            response = request_json(
                coordinator_path("/v1/providers/poll", "/providers/poll"),
                method="POST",
                payload={"provider_id": PROVIDER_ID, "name": PROVIDER_NAME, "models": list(available), "hardware": hardware()},
                token=PROVIDER_KEY,
                timeout=35,
            )
            backoff = 1
            if not response:
                if args.once:
                    break
                time.sleep(1)
                continue
            job = response["job"]
            print(f"job {job['id']} · {job['model']} · {'stream' if job.get('stream') else 'complete'}")
            stop_heartbeat, cancelled = threading.Event(), threading.Event()
            heartbeat = threading.Thread(target=keep_lease, args=(job["id"], response.get("lease_seconds", 300), stop_heartbeat, cancelled), daemon=True)
            try:
                if COORDINATOR.endswith('/compute/api'):
                    heartbeat.start()
                if job.get("stream"):
                    if stream_ollama(job, cancelled):
                        print(f"completed {job['id']}")
                    else:
                        print(f"cancelled {job['id']}")
                else:
                    result = run_ollama(job)
                    stop_heartbeat.set()
                    if heartbeat.is_alive():
                        heartbeat.join(10)
                    if COORDINATOR.endswith('/compute/api') and renew_lease(job["id"]).get("cancelled"):
                        cancelled.set()
                    if cancelled.is_set():
                        print(f"cancelled {job['id']}")
                    else:
                        report(job["id"], result)
                        print(f"completed {job['id']}")
            except Exception as error:
                print(f"failed {job['id']}: {error}", file=sys.stderr)
                try:
                    if job.get("stream"):
                        report_chunk(job["id"], error=f"provider inference failed: {type(error).__name__}")
                    else:
                        report(job["id"], {"error": f"provider inference failed: {type(error).__name__}"})
                except Exception:
                    pass
            finally:
                stop_heartbeat.set()
                if heartbeat.is_alive():
                    heartbeat.join(10)
            if args.once:
                break
        except Exception as error:
            print(f"coordinator unavailable: {error}; retrying in {backoff}s", file=sys.stderr)
            if args.once:
                break
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
    print("provider stopped")


if __name__ == "__main__":
    main()

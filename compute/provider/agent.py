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
import ssl
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

# Python floor for the provider agent (G14), pinned in one place.
PYTHON_MIN_VERSION = (3, 10)

# LaunchAgent label — also the Keychain generic-password service label (-s),
# both written by install.sh. Keep in sync with LABEL in compute/install.sh.
PROVIDER_LABEL = "com.getdasha.compute.provider"

# Coordinator round-trip budget for the poll path (G13). Advisory only —
# doctor warns above this, never fails.
GATEWAY_RTT_WARN_S = 2.0

# Benchmark staleness threshold (G12): warn when benchmark.json is older.
BENCHMARK_MAX_AGE_DAYS = 30

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


def _doctor_platform():
    """(system, machine, mac_ver) for the G1/G3 checks.

    DASHA_DOCTOR_TEST_PLATFORM is a test-only hook ("system:machine[:mac_ver]",
    e.g. "Darwin:arm64:15.0") so the OS/MLX gates can be exercised off-macOS.
    Never set it in production.
    """
    override = os.getenv("DASHA_DOCTOR_TEST_PLATFORM")
    if override is not None:
        parts = override.split(":")
        system = parts[0] if len(parts) > 0 and parts[0] else platform.system()
        machine = parts[1] if len(parts) > 1 and parts[1] else platform.machine()
        mac_ver = parts[2] if len(parts) > 2 else ""
        return system, machine, mac_ver
    system, machine = platform.system(), platform.machine()
    mac_ver = platform.mac_ver()[0] if system == "Darwin" else ""
    return system, machine, mac_ver


def _install_dir():
    """The install.sh APP_DIR. doctor doubles as a pre-install checker, so
    the post-install checks (G9/G10/G12) gate on provider.env existing."""
    return os.path.expanduser("~/Library/Application Support/Dasha Compute")


def _doctor_installed():
    return os.path.isfile(os.path.join(_install_dir(), "provider.env"))


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


def _classify_connection_error(error):
    """G8: turn raw urlopen connection failures into readable doctor lines.

    Returns (detail, remediation) for the classified kinds (TLS, refused,
    timeout) or None when the error is something else (HTTP errors and DNS
    oddities keep their existing generic reporting).
    """
    chain, seen = error, set()
    while chain is not None and id(chain) not in seen and len(seen) < 10:
        seen.add(id(chain))
        if isinstance(chain, ssl.SSLCertVerificationError):
            return (
                "TLS verification failed — check date/time and that no VPN/proxy intercepts traffic",
                "fix the clock (System Settings → Date & Time), then re-run: dasha-compute doctor",
            )
        if isinstance(chain, ssl.SSLError):
            return (
                "TLS handshake failed — a proxy or captive portal may be intercepting traffic",
                "check VPN/proxy settings, then re-run: dasha-compute doctor",
            )
        if isinstance(chain, ConnectionRefusedError):
            return (
                f"connection refused — coordinator down or URL wrong (DASHA_COORDINATOR_URL={COORDINATOR})",
                "check the coordinator URL, then re-run: dasha-compute doctor",
            )
        if isinstance(chain, (socket.timeout, TimeoutError)):
            return (
                "timed out after 5s — firewall or DNS blocking?",
                "check network/VPN/DNS, then re-run: dasha-compute doctor",
            )
        chain = getattr(chain, "reason", None) or getattr(chain, "__cause__", None) or getattr(chain, "__context__", None)
    return None


def _gateway_rtt(measured_s):
    """G13: the measured coordinator round trip, with a test-only override.

    DASHA_DOCTOR_TEST_GATEWAY_RTT_S is a test-only hook so the egress-quality
    warn threshold can be exercised without a slow network. Never set it in
    production.
    """
    override = os.getenv("DASHA_DOCTOR_TEST_GATEWAY_RTT_S")
    if override is not None:
        try:
            return float(override)
        except ValueError:
            pass
    return measured_s


def _check_gateway(ctx):
    started = time.monotonic()
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
                ctx["gateway_ok"] = True  # it answered 401, so it is reachable
                ctx["gateway_rtt_s"] = _gateway_rtt(time.monotonic() - started)
                return ("pass", f"coordinator reachable — key verdict below · {COORDINATOR}", None)
            ctx["gateway_ok"] = False
            return ("fail", str(error), None)
        except Exception as error:
            ctx["gateway_ok"] = False
            classified = _classify_connection_error(error)
            if classified:
                detail, remediation = classified
                return ("fail", detail, remediation)
            return ("fail", str(error), None)
        ctx["gateway_ok"] = True
        ctx["gateway_rtt_s"] = _gateway_rtt(time.monotonic() - started)
        return ("pass", f"{health.get('name', PROVIDER_ID)} · {COORDINATOR}", None)
    try:
        health = request_json(coordinator_path("/healthz", "/providers/verify"), timeout=5)
    except Exception as error:
        ctx["gateway_ok"] = False
        classified = _classify_connection_error(error)
        if classified:
            detail, remediation = classified
            return ("fail", detail, remediation)
        return ("fail", str(error), None)
    ctx["gateway_ok"] = True
    ctx["gateway_rtt_s"] = _gateway_rtt(time.monotonic() - started)
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


def _check_os(ctx):
    # G1: the macOS + Apple Silicon gate. install.sh aborts on non-Darwin,
    # but agent.py --doctor can run standalone anywhere — a Linux download
    # should fail clearly before the provider registers.
    system, machine, mac_ver = _doctor_platform()
    ctx["os_system"], ctx["os_machine"], ctx["os_mac_ver"] = system, machine, mac_ver
    if system != "Darwin":
        return ("fail", "Dasha Compute providers require macOS", "see compute/README.md §2")
    if machine == "arm64":
        return ("pass", f"macOS {mac_ver or 'unknown'} on Apple Silicon", None)
    if machine == "x86_64":
        return ("warn", "Intel Mac detected — inference will be slow; Apple Silicon recommended", None)
    return ("warn", f"unrecognized architecture {machine} — Apple Silicon recommended", None)


def _check_python(ctx):
    # G14: Python version floor, pinned in PYTHON_MIN_VERSION.
    override = os.getenv("DASHA_DOCTOR_TEST_PYTHON_VERSION")
    parsed = _parse_version(override) if override is not None else None
    current = parsed if parsed is not None else sys.version_info[:3]
    found = override if override is not None else platform.python_version()
    floor = ".".join(str(part) for part in PYTHON_MIN_VERSION)
    if tuple(current) >= PYTHON_MIN_VERSION:
        return ("pass", f"{found} ≥ {floor}", None)
    return ("fail", f"found {found}, need ≥ {floor}", "install from python.org or: brew install python@3.12")


def _check_network(ctx):
    # G13: light egress-quality probe — time the D2 coordinator round trip
    # once. Advisory only: slow polls fail jobs at runtime, not in doctor.
    if not ctx.get("gateway_ok"):
        return ("skip", "coordinator unreachable — egress not measured", None)
    rtt = ctx.get("gateway_rtt_s")
    if rtt is None:
        return ("skip", "no round-trip measurement — egress not measured", None)
    if rtt > GATEWAY_RTT_WARN_S:
        return ("warn", f"coordinator round trip {rtt:.1f}s (job poll needs < {GATEWAY_RTT_WARN_S:.0f}s) — check Wi-Fi / VPN", None)
    return ("pass", f"coordinator round trip {rtt:.1f}s", None)


def _check_mlx(ctx):
    # G3: MLX capability flag — never fails. The line exists so the funnel
    # can measure the MLX-capable share of provider supply.
    system = ctx.get("os_system")
    machine = ctx.get("os_machine")
    mac_ver = ctx.get("os_mac_ver")
    if system is None:
        system, machine, mac_ver = _doctor_platform()
    if system != "Darwin":
        return ("skip", "MLX requires macOS — not applicable", None)
    if machine != "arm64":
        return ("warn", "mlx unavailable on Intel Macs", None)
    parsed = _parse_version(mac_ver)
    if parsed is not None and parsed >= (14, 0):
        return ("pass", f"M-series GPU usable (macOS {mac_ver})", None)
    return ("warn", f"mlx needs macOS ≥ 14 (this Mac: {mac_ver or 'unknown'})", "upgrade macOS to enable the MLX backend")


def _check_service(ctx):
    # G9: LaunchAgent / service state — post-install only. doctor doubles as
    # a pre-install checker in install.sh, so skip when provider.env is
    # absent (the source-tree case).
    if not _doctor_installed():
        return ("skip", "not installed — service check runs post-install", None)
    app_dir = _install_dir()
    for rel in ("agent.py", "provider.env"):
        if not os.path.isfile(os.path.join(app_dir, rel)):
            return ("fail", f"{os.path.join(app_dir, rel)} missing", "re-run install.sh")
    cli = os.path.expanduser("~/bin/dasha-compute")
    if not os.path.isfile(cli):
        return ("fail", f"{cli} missing", "re-run install.sh")
    # DASHA_DOCTOR_TEST_LAUNCHCTL is a test-only hook ("loaded" | "stopped" |
    # "missing") so the launchctl branch is exercisable off-macOS. Never set
    # it in production.
    hook = os.getenv("DASHA_DOCTOR_TEST_LAUNCHCTL")
    if hook == "loaded":
        return ("pass", f"LaunchAgent {PROVIDER_LABEL} loaded", None)
    if hook == "stopped":
        return ("pass", f"LaunchAgent {PROVIDER_LABEL} installed but not running — run: dasha-compute start", None)
    if hook == "missing":
        return ("fail", f"LaunchAgent {PROVIDER_LABEL} missing or not bootstrapped", "run: dasha-compute start")
    if platform.system() != "Darwin":
        return ("skip", "LaunchAgent is macOS-only", None)
    try:
        out = subprocess.run(
            ["launchctl", "print", f"gui/{os.getuid()}/{PROVIDER_LABEL}"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, ValueError) as error:
        return ("fail", f"launchctl unavailable ({error})", "run: dasha-compute start")
    if out.returncode != 0:
        return ("fail", f"LaunchAgent {PROVIDER_LABEL} missing or not bootstrapped", "run: dasha-compute start")
    state = "running" if "state = running" in out.stdout else "installed but not running — run: dasha-compute start"
    return ("pass", f"LaunchAgent {PROVIDER_LABEL} {state}", None)


def _check_keychain(ctx):
    # G10: Keychain readability of the provider token — post-install only.
    # run-provider reads it via `security find-generic-password` at every
    # start; a missing/denied item crash-loops the service silently. The
    # token itself is never printed — only whether the read succeeded.
    if not _doctor_installed():
        return ("skip", "not installed — Keychain check runs post-install", None)
    # DASHA_DOCTOR_TEST_KEYCHAIN is a test-only hook ("ok" | "denied").
    # Never set it in production.
    hook = os.getenv("DASHA_DOCTOR_TEST_KEYCHAIN")
    if hook == "ok":
        return ("pass", "provider token readable from Keychain", None)
    if hook == "denied":
        return ("fail", "cannot read the stored provider token", "re-run install.sh or check Keychain access prompts")
    if platform.system() != "Darwin":
        return ("skip", "Keychain is macOS-only", None)
    try:
        out = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-a", PROVIDER_ID, "-s", PROVIDER_LABEL, "-w"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, ValueError) as error:
        return ("fail", f"security tool unavailable ({error})", "re-run install.sh")
    if out.returncode != 0:
        return ("fail", "cannot read the stored provider token", "re-run install.sh or check Keychain access prompts")
    return ("pass", "provider token readable from Keychain", None)


def _check_benchmark(ctx):
    # G12: benchmark freshness — a Mac that degrades after install keeps
    # advertising stale throughput. Warn-only; missing file is info.
    if not _doctor_installed():
        return ("skip", "not installed — benchmark check runs post-install", None)
    path = os.getenv("DASHA_BENCHMARK_PATH")
    if not path:
        return ("skip", "DASHA_BENCHMARK_PATH not set — no benchmark configured", None)
    try:
        with open(path, encoding="utf-8") as source:
            measured_ms = json.load(source)["measured_at"]
    except (OSError, ValueError, KeyError):
        return ("skip", f"no benchmark.json at {path} yet", "run: dasha-compute benchmark")
    age_days = (time.time() * 1000 - measured_ms) / 86400_000
    if age_days > BENCHMARK_MAX_AGE_DAYS:
        return ("warn", f"benchmark.json is {age_days:.0f} days old", "refresh with: dasha-compute benchmark")
    return ("pass", f"benchmark.json is {age_days:.0f} days old", None)


# Check registry: (machine name, display area, check fn). Each fn takes a
# shared ctx dict (earlier checks stash facts later checks reuse) and returns
# (status, detail, remediation) with status in pass|fail|warn|skip.
DOCTOR_CHECKS = [
    ("os", "os", _check_os),
    ("python", "python", _check_python),
    ("gateway", "gateway", _check_gateway),
    ("network", "network", _check_network),
    ("ollama", "ollama", _check_ollama),
    ("ollama-version", "ollama-version", _check_ollama_version),
    ("models", "models", _check_models),
    ("disk", "disk", _check_disk),
    ("memory-fit", "models", _check_memory_fit),
    ("mlx", "mlx", _check_mlx),
    ("key", "key", _check_key),
    ("service", "service", _check_service),
    ("keychain", "keychain", _check_keychain),
    ("benchmark", "benchmark", _check_benchmark),
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

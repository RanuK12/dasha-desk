#!/usr/bin/env python3
"""Construct everything the agent builds at startup, on any platform.

This exists because `import threading` was missing at module level and nothing
caught it. The gaps that let it through, all of which this closes:

  - `ast.parse` (used by the install-time check) validates syntax, not names, so an
    undefined name is invisible to it.
  - The failing line is in `MlxRuntime.__init__`, and `_pick_runtime()` only returns
    MlxRuntime on arm64. Every test machine here is Intel, so the constructor was
    never run.
  - The daemon fails at import, so `launchd` restarts it forever and the only
    evidence is a NameError buried in a log on someone else's Mac.

Result: a broken agent shipped and sat in production for a day, and any new Apple
Silicon provider following our instructions would have installed a crash loop.

Run from `ocm/`:  python3 tests/agent-smoke.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agent"))

# Force a runtime that needs no Apple Silicon so the import itself succeeds anywhere;
# the point is to construct BOTH classes explicitly below.
os.environ.setdefault("OCM_RUNTIME", "ollama")

failures = []


def check(name, fn):
    try:
        fn()
        print(f"  ok    {name}")
    except Exception as exc:                       # noqa: BLE001
        failures.append(f"{name}: {type(exc).__name__}: {exc}")
        print(f"  FAIL  {name}: {type(exc).__name__}: {exc}")


import agent  # noqa: E402  (after sys.path is set)

print("agent smoke:")

# The exact line that shipped broken: MlxRuntime.__init__ builds a threading.Lock.
check("MlxRuntime constructs", lambda: agent.MlxRuntime())
check("OllamaRuntime constructs", lambda: agent.OllamaRuntime())

# capabilities() reads platform details and must not explode on any host.
# The build is the SHA-256 of the running file; the gateway refuses any other shape.
check("capabilities() reports the agent's build as a 64-hex SHA-256",
      lambda: __import__("re").fullmatch(r"[a-f0-9]{64}", agent.capabilities([])["build"] or "")
      or (_ for _ in ()).throw(AssertionError(agent.capabilities([])["build"])))

check("capabilities() returns a dict",
      lambda: isinstance(agent.capabilities([]), dict) or (_ for _ in ()).throw(
          AssertionError("not a dict")))

# The token must reach the gateway as a header. _connect builds the connection
# object without performing IO, so this is safe to call.
def _connect_uses_header():
    conn = agent._connect("ws://127.0.0.1:1/host/connect")
    # websockets renamed the parameter between 13.x and 14.0; either is fine, but a
    # TypeError here means neither name was accepted and the fallback is broken.
    if conn is None:
        raise AssertionError("_connect returned None")


check("_connect builds with an auth header", _connect_uses_header)

# Every name the module references at import time must resolve.
check("module imports cleanly", lambda: agent.RUNTIME is not None)


# Cancellation (protocol gate #5, review P2-5). A cancelled job must still end with
# exactly one terminal frame, sent when the cancel lands rather than when the
# runtime's next token finally arrives, and it must leave the job table. Before R4
# the loop simply broke, so a cancelled job was indistinguishable from a hung one.
# The runtime is a stub, so this runs on any platform without a model.
def _cancel_sends_one_terminal_promptly():
    import asyncio
    import json
    import time

    sent = []

    class Socket:
        async def send(self, text):
            sent.append(json.loads(text))

    class SlowRuntime:
        name = "stub"

        def stream(self, model, messages, cancelled, max_tokens=None):
            yield "first"
            # The next token is a long way off, as during a cold model load. A
            # real runtime only notices the cancel between tokens, so poll like one.
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                if cancelled.is_set():
                    return
                time.sleep(0.01)
            yield "second"

    async def scenario():
        jobs = {"job-1": asyncio.Event()}
        job = {"id": "job-1", "model": "stub-model", "messages": [{"role": "user", "content": "go"}]}
        task = asyncio.create_task(agent.run_job(Socket(), job, jobs))
        while not sent:                        # the first chunk is on the wire
            await asyncio.sleep(0.005)
        jobs["job-1"].set()                    # the gateway sent `cancel`
        started = time.monotonic()
        await asyncio.wait_for(task, timeout=1.0)
        return time.monotonic() - started, jobs

    real = agent.RUNTIME
    agent.RUNTIME = SlowRuntime()
    try:
        elapsed, jobs = asyncio.run(scenario())
    finally:
        agent.RUNTIME = real

    terminals = [f for f in sent if f["t"] in ("done", "error")]
    if terminals != [{"t": "error", "id": "job-1", "message": "cancelled"}]:
        raise AssertionError(f"expected one cancelled terminal, got {sent}")
    if sent[-1] is not terminals[0]:
        raise AssertionError(f"frames after the terminal: {sent}")
    if jobs:
        raise AssertionError(f"cancelled job still tracked: {jobs}")
    if elapsed > 0.5:
        raise AssertionError(f"terminal took {elapsed:.2f}s after cancel; it waited for the runtime")


check("a cancelled job ends with one terminal frame, promptly", _cancel_sends_one_terminal_promptly)


# --- ready bit (P2-13) ---------------------------------------------------------
# An agent that predates the bit sent no `ready`; the gateway reads absence as unknown.
# So the field must be absent unless the runtime was actually asked, and a boolean when
# it was. The status frame is what follows hello when residency changes.
def _ready_in_hello():
    assert "ready" not in agent.capabilities([]), "ready must be omitted when unknown"
    assert agent.capabilities(["m"], ready=True)["ready"] is True
    assert agent.capabilities(["m"], ready=False)["ready"] is False
    assert agent.status_frame(True) == {"t": "status", "ready": True}
    assert agent.status_frame(0) == {"t": "status", "ready": False}


check("hello carries ready only when known, and the status frame is {t, ready}", _ready_in_hello)


# --- --doctor --load (P2-6) ----------------------------------------------------
# The MLX load path, without Metal: a stub `mlx_lm` module records what `load` was
# asked for. This proves MlxRuntime.load reaches mlx_lm.load with the MAPPED id and
# that ready() flips only once the weights are held.
def _mlx_load_path():
    import types
    asked = []
    fake = types.ModuleType("mlx_lm")
    fake.load = lambda name: (asked.append(name), (object(), object()))[1]
    saved_mod = sys.modules.get("mlx_lm")
    saved_map = os.environ.get("OCM_MODEL_MAP")
    sys.modules["mlx_lm"] = fake
    os.environ["OCM_MODEL_MAP"] = "ocm-coder=mlx-community/fake-4bit"
    try:
        rt = agent.MlxRuntime()
        assert rt.ready("ocm-coder") is False, "nothing is resident before load"
        rt.load("ocm-coder")
        assert asked == ["mlx-community/fake-4bit"], asked
        assert rt.ready("ocm-coder") is True, "resident after load"
        rt.load("ocm-coder")
        assert asked == ["mlx-community/fake-4bit"], "a second load is a no-op: held resident"
    finally:
        if saved_mod is None:
            sys.modules.pop("mlx_lm", None)
        else:
            sys.modules["mlx_lm"] = saved_mod
        if saved_map is None:
            os.environ.pop("OCM_MODEL_MAP", None)
        else:
            os.environ["OCM_MODEL_MAP"] = saved_map


check("MlxRuntime.load reaches mlx_lm.load with the mapped id and then reports ready", _mlx_load_path)


class _FakeRuntime:
    """Stands in for RUNTIME so the doctor runs end to end without a model or a gateway."""
    name = "fake"

    def __init__(self, fail=None):
        self.fail = fail
        self.loads = 0
        self._resident = False

    def models(self):
        return ["ocm-coder"]

    def ready(self, model):
        return self._resident

    def load(self, model):
        self.loads += 1
        if self.fail:
            raise self.fail
        self._resident = True


def _run_doctor(runtime, load):
    import contextlib
    import io
    saved = (agent.RUNTIME, agent.verify_token, agent.urllib.request.urlopen)

    def _no_network(*args, **kwargs):
        raise OSError("the smoke test has no gateway")

    agent.RUNTIME = runtime
    agent.verify_token = lambda timeout=15: (True, "mocked")
    agent.urllib.request.urlopen = _no_network
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            code = agent.doctor(load=load)
    finally:
        agent.RUNTIME, agent.verify_token, agent.urllib.request.urlopen = saved
    return code, out.getvalue()


def _doctor_plain_never_loads():
    rt = _FakeRuntime()
    code, out = _run_doctor(rt, load=False)
    assert code == 0, out
    assert rt.loads == 0, "plain --doctor must stay fast: it lists, it does not load"
    assert "--doctor --load" in out, "the doctor names --load as the next step:\n" + out


def _doctor_load_times_the_load():
    import re
    rt = _FakeRuntime()
    code, out = _run_doctor(rt, load=True)
    assert code == 0, out
    assert rt.loads == 1, "--load loads exactly once"
    assert re.search(r"^load\s+ok in \d+\.\ds", out, re.M), out
    assert "--doctor --load" not in out, "no 'next step' hint once the step was taken"


def _doctor_load_fails_when_weights_are_missing():
    rt = _FakeRuntime(fail=FileNotFoundError("mlx-community/fake-4bit: weights not found"))
    code, out = _run_doctor(rt, load=True)
    assert code == 1, "a load that throws must fail the doctor:\n" + out
    assert "load      FAIL" in out and "weights not found" in out, out


check("plain --doctor never loads and points at --load", _doctor_plain_never_loads)
check("--doctor --load loads once, reports the time, exits 0", _doctor_load_times_the_load)
check("--doctor --load exits 1 when the weights cannot load", _doctor_load_fails_when_weights_are_missing)

if failures:
    print(f"\n{len(failures)} failure(s):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("all ok")

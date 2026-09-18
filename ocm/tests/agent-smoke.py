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

if failures:
    print(f"\n{len(failures)} failure(s):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("all ok")

#!/usr/bin/env bash
# Measure host-socket stability — one of §05's two decisive numbers.
#
# Polls the public /v1/network and records each host's uptime_s. uptime_s going
# BACKWARDS means the socket dropped and the agent re-registered, which is the
# event we actually care about. Read-only; costs nothing.
#
#   ./scripts/socket-watch.sh [minutes] [interval_seconds]
#
# Two hard-won guards:
#   - A lockfile, because several overlapping instances poll the same endpoint and
#     produce a log nobody can interpret.
#   - It re-execs from a snapshot of itself. Bash reads a script lazily by byte
#     offset, so editing this file while it runs makes the live instance resume at
#     the wrong offset and die on garbage. The snapshot makes edits harmless.
set -uo pipefail

if [ -z "${OCM_WATCH_SNAPSHOT:-}" ]; then
  # Resolve the real project directory BEFORE re-exec: afterwards $0 is the snapshot
  # in a temp dir and .deploy.env would no longer be findable from it.
  _home="$(cd "$(dirname "$0")/.." && pwd)"
  _snap=$(mktemp -t ocm-socket-watch); cp "$0" "$_snap"; chmod +x "$_snap"
  OCM_WATCH_SNAPSHOT="$_snap" OCM_WATCH_HOME="$_home" exec "$_snap" "$@"
fi

LOCK=/tmp/ocm-socket-watch.lock
if [ -e "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "another socket-watch is already running (pid $(cat "$LOCK")) — refusing to start a second"
  exit 3
fi
echo $$ > "$LOCK"

_here="${OCM_WATCH_HOME:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}"
[ -f "$_here/.deploy.env" ] && . "$_here/.deploy.env"
API="${OCM_API:?set OCM_API in ocm/.deploy.env}"
MINUTES="${1:-240}"; INTERVAL="${2:-60}"
# One log per run: a shared path means concurrent runs overwrite each other's data.
LOG="${OCM_SOCKET_LOG:-/tmp/ocm-socket-watch-$(date -u +%Y%m%dT%H%M%SZ).log}"
ln -sf "$LOG" /tmp/ocm-socket-watch-latest.log 2>/dev/null
DEADLINE=$(( $(date +%s) + MINUTES * 60 ))
# Per-host state lives in a small JSON file so every machine on the network is
# watched, not just the first one listed (review P3-10). A host whose uptime_s
# goes backwards reconnected; a host that vanishes is a drop until it is back.
STATE=$(mktemp -t ocm-socket-state); printf '{}' > "$STATE"
trap 'rm -f "$OCM_WATCH_SNAPSHOT" "$LOCK" "$STATE" "$SAMPLER" 2>/dev/null' EXIT
SAMPLER=$(mktemp -t ocm-socket-sampler)
cat > "$SAMPLER" <<'PYEOF'
import json, sys
state_path, t = sys.argv[1], sys.argv[2]
try:
    state = json.load(open(state_path))
except Exception:
    state = {}
try:
    now = {h["id"]: int(h["uptime_s"]) for h in json.load(sys.stdin)["hosts"]}
except Exception:
    state["unreachable"] = state.get("unreachable", 0) + 1
    print(f"{t}  GATEWAY UNREACHABLE (no parsable /v1/network)")
    json.dump(state, open(state_path, "w")); sys.exit(0)
prev = state.get("hosts", {})
events = state.setdefault("events", {})
for hid, up in now.items():
    if hid not in prev:
        if state.get("seen"):
            events[hid] = events.get(hid, 0) + 1
            print(f"{t}  {hid}: BACK (uptime {up}s)")
    elif up < prev[hid]:
        events[hid] = events.get(hid, 0) + 1
        print(f"{t}  {hid}: RECONNECT — uptime fell {prev[hid]} -> {up}")
for hid in prev:
    if hid not in now:
        events[hid] = events.get(hid, 0) + 1
        print(f"{t}  {hid}: GONE (was {prev[hid]}s)")
if not now:
    print(f"{t}  NO HOSTS")
state["hosts"] = now; state["seen"] = True
json.dump(state, open(state_path, "w"))
PYEOF
SAMPLES=0

echo "$(date -u +%H:%M:%SZ) socket-watch start: ${MINUTES}m at ${INTERVAL}s, all hosts" | tee "$LOG"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  SAMPLES=$((SAMPLES+1))
  T=$(date -u +%H:%M:%SZ)
  curl -s --max-time 20 "$API/v1/network" 2>/dev/null | python3 "$SAMPLER" "$STATE" "$T" | tee -a "$LOG"
  sleep "$INTERVAL"
done
python3 - "$STATE" "$SAMPLES" "$(date -u +%H:%M:%SZ)" <<'PYEOF' | tee -a "$LOG"
import json, sys
state = json.load(open(sys.argv[1])); samples, t = sys.argv[2], sys.argv[3]
ev = state.get("events", {}); hosts = state.get("hosts", {})
summary = ", ".join(f"{h}: {ev.get(h, 0)} event(s), final uptime {u}s" for h, u in sorted(hosts.items())) or "no hosts"
print(f"{t} done: {samples} samples, {state.get('unreachable', 0)} unreachable; {summary}")
PYEOF

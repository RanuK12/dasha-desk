#!/bin/sh
# OCM provider installer for macOS (Apple Silicon).
#
# Read this before running it: piping an unread script into a shell is a bad habit.
# It is about 700 lines. The two parts worth your attention are the token check at the
# top, which runs before anything is written, and the launchd handling at the end.
#
# To see what it would do before letting it:
#   sudo OCM_AGENT_ID="my-mac" sh install.sh --dry-run
# That runs every check, reports what would be written and as whom, and exits before
# anything is downloaded or written. It needs no code or token. Given a token it checks
# it against the gateway; given an enrollment code it leaves the code unspent.
#
# What it does:
#   1. refuses to run on anything but Apple Silicon macOS
#   2. requires an existing, explicitly located uv binary
#   3. downloads the agent over HTTPS, checks it against the checksum the gateway
#      publishes, and proves its doctor path before replacing files
#   4. stores your provider token in an owner-only environment file; every file it
#      installs is written beside its destination and renamed into place
#   5. installs a launchd daemon that runs as the invoking non-root user
#   6. installs ocm-agent-token, ocm-agent-update and ocm-agent-uninstall beside it
#
# Human path — get an enrollment code from the console (Enroll a machine), then:
#   sudo OCM_AGENT_ID="my-mac" sh install.sh
# It prompts for the code with echo off and exchanges it, over HTTPS, for a provider
# token that is already bound to this machine. The code is single-use and expires in
# minutes, so nothing long-lived is ever typed. Enrolling the same machine name again
# rotates it: the old token is revoked once the new one exists.
#
# A provider token works everywhere a code does. To hand one over without putting it
# on argv or in shell history, prompt with echo off and hand the variable to sudo:
#   read -rsp "Provider token: " OCM_HOST_TOKEN
#   printf '\n'
#   sudo --preserve-env=OCM_HOST_TOKEN sh install.sh
#
# Running this script under sudo without OCM_HOST_TOKEN set also prompts, with
# terminal echo disabled. Automation may use a secret file or stdin instead, holding
# either a code or a token:
#   sudo env OCM_HOST_TOKEN_FILE=/path/to/token sh install.sh
#   sudo sh install.sh < /path/to/token
#
# Optional:
#   OCM_AGENT_ID="my-mac"   the name this machine registers under. Optional: a
#                           reinstall keeps the name already in /etc/ocm/agent.env,
#                           and a first install defaults to the hostname plus six
#                           characters derived from the hardware id (mb1-2c9265),
#                           so two Macs with the same hostname cannot register as one.
#   OCM_MODEL_MAP="public=local,…"  what this machine advertises. Defaults to
#                           ocm-coder=<the MLX coder model>, which is the name
#                           consumers actually request.
#   OCM_UV_BIN="/opt/homebrew/bin/uv"  explicit uv path when sudo has a narrow PATH.
#   OCM_RUN_USER="alice"    account that runs inference. Defaults to SUDO_USER and
#                           may never be root.
#   OCM_REGION="us-west-2"  what the machine reports as its region. A reinstall keeps
#                           the value already in /etc/ocm/agent.env; unset means "local".
set -eu

# Root must not inherit a caller-controlled PATH while downloading or installing
# executable code. Homebrew locations are included after the system directories.
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:/var/root/.local/bin
export PATH

GATEWAY="${OCM_GATEWAY_URL:-wss://api.ocm.getdasha.com}"
# The download and credential-check origin is derived from the socket origin. A
# second arbitrary source URL previously allowed a token to be checked against one
# deployment while root downloaded executable code from another.
SOURCE=$(printf '%s\n' "$GATEWAY" | sed 's|^wss://|https://|')
# The machine's name, in order: OCM_AGENT_ID if given; the name already recorded in
# /etc/ocm/agent.env, so a reinstall recovers the existing host instead of registering
# a second one; otherwise the hostname plus six hex characters derived from the
# hardware id, so identically named Macs cannot collide. The suffix is a hash of the
# platform UUID and never the serial number: the name is published on /v1/network.
# --- name default (begin)
AGENT_ID="${OCM_AGENT_ID:-$(sed -n 's|^OCM_AGENT_ID=||p' /etc/ocm/agent.env 2>/dev/null | head -1)}"
if [ -n "$AGENT_ID" ]; then
  if [ -n "${OCM_AGENT_ID:-}" ]; then AGENT_ID_FROM="OCM_AGENT_ID"; else AGENT_ID_FROM="kept from /etc/ocm/agent.env"; fi
else
  PLATFORM_UUID=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | sed -n 's/.*"IOPlatformUUID" = "\(.*\)"/\1/p' | head -1)
  [ -n "$PLATFORM_UUID" ] || { printf '\nerror: could not read the hardware id; set OCM_AGENT_ID to name this machine\n' >&2; exit 1; }
  HWID=$(printf '%s' "$PLATFORM_UUID" | shasum -a 256 | cut -c1-6)
  HOST_SHORT=$(hostname -s | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._\n-' '-' | cut -c1-56)
  AGENT_ID="${HOST_SHORT:-mac}-$HWID"
  AGENT_ID_FROM="hostname + hardware id"
fi
# --- name default (end)
# What this machine ADVERTISES to consumers. Without a map an MLX host advertises
# the raw model id, which no consumer asks for — the docs, the console and every
# example say `ocm-coder`, so a provider installed by this script was invisible to
# the people it was meant to serve. `ocm-coder` is a public alias for the coder
# model, which is exactly what OCM_MODEL_MAP exists to express.
MLX_MODEL="${OCM_MLX_MODEL:-mlx-community/Qwen2.5-Coder-7B-Instruct-4bit}"
MODEL_MAP="${OCM_MODEL_MAP:-ocm-coder=$MLX_MODEL}"
RUN_USER="${OCM_RUN_USER:-${SUDO_USER:-}}"
PREFIX=/opt/ocm

die() { printf '\nerror: %s\n' "$1" >&2; exit 1; }
# Length is bounded by ${#} rather than in the pattern: BSD grep on macOS 15 rejects
# any repetition bound above 255 ("maximum repetition exceeds 255"), so a 512-wide bound
# aborted the installer on the first real Mac it met.
matches() {
  if [ -n "${3:-}" ] && [ "${#1}" -gt "$3" ]; then return 1; fi
  printf '%s\n' "$1" | LC_ALL=C grep -Eq "$2"
}
curl_https() {
  curl --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 "$@"
}
# The token reaches curl as one config line on stdin (-K -), never as an argument:
# -H "Authorization: Bearer …" is argv, readable by every local process for the life
# of the request. printf is a builtin, so the value is never an argument to any
# process, and nothing is written to disk.
curl_bearer() {
  printf 'header = "Authorization: Bearer %s"\n' "$OCM_HOST_TOKEN" | curl_https -K - "$@"
}
# --- put (begin)
# Every file this script installs is copied to a sibling of its destination, given its
# final mode and owner there, and renamed into place. A failure mid-write then leaves
# the previous file whole instead of truncated, and nothing appears under the final
# name before it is complete. The sibling, not $TMPDIR, is what makes the rename
# atomic rather than a copy across filesystems.
PUT_TMP=""
put() {  # put MODE OWNER SOURCE DEST
  PUT_TMP=$(mktemp "$4.XXXXXX") || die "could not create a temporary file beside $4"
  cp "$3" "$PUT_TMP" && chown "$2" "$PUT_TMP" && chmod "$1" "$PUT_TMP" \
    && mv -f "$PUT_TMP" "$4" \
    || { rm -f "$PUT_TMP"; die "could not install $4; what was there before is untouched"; }
  PUT_TMP=""
}
# --- put (end)

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) die "usage: sudo sh install.sh [--dry-run]" ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS"
[ "$(uname -m)" = "arm64" ] || die "Apple Silicon is required — MLX cannot run on an Intel Mac"
[ "$(id -u)" = "0" ] || die "run with sudo: installing the launchd daemon needs root"

# Resolve the provider token without requiring it on argv. Putting the secret
# on sudo's environment command line would also put it in shell history and
# the process list. Never print the value.
if [ -z "${OCM_HOST_TOKEN:-}" ] && [ -n "${OCM_HOST_TOKEN_FILE:-}" ]; then
  matches "$OCM_HOST_TOKEN_FILE" '^/[-A-Za-z0-9._/+]+$' 512 \
    || die "OCM_HOST_TOKEN_FILE must be a safe absolute path"
  [ -f "$OCM_HOST_TOKEN_FILE" ] && [ -r "$OCM_HOST_TOKEN_FILE" ] \
    || die "OCM_HOST_TOKEN_FILE is missing or unreadable"
  IFS= read -r OCM_HOST_TOKEN < "$OCM_HOST_TOKEN_FILE" || true
fi
if [ -z "${OCM_HOST_TOKEN:-}" ] && [ "$DRY_RUN" = 1 ] && [ -t 0 ]; then
  : # a dry run asks for nothing; the real run prompts here
elif [ -z "${OCM_HOST_TOKEN:-}" ]; then
  if [ -t 0 ]; then
    printf 'Provider token or enrollment code (input is hidden): ' >&2
    if stty_state=$(stty -g 2>/dev/null); then
      stty -echo
      IFS= read -r OCM_HOST_TOKEN || true
      stty "$stty_state"
    else
      IFS= read -r OCM_HOST_TOKEN || true
    fi
    printf '\n' >&2
  else
    IFS= read -r OCM_HOST_TOKEN || true
  fi
fi
[ -n "${OCM_HOST_TOKEN:-}" ] || [ "$DRY_RUN" = 1 ] || die "provide OCM_HOST_TOKEN via --preserve-env, OCM_HOST_TOKEN_FILE, stdin, or the hidden prompt"
# The prompt, file and stdin paths leave this as a plain shell variable. The doctor
# below runs under `sudo -u … --preserve-env=OCM_HOST_TOKEN`, which can only carry an
# exported one; without this line every path except --preserve-env failed the doctor
# with "OCM_HOST_TOKEN is not set".
export OCM_HOST_TOKEN
[ -n "$RUN_USER" ] || die "run through sudo from the account that should run inference, or set OCM_RUN_USER"
[ "$RUN_USER" != root ] || die "the OCM inference daemon may not run as root; set OCM_RUN_USER to a normal account"

# Every value below is written to a shell-sourced environment file or generated
# wrapper. The allowlists are therefore a code-execution boundary, not cosmetic
# validation.
matches "$GATEWAY" '^wss://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' \
  || die "OCM_GATEWAY_URL must be a bare wss:// host with an optional port"
matches "$SOURCE" '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' \
  || die "the gateway could not be converted to a safe HTTPS source"
# The agent id is validated before the enrollment exchange below, because it goes
# into that request body.
matches "$AGENT_ID" '^[-A-Za-z0-9._]{1,64}$' \
  || die "OCM_AGENT_ID may contain only letters, numbers, dot, underscore and hyphen (64 max)"

# A code works once, and exchanging it revokes the machine's older token, so a dry run
# leaves it unspent and only reports that the exchange would happen.
ENROLL_PENDING=0
if [ "$DRY_RUN" = 1 ] && matches "$OCM_HOST_TOKEN" '^ocm_enroll_[-A-Za-z0-9_]{16,}$'; then
  ENROLL_PENDING=1
  OCM_HOST_TOKEN=""
fi
# An enrollment code is exchanged for a provider token before anything else happens.
# The code travels in a JSON body over HTTPS on curl's stdin, never in a URL, a log
# line or argv (--data "…" would be argv, visible in ps); the
# gateway mints a token already bound to this agent id and revokes any older token
# bound to the same id on the same account, so re-enrolling is how a machine rotates.
if matches "$OCM_HOST_TOKEN" '^ocm_enroll_[-A-Za-z0-9_]{16,}$'; then
  printf 'exchanging the enrollment code for a provider token …\n'
  # The body reaches curl on stdin (--data @-). --data "…" would be argv, visible in
  # ps for the life of the request; printf is a builtin, so the code is never an
  # argument to any process.
  ENROLL_BODY="{\"code\":\"$OCM_HOST_TOKEN\",\"agent_id\":\"$AGENT_ID\"}"
  ENROLL=$(printf '%s' "$ENROLL_BODY" | curl_https --fail -H 'content-type: application/json' \
    --data @- "$SOURCE/v1/provider/enroll" 2>/dev/null) || {
    REASON=$(printf '%s' "$ENROLL_BODY" | curl_https -H 'content-type: application/json' \
      --data @- "$SOURCE/v1/provider/enroll" 2>/dev/null \
      | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')
    die "${REASON:-could not reach $SOURCE to exchange the enrollment code}
  nothing was installed"
  }
  OCM_HOST_TOKEN=$(printf '%s' "$ENROLL" | sed -n 's/.*"token":"\(ocm_host_[-A-Za-z0-9_]*\)".*/\1/p')
  [ -n "$OCM_HOST_TOKEN" ] || die "the gateway did not return a provider token for that enrollment code
  nothing was installed"
  export OCM_HOST_TOKEN
  ROTATED=$(printf '%s' "$ENROLL" | sed -n 's/.*"rotated":\([0-9]*\).*/\1/p')
  printf '  enrolled as %s\n' "$AGENT_ID"
  if [ -n "$ROTATED" ] && [ "$ROTATED" != 0 ]; then
    printf '  (rotated %s older token(s) for this machine)\n' "$ROTATED"
  fi
fi
if [ -n "$OCM_HOST_TOKEN" ] || [ "$DRY_RUN" = 0 ]; then
  matches "$OCM_HOST_TOKEN" '^ocm_host_[-A-Za-z0-9_]{16,}$' \
    || die "OCM_HOST_TOKEN must be an issued provider token beginning ocm_host_, or an ocm_enroll_ code"
fi
matches "$MLX_MODEL" '^[-A-Za-z0-9._/:@+]+$' 512 \
  || die "OCM_MLX_MODEL contains unsupported characters or is too long"
matches "$MODEL_MAP" '^[-A-Za-z0-9._/:@=,+]+$' 2048 \
  || die "OCM_MODEL_MAP contains unsupported characters or is too long"
matches "$RUN_USER" '^[-A-Za-z0-9._]{1,64}$' \
  || die "OCM_RUN_USER contains unsupported characters"
# A reinstall or update must not silently drop the region a machine already reports.
# Explicit OCM_REGION wins; otherwise keep what the existing env file says; otherwise
# leave it unset and the agent reports "local".
REGION="${OCM_REGION:-$(sed -n 's|^OCM_REGION=||p' /etc/ocm/agent.env 2>/dev/null | head -1)}"
if [ -n "$REGION" ]; then
  matches "$REGION" '^[-A-Za-z0-9._]{1,32}$' \
    || die "OCM_REGION contains unsupported characters"
fi
id "$RUN_USER" >/dev/null 2>&1 || die "OCM_RUN_USER does not name a local account"
RUN_HOME=$(dscl . -read "/Users/$RUN_USER" NFSHomeDirectory 2>/dev/null \
  | awk '{ print $2; exit }')
[ -n "$RUN_HOME" ] || die "could not determine the home directory for OCM_RUN_USER"
matches "$RUN_HOME" '^/[-A-Za-z0-9._/+]+$' 512 \
  || die "the provider account home directory contains unsupported characters"

# Require uv rather than piping a third party installer into a root shell. Homebrew's
# default Apple Silicon path and the provider user's local path are checked explicitly.
# OCM_UV_BIN is accepted only when it is an absolute executable path with a shape
# that cannot break the generated wrapper.
UV="${OCM_UV_BIN:-}"
if [ -z "$UV" ]; then
  UV=$(command -v uv 2>/dev/null || true)
fi
if [ -z "$UV" ]; then
  for candidate in /opt/homebrew/bin/uv /usr/local/bin/uv "$RUN_HOME/.local/bin/uv"; do
    if [ -x "$candidate" ]; then UV=$candidate; break; fi
  done
fi
[ -n "$UV" ] && [ -x "$UV" ] \
  || die "uv is required before running this root installer. Install it yourself (for example: brew install uv), then rerun with OCM_UV_BIN=\"$(command -v uv 2>/dev/null || echo /opt/homebrew/bin/uv)\""
matches "$UV" '^/[-A-Za-z0-9._/+]+$' 512 \
  || die "OCM_UV_BIN must be a safe absolute executable path"
sudo -u "$RUN_USER" test -x "$UV" \
  || die "OCM_UV_BIN is not executable by OCM_RUN_USER"

# Check the credential BEFORE downloading or replacing anything. Fail here, with a
# useful reason, while the operator is still watching the terminal. A dry run without
# a token still proves the gateway is the one it would download from.
# --- token check (begin)
if [ -n "$OCM_HOST_TOKEN" ]; then
  printf 'checking your provider token …\n'
  VERIFY=$(curl_bearer --fail "$SOURCE/v1/provider/verify" 2>/dev/null) || {
    REASON=$(curl_bearer "$SOURCE/v1/provider/verify" 2>/dev/null \
      | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')
    die "${REASON:-could not reach $SOURCE to check the token}"
  }
  printf '%s' "$VERIFY" | grep -q '"ok":true' \
    || die "the gateway response did not confirm this provider token"
  printf '  token accepted\n'
  CREDENTIAL="provider token, accepted by the gateway"
else
  printf 'checking the gateway …\n'
  curl_https --fail "$SOURCE/install.sh.sha256" -o /dev/null 2>/dev/null \
    || die "could not reach $SOURCE"
  printf '  reachable\n'
  if [ "$ENROLL_PENDING" = 1 ]; then
    CREDENTIAL="enrollment code, left unspent; the real run exchanges it for a token bound to $AGENT_ID"
  else
    CREDENTIAL="none given; the real run prompts for one with typing hidden"
  fi
fi
# --- token check (end)

printf 'OCM provider install\n  host    %s (%s)\n  user    %s\n  gateway %s\n  serving %s\n\n' \
  "$AGENT_ID" "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo mac)" \
  "$RUN_USER" "$GATEWAY" "$MODEL_MAP"

# Everything above only reads. A dry run says what the rest would do, then stops.
if [ "$DRY_RUN" = 1 ]; then
  if [ -r /etc/ocm/agent.env ]; then
    EXISTING="reinstall over an agent currently enrolled as $(sed -n 's|^OCM_AGENT_ID=||p' /etc/ocm/agent.env | head -1)"
  else
    EXISTING="fresh install; there is no /etc/ocm/agent.env"
  fi
  if launchctl print system/com.ocm.agent >/dev/null 2>&1; then
    DAEMON="loaded; it would be stopped and started again on the new files"
  else
    DAEMON="not loaded; it would be created and started"
  fi
  HUB="$RUN_HOME/.cache/huggingface/hub/models--$(printf '%s' "$MLX_MODEL" | sed 's|/|--|g')"
  if [ -d "$HUB" ]; then
    CACHE="present, $(du -sh "$HUB" 2>/dev/null | cut -f1); the installer does not touch it"
  else
    CACHE="absent; about 4.5 GB downloads on the first request, not during install"
  fi
  # The build the gateway would install is the first twelve characters of the checksum
  # it publishes for agent.py; the real run refuses a download that does not match it.
  SERVED=$(curl_https --fail "$SOURCE/agent.py.sha256" 2>/dev/null | cut -c1-12)
  if [ -z "$SERVED" ]; then
    BUILD="unknown; $SOURCE/agent.py.sha256 could not be fetched, and the real run stops there"
  elif [ -r "$PREFIX/agent/agent.py" ]; then
    INSTALLED=$(shasum -a 256 "$PREFIX/agent/agent.py" | cut -c1-12)
    if [ "$INSTALLED" = "$SERVED" ]; then BUILD="$SERVED, the build already installed"
    else BUILD="$SERVED served; $INSTALLED installed now"; fi
  else
    BUILD="$SERVED served; none installed"
  fi
  cat <<PLAN
dry run
  name        $AGENT_ID ($AGENT_ID_FROM)
  state       $EXISTING
  credential  $CREDENTIAL
  daemon      $DAEMON
  region      ${REGION:-local}
  uv          $UV
  build       $BUILD
  model       $HUB
              $CACHE

would write, as root
  $PREFIX/agent/agent.py                      755, only after it matches $SOURCE/agent.py.sha256
                                              and its --doctor passes as $RUN_USER
  $PREFIX/bin/ocm-agent-run                   755, generated; holds no token
  $PREFIX/bin/ocm-agent-token                 755
  $PREFIX/bin/ocm-agent-update                755
  $PREFIX/bin/ocm-agent-uninstall             755
  /etc/ocm/agent.env                           600, owned by $RUN_USER; holds the token
  /var/log/ocm-agent.log                       600, owned by $RUN_USER
  /Library/LaunchDaemons/com.ocm.agent.plist   644, runs ocm-agent-run as $RUN_USER

nothing else. Each file is written beside its destination and renamed into place, so
a failure mid-write leaves what is there now untouched.
Undo later with: sudo $PREFIX/bin/ocm-agent-uninstall

dry run; nothing was changed
PLAN
  exit 0
fi

# Download into a private work directory, check the agent against the checksum the
# gateway publishes for it, and prove the new agent's diagnostic path as the same
# unprivileged account that launchd will use. Only then replace installed files. The
# checksum comes from the same origin as the code, so it catches a truncated or
# drifted download, not a compromised gateway; HTTPS authenticates the gateway, and
# broad deployment still requires a release artifact pinned to an immutable digest.
umask 077
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ocm-install.XXXXXX")
trap 'rm -rf "$WORK"; [ -z "$PUT_TMP" ] || rm -f "$PUT_TMP"' EXIT HUP INT TERM
# The directory is root-owned, so nobody else can rename or replace what is in it; it
# is traversable because the runtime account must reach the download to prove it.
# The generated files staged here hold no secret except agent.env, which stays 600.
chmod 755 "$WORK"
# --- agent download (begin)
TMP_AGENT="$WORK/agent.py"
printf 'downloading agent …\n'
curl_https --fail "$SOURCE/agent.py" -o "$TMP_AGENT" \
  || die "could not fetch $SOURCE/agent.py"
curl_https --fail "$SOURCE/agent.py.sha256" -o "$WORK/agent.py.sha256" \
  || die "could not fetch $SOURCE/agent.py.sha256; nothing was installed"
# The published line is `<sha256>  agent.py`, the shape shasum -c reads, so the check
# runs where the download carries that name — the same pin ocm-agent-update applies
# to the installer itself.
( cd "$WORK" && shasum -a 256 -c agent.py.sha256 >/dev/null 2>&1 ) \
  || die "the downloaded agent does not match its published checksum; nothing was installed"
chmod 755 "$TMP_AGENT"
# --- agent download (end)

printf 'checking the downloaded agent as %s …\n' "$RUN_USER"
# Leave the caller's directory first. Run from root's home (an operator over SSM,
# say) the unprivileged account cannot stat the cwd, and uv dies with "Current
# directory does not exist" before the doctor runs at all.
cd /
sudo -u "$RUN_USER" --preserve-env=OCM_HOST_TOKEN env \
  HOME="$RUN_HOME" \
  OCM_GATEWAY_URL="$GATEWAY" \
  OCM_AGENT_ID="$AGENT_ID" \
  OCM_MODEL_MAP="$MODEL_MAP" \
  "$UV" run --quiet --python 3.12 "$TMP_AGENT" --doctor \
  || die "downloaded agent doctor failed — no installed files were changed"

mkdir -p "$PREFIX/agent" "$PREFIX/bin"
put 755 root "$TMP_AGENT" "$PREFIX/agent/agent.py"

# The token lives in an owner-only file, never in the plist — plists are
# world-readable. The provider process runs as RUN_USER, not as root. The generated
# files below are staged in the work directory and published with put, so a reinstall
# never leaves a half-written file where a working one was.
install -d -m 700 /etc/ocm
chown "$RUN_USER" /etc/ocm
umask 077
cat > "$WORK/agent.env" <<ENV
OCM_HOST_TOKEN=$OCM_HOST_TOKEN
OCM_GATEWAY_URL=$GATEWAY
OCM_AGENT_ID=$AGENT_ID
OCM_MODEL_MAP=$MODEL_MAP
ENV
[ -z "$REGION" ] || printf 'OCM_REGION=%s\n' "$REGION" >> "$WORK/agent.env"
put 600 "$RUN_USER" "$WORK/agent.env" /etc/ocm/agent.env

cat > "$WORK/ocm-agent-run" <<RUN
#!/bin/bash
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$RUN_HOME/.local/bin
export HOME="$RUN_HOME"
set -a; . /etc/ocm/agent.env; set +a
exec "$UV" run --quiet --python 3.12 $PREFIX/agent/agent.py "\$@"
RUN
# 755, not the 700 that `umask 077` above would otherwise leave. This file holds no
# secret — the token lives in /etc/ocm/agent.env — so root-only mode protects nothing
# and blocks the owner (or their agent) from reading back what was just installed,
# which is exactly the verification this script asks people to perform.
put 755 root "$WORK/ocm-agent-run" "$PREFIX/bin/ocm-agent-run"

# Rotating a token had no supported path, so people edited ocm-agent-run by hand —
# which silently breaks the daemon, because that file is regenerated on reinstall
# and is not where the token lives. This is the one command that does it correctly.
cat > "$WORK/ocm-agent-token" <<'TOK'
#!/bin/sh
# Replace this machine's provider token and restart the agent.
#   sudo /opt/ocm/bin/ocm-agent-token              # prompts, input hidden
#   sudo /opt/ocm/bin/ocm-agent-token < token      # automation stdin
#   sudo env OCM_HOST_TOKEN_FILE=/path /opt/ocm/bin/ocm-agent-token
#
# Do not pass the token as a command-line argument: it would appear in
# process lists and shell history.
# Use this rather than editing any file by hand: the token lives in
# /etc/ocm/agent.env, and ocm-agent-run is regenerated on every reinstall.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "$(id -u)" = "0" ] || { echo "run with sudo" >&2; exit 1; }
if [ $# -ne 0 ]; then
  echo "usage: ocm-agent-token" >&2
  echo "  do not pass the token on the command line" >&2
  echo "  you will be prompted, or provide it on stdin / OCM_HOST_TOKEN_FILE" >&2
  exit 1
fi
NEW_TOKEN=""
if [ -n "${OCM_HOST_TOKEN_FILE:-}" ]; then
  IFS= read -r NEW_TOKEN < "$OCM_HOST_TOKEN_FILE" || true
elif [ -t 0 ]; then
  printf 'Provider token or enrollment code (input is hidden): ' >&2
  if stty_state=$(stty -g 2>/dev/null); then
    stty -echo
    IFS= read -r NEW_TOKEN || true
    stty "$stty_state"
  else
    IFS= read -r NEW_TOKEN || true
  fi
  printf '\n' >&2
else
  IFS= read -r NEW_TOKEN || true
fi
ENV=/etc/ocm/agent.env
OWNER=$(stat -f '%Su' "$ENV" 2>/dev/null || true)
printf '%s\n' "$OWNER" | LC_ALL=C grep -Eq '^[-A-Za-z0-9._]{1,64}$' \
  || { echo "error: could not identify the provider account" >&2; exit 1; }
[ "$OWNER" != root ] || { echo "error: the provider environment may not be owned by root" >&2; exit 1; }
BASE=$(sed -n 's|^OCM_GATEWAY_URL=||p' "$ENV" | sed 's|^wss://|https://|')
printf '%s\n' "$BASE" | LC_ALL=C grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' \
  || { echo "error: unsafe or missing gateway URL in $ENV" >&2; exit 1; }
# An enrollment code from the console is exchanged for a token bound to this machine,
# using the agent id already recorded here; the old token is revoked by the gateway.
if printf '%s\n' "$NEW_TOKEN" | LC_ALL=C grep -Eq '^ocm_enroll_[-A-Za-z0-9_]{16,}$'; then
  AGENT_ID=$(sed -n 's|^OCM_AGENT_ID=||p' "$ENV")
  printf '%s\n' "$AGENT_ID" | LC_ALL=C grep -Eq '^[-A-Za-z0-9._]{1,64}$' \
    || { echo "error: unsafe or missing OCM_AGENT_ID in $ENV" >&2; exit 1; }
  printf 'exchanging the enrollment code ...\n'
  ENROLL_BODY="{\"code\":\"$NEW_TOKEN\",\"agent_id\":\"$AGENT_ID\"}"
  ENROLL=$(printf '%s' "$ENROLL_BODY" | curl --silent --show-error --location --fail \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    -H 'content-type: application/json' \
    --data @- "$BASE/v1/provider/enroll" 2>/dev/null) || {
    printf '%s' "$ENROLL_BODY" | curl --silent --show-error --location \
      --proto '=https' --proto-redir '=https' --tlsv1.2 \
      -H 'content-type: application/json' \
      --data @- "$BASE/v1/provider/enroll" 2>/dev/null \
      | sed -n 's/.*"message":"\([^"]*\)".*/error: \1/p' >&2
    echo "nothing was changed" >&2
    exit 1
  }
  NEW_TOKEN=$(printf '%s' "$ENROLL" | sed -n 's/.*"token":"\(ocm_host_[-A-Za-z0-9_]*\)".*/\1/p')
  printf 'enrolled as %s\n' "$AGENT_ID"
fi
printf '%s\n' "$NEW_TOKEN" | LC_ALL=C grep -Eq '^ocm_host_[-A-Za-z0-9_]{16,}$' \
  || { echo "error: expected an issued ocm_host_ provider token" >&2; exit 1; }
printf 'checking token ...\n'
# --- rotation token check (begin)
# The token reaches curl as one config line on stdin (-K -), never as an argument:
# -H "Authorization: Bearer …" is argv, readable by every local process for the life
# of the request. printf is a builtin, so the value is never an argument to any process.
bearer() { printf 'header = "Authorization: Bearer %s"\n' "$NEW_TOKEN"; }
if ! bearer | curl --silent --show-error --location --fail \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  -K - "$BASE/v1/provider/verify" >/dev/null 2>&1; then
  bearer | curl --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    -K - "$BASE/v1/provider/verify" 2>/dev/null \
    | sed -n 's/.*"message":"\([^"]*\)".*/error: \1/p' >&2
  echo "nothing was changed" >&2
  exit 1
fi
# --- rotation token check (end)
# --- env rewrite (begin)
# Written beside the target and renamed into place: a failure mid-write leaves the
# old file whole rather than truncated, and the mode and owner are set before the
# file is visible under its name. The temporary file is a sibling, not in $TMPDIR, so
# the rename is atomic and never a copy across filesystems.
umask 077
TMP=$(mktemp "$ENV.XXXXXX")
trap 'rm -f "$TMP"' EXIT HUP INT TERM
{ grep -v '^OCM_HOST_TOKEN=' "$ENV" || true; printf 'OCM_HOST_TOKEN=%s\n' "$NEW_TOKEN"; } > "$TMP"
chown "$OWNER" "$TMP"
chmod 600 "$TMP"
mv -f "$TMP" "$ENV"
trap - EXIT HUP INT TERM
# --- env rewrite (end)
launchctl kickstart -k system/com.ocm.agent
echo "token accepted, written, and agent restarted."
echo "watch it connect:  tail -f /var/log/ocm-agent.log"
TOK
put 755 root "$WORK/ocm-agent-token" "$PREFIX/bin/ocm-agent-token"   # readable for the same reason

# Fixes reached existing hosts only on reinstall, and a reinstall needs a token that
# was shown once; a bare file swap leaves old modes and config behind. This does the
# reinstall with what is already on disk, so nothing is retyped and nothing is skipped.
cat > "$WORK/ocm-agent-update" <<'UPD'
#!/bin/sh
# Move this machine to the current agent build without retyping anything.
#   sudo /opt/ocm/bin/ocm-agent-update            # update
#   sudo /opt/ocm/bin/ocm-agent-update --check    # report only; change nothing
#
# It reads /etc/ocm/agent.env, fetches the current installer and agent from the same
# gateway, verifies both against their published checksums, and runs the installer
# with the token handed over in a root-only temporary file — never on a command line.
# The installer checks the agent again and proves its doctor path as the runtime
# account before replacing anything, exactly as a first install does.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "$(id -u)" = "0" ] || { echo "run with sudo" >&2; exit 1; }
CHECK=0
[ $# -le 1 ] || { echo "usage: ocm-agent-update [--check]" >&2; exit 1; }
case "${1:-}" in
  "") ;;
  --check) CHECK=1 ;;
  *) echo "usage: ocm-agent-update [--check]" >&2; exit 1 ;;
esac
umask 077
# The installer replaces this very file while it runs. It renames a new file over the
# path, so the running copy keeps its old inode, but sh reads scripts lazily by byte
# offset and a snapshot costs nothing, so the live file only takes a private snapshot
# of itself and runs that. The snapshot inherits the work directory; the live file
# owns its cleanup.
if [ -z "${OCM_UPDATE_WORK:-}" ]; then
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/ocm-update.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT HUP INT TERM
  cp /opt/ocm/bin/ocm-agent-update "$WORK/self"
  OCM_UPDATE_WORK="$WORK" sh "$WORK/self" "$@"
  exit $?
fi
WORK="$OCM_UPDATE_WORK"
ENV=/etc/ocm/agent.env
[ -r "$ENV" ] || { echo "error: $ENV is missing; this machine was not set up by install.sh — run the installer once" >&2; exit 1; }
OWNER=$(stat -f '%Su' "$ENV" 2>/dev/null || true)
printf '%s\n' "$OWNER" | LC_ALL=C grep -Eq '^[-A-Za-z0-9._]{1,64}$' \
  || { echo "error: could not identify the provider account" >&2; exit 1; }
[ "$OWNER" != root ] || { echo "error: the provider environment may not be owned by root" >&2; exit 1; }
val() { sed -n "s|^$1=||p" "$ENV" | head -1; }
GATEWAY=$(val OCM_GATEWAY_URL); AGENT_ID=$(val OCM_AGENT_ID); MODEL_MAP=$(val OCM_MODEL_MAP)
printf '%s\n' "$GATEWAY" | LC_ALL=C grep -Eq '^wss://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' \
  || { echo "error: unsafe or missing gateway URL in $ENV" >&2; exit 1; }
printf '%s\n' "$AGENT_ID" | LC_ALL=C grep -Eq '^[-A-Za-z0-9._]{1,64}$' \
  || { echo "error: unsafe or missing OCM_AGENT_ID in $ENV" >&2; exit 1; }
BASE=$(printf '%s\n' "$GATEWAY" | sed 's|^wss://|https://|')
UV=$(sed -n 's/^exec "\([^"]*\)" run .*/\1/p' /opt/ocm/bin/ocm-agent-run 2>/dev/null | head -1)
[ -n "$UV" ] && [ -x "$UV" ] \
  || { echo "error: could not find uv via /opt/ocm/bin/ocm-agent-run; rerun the installer with OCM_UV_BIN" >&2; exit 1; }
fetch() {
  curl --silent --show-error --location --fail \
    --proto '=https' --proto-redir '=https' --tlsv1.2 "$@"
}
fetch "$BASE/install.sh" -o "$WORK/install.sh" \
  || { echo "error: could not fetch $BASE/install.sh" >&2; exit 1; }
fetch "$BASE/install.sh.sha256" -o "$WORK/install.sh.sha256" \
  || { echo "error: could not fetch the installer checksum" >&2; exit 1; }
( cd "$WORK" && shasum -a 256 -c install.sh.sha256 >/dev/null 2>&1 ) \
  || { echo "error: the downloaded installer does not match its published checksum; nothing was changed" >&2; exit 1; }
fetch "$BASE/agent.py" -o "$WORK/agent.py" \
  || { echo "error: could not fetch $BASE/agent.py" >&2; exit 1; }
fetch "$BASE/agent.py.sha256" -o "$WORK/agent.py.sha256" \
  || { echo "error: could not fetch the agent checksum" >&2; exit 1; }
# A truncated or drifted download must not be reported as a new build, let alone
# installed; the installer repeats this check on its own download.
( cd "$WORK" && shasum -a 256 -c agent.py.sha256 >/dev/null 2>&1 ) \
  || { echo "error: the downloaded agent does not match its published checksum; nothing was changed" >&2; exit 1; }
if cmp -s "$WORK/agent.py" /opt/ocm/agent/agent.py; then AGENT_STATE="already current"
else AGENT_STATE="new build available"; fi
printf 'OCM provider update\n  host     %s\n  user     %s\n  gateway  %s\n  agent    %s\n' \
  "$AGENT_ID" "$OWNER" "$GATEWAY" "$AGENT_STATE"
if [ "$CHECK" = 1 ]; then
  echo "check only; nothing was changed"
  exit 0
fi
# The token goes to the installer in a root-only file under $WORK, which the trap
# removes; it is never placed on a command line or in a visible environment.
sed -n 's/^OCM_HOST_TOKEN=//p' "$ENV" | head -1 > "$WORK/token"
[ -s "$WORK/token" ] || { echo "error: no OCM_HOST_TOKEN in $ENV; run ocm-agent-token first" >&2; exit 1; }
cd /
OCM_HOST_TOKEN_FILE="$WORK/token" OCM_AGENT_ID="$AGENT_ID" OCM_MODEL_MAP="$MODEL_MAP" \
  OCM_RUN_USER="$OWNER" OCM_UV_BIN="$UV" OCM_GATEWAY_URL="$GATEWAY" \
  sh "$WORK/install.sh"
UPD
put 755 root "$WORK/ocm-agent-update" "$PREFIX/bin/ocm-agent-update"

# Uninstall used to be a printed `rm -rf`, which nobody previews and which left the
# model download behind. This removes exactly what the installer wrote, can be asked
# what it would do first, and deletes the model only when told to, and only that model.
cat > "$WORK/ocm-agent-uninstall" <<'UNINST'
#!/bin/sh
# Remove the OCM provider agent from this Mac.
#   sudo /opt/ocm/bin/ocm-agent-uninstall                 # stop and remove; keep the model
#   sudo /opt/ocm/bin/ocm-agent-uninstall --dry-run       # list what would go; change nothing
#   sudo /opt/ocm/bin/ocm-agent-uninstall --purge-cache   # also delete this model's download
#
# Removes what install.sh wrote and nothing else: the launchd daemon and its plist,
# /opt/ocm, /etc/ocm and the log. The model download in the provider account's Hugging
# Face cache is several GB and stays unless --purge-cache is given, and then only that
# one model's directory goes, never the whole cache. The token is not printed and not
# sent anywhere; this cannot revoke it, so revoke the credential in the console after.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
# The whole script is one function so it is parsed in full before /opt/ocm, and this
# file with it, is removed from under it.
main() {
[ "$(id -u)" = "0" ] || { echo "run with sudo" >&2; exit 1; }
DRY_RUN=0; PURGE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --purge-cache) PURGE=1 ;;
    *) echo "usage: ocm-agent-uninstall [--dry-run] [--purge-cache]" >&2; exit 1 ;;
  esac
done
ENV=/etc/ocm/agent.env
PLIST=/Library/LaunchDaemons/com.ocm.agent.plist
LOG=/var/log/ocm-agent.log
AGENT_ID="unknown (no $ENV)"; HUB=""
if [ -r "$ENV" ]; then
  AGENT_ID=$(sed -n 's|^OCM_AGENT_ID=||p' "$ENV" | head -1)
  OWNER=$(stat -f '%Su' "$ENV" 2>/dev/null || true)
  printf '%s\n' "$OWNER" | LC_ALL=C grep -Eq '^[-A-Za-z0-9._]{1,64}$' || OWNER=""
  # The advertised map names the model, e.g. ocm-coder=mlx-community/Qwen…-4bit, which
  # Hugging Face keeps under hub/models--mlx-community--Qwen…-4bit in the owner's home.
  MLX=$(sed -n 's|^OCM_MODEL_MAP=||p' "$ENV" | head -1 | sed -n 's|^[^=,]*=\([^,]*\).*|\1|p')
  if [ -n "$OWNER" ] && [ "$OWNER" != root ] && [ -n "$MLX" ]; then
    OWNER_HOME=$(dscl . -read "/Users/$OWNER" NFSHomeDirectory 2>/dev/null | awk '{ print $2; exit }')
    HUB="$OWNER_HOME/.cache/huggingface/hub/models--$(printf '%s' "$MLX" | sed 's|/|--|g')"
    # Only ever one model directory inside a hub cache, with a shape that cannot name
    # anything else. Whatever does not fit is not ours to delete.
    printf '%s\n' "$HUB" | LC_ALL=C grep -Eq '^/[-A-Za-z0-9._/+]+/\.cache/huggingface/hub/models--[-A-Za-z0-9._+]+$' \
      || HUB=""
    [ -n "$HUB" ] && [ -d "$HUB" ] || HUB=""
  fi
fi
present() { if [ -e "$1" ]; then echo present; else echo absent; fi; }
if launchctl print system/com.ocm.agent >/dev/null 2>&1; then DAEMON="loaded; will be stopped"
else DAEMON="not loaded"; fi
if [ -n "$HUB" ]; then
  SIZE=$(du -sh "$HUB" 2>/dev/null | cut -f1)
  if [ "$PURGE" = 1 ]; then CACHE="$HUB ($SIZE): will be deleted (--purge-cache)"
  else CACHE="$HUB ($SIZE): kept; --purge-cache deletes it"; fi
else
  CACHE="no download found for this machine's model; nothing to purge"
fi
cat <<REPORT
OCM provider uninstall
  host    $AGENT_ID
  daemon  $DAEMON
  remove  $PLIST ($(present "$PLIST"))
          /opt/ocm ($(present /opt/ocm))
          /etc/ocm ($(present /etc/ocm))
          $LOG ($(present "$LOG"))
  model   $CACHE
REPORT
if [ "$DRY_RUN" = 1 ]; then
  echo "dry run; nothing was changed"
  exit 0
fi
# bootout is asynchronous; wait for the job to actually go, as the installer does.
launchctl bootout system/com.ocm.agent 2>/dev/null || true
n=0
while launchctl print system/com.ocm.agent >/dev/null 2>&1 && [ "$n" -lt 50 ]; do
  sleep 0.2; n=$((n + 1))
done
rm -f "$PLIST"
rm -rf /opt/ocm /etc/ocm
rm -f "$LOG"
if [ "$PURGE" = 1 ] && [ -n "$HUB" ]; then rm -rf "$HUB"; fi
cat <<DONE
removed. The provider token this machine held is gone from disk but not revoked:
revoke it in the console (Your credentials, $AGENT_ID) so the credential is dead and
the name is free. uv and its cache were not installed by OCM and stay.
DONE
}
main "$@"
UNINST
put 755 root "$WORK/ocm-agent-uninstall" "$PREFIX/bin/ocm-agent-uninstall"

# launchd opens the log as RUN_USER. Pre-create it owner-only rather than relying on
# launchd to create a world-readable root log or failing because /var/log is closed.
touch /var/log/ocm-agent.log
chown "$RUN_USER" /var/log/ocm-agent.log
chmod 600 /var/log/ocm-agent.log

cat > "$WORK/com.ocm.agent.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ocm.agent</string>
  <key>UserName</key><string>$RUN_USER</string>
  <key>ProgramArguments</key><array><string>$PREFIX/bin/ocm-agent-run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/var/log/ocm-agent.log</string>
  <key>StandardErrorPath</key><string>/var/log/ocm-agent.log</string>
  <key>WorkingDirectory</key><string>$PREFIX</string>
</dict></plist>
PLIST
put 644 root "$WORK/com.ocm.agent.plist" /Library/LaunchDaemons/com.ocm.agent.plist

# bootout is ASYNCHRONOUS. Bootstrapping while teardown is still in flight fails
# with "Bootstrap failed: 5: Input/output error", and under `set -eu` the script
# then dies having ALREADY removed the working daemon — a reinstall took a healthy
# provider offline and left it there. Wait for the old job to actually go.
launchctl bootout system/com.ocm.agent 2>/dev/null || true
n=0
while launchctl print system/com.ocm.agent >/dev/null 2>&1 && [ "$n" -lt 50 ]; do
  sleep 0.2; n=$((n + 1))
done
if ! launchctl bootstrap system /Library/LaunchDaemons/com.ocm.agent.plist; then
  # Never exit quietly here: at this point the old daemon is gone, so a silent
  # failure means the machine is left with no agent at all.
  die "the daemon could not be loaded, and this machine now has NO agent running.
  Retry:  sudo launchctl bootstrap system /Library/LaunchDaemons/com.ocm.agent.plist
  Then:   sudo -u $RUN_USER $PREFIX/bin/ocm-agent-run --doctor"
fi

rm -rf "$WORK"
trap - EXIT HUP INT TERM

# The build is the agent file's SHA-256; the doctor, the console and the status page
# compare it with what the gateway serves and say when an update is available.
BUILD=$(shasum -a 256 "$PREFIX/agent/agent.py" | cut -c1-12)

cat <<DONE

installed. Agent build $BUILD. Inference runs as $RUN_USER, never as root.

  status   launchctl print system/com.ocm.agent
  logs     tail -f /var/log/ocm-agent.log
  check    sudo -u $RUN_USER $PREFIX/bin/ocm-agent-run --doctor
  rotate   sudo $PREFIX/bin/ocm-agent-token
  update   sudo $PREFIX/bin/ocm-agent-update      (--check to only look)
  stop     sudo launchctl bootout system/com.ocm.agent
  remove   sudo $PREFIX/bin/ocm-agent-uninstall   (--dry-run to only look; --purge-cache
             to also delete this model's download, which otherwise stays)

Your Mac should appear in the console within a few seconds.

Note: prompts routed to this machine are visible to you in plaintext. That is true of
every provider, and is why the network claims no confidentiality it cannot enforce.
DONE

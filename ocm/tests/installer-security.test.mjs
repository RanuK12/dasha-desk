import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { renderProviderGuide } from '../gateway/console.mjs';

const source = readFileSync(new URL('../agent/install.sh', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const verifyM4 = readFileSync(new URL('../scripts/verify-m4.sh', import.meta.url), 'utf8');
// Quoted or unquoted — either form is a copy-paste argv / history assignment.
const COPY_PASTE_TOKEN_ARGV = /OCM_HOST_TOKEN=["']?ocm_host_/;

test('the root installer never pipes downloaded code into a shell', () => {
  assert.doesNotMatch(source, /astral\.sh\/uv\/install\.sh/,
    'uv must be installed and reviewed independently');
  assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:ba)?sh\b/,
    'network responses must never execute directly as root');
  assert.match(source, /uv is required before running this root installer/);
});

test('the installer resets PATH before using privileged commands', () => {
  const setPath = source.indexOf('PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:/var/root/.local/bin');
  const gateway = source.indexOf('GATEWAY=');
  assert.ok(setPath > 0 && setPath < gateway,
    'a caller-controlled PATH must not choose curl, sed, grep, install, sudo or launchctl');
  assert.match(source.slice(setPath, gateway), /export PATH/);
});

test('the executable source is derived from the authenticated gateway', () => {
  assert.match(source,
    /SOURCE=\$\(printf '%s\\n' "\$GATEWAY" \| sed 's\|\^wss:\/\/\|https:\/\/\|'\)/,
    'a separate arbitrary code-download origin must not drift from the gateway');
  assert.doesNotMatch(source, /OCM_SOURCE_URL/);
  assert.match(source, /--proto '=https' --proto-redir '=https' --tlsv1\.2/,
    'downloads and token checks must refuse plaintext redirects');
});

test('every shell-sourced provider value is constrained before agent.env is written', () => {
  for (const variable of [
    'GATEWAY',
    'SOURCE',
    'OCM_HOST_TOKEN',
    'AGENT_ID',
    'MLX_MODEL',
    'MODEL_MAP',
    'RUN_USER',
    'RUN_HOME',
    'UV',
  ]) {
    assert.match(source, new RegExp(`matches "\\$${variable}"`),
      `${variable} must be allowlisted before entering a privileged shell or wrapper`);
  }

  const validation = source.indexOf('matches "$GATEWAY"');
  const envWrite = source.indexOf('cat > "$WORK/agent.env"');
  assert.ok(validation > 0 && validation < envWrite,
    'validation must happen before the provider environment file is written');
});

test('no regex in the installer uses a repetition bound BSD grep rejects', () => {
  // macOS 15 ships BSD grep with RE_DUP_MAX 255. `{1,512}` is not "a wide bound" there,
  // it is "maximum repetition exceeds 255" and a dead installer. Found on the first
  // real Mac the reinstall path met, after every test had passed on GNU grep and a
  // newer macOS. Bound length with ${#} instead; patterns bound shape only.
  const tooWide = [...source.matchAll(/\{(\d+),(\d+)\}/g)]
    .filter((m) => Number(m[1]) > 255 || Number(m[2]) > 255)
    .map((m) => m[0]);
  assert.deepEqual(tooWide, [],
    `repetition bounds above 255 abort BSD grep on macOS: ${tooWide.join(', ')}`);
  assert.match(source, /\[ "\$\{#1\}" -gt "\$3" \]/,
    'matches() must enforce length itself, since the pattern no longer can');
  for (const [variable, max] of [['MLX_MODEL', 512], ['MODEL_MAP', 2048], ['UV', 512]]) {
    assert.match(source, new RegExp(`matches "\\$${variable}" '[^']+' ${max}`),
      `${variable} must still have an explicit length limit of ${max}`);
  }
});

test('the inference daemon is explicitly forbidden from running as root', () => {
  assert.match(source, /RUN_USER="\$\{OCM_RUN_USER:-\$\{SUDO_USER:-\}\}"/);
  assert.match(source, /\[ "\$RUN_USER" != root \] \|\| die/,
    'root must be rejected as the provider runtime user');
  assert.match(source, /id "\$RUN_USER" >\/dev\/null/,
    'the selected provider account must exist locally');
  assert.match(source, /sudo -u "\$RUN_USER" --preserve-env=OCM_HOST_TOKEN env[\s\S]*"\$TMP_AGENT" --doctor/,
    'the downloaded code must be proved as the same unprivileged account that will run it, without putting the token on env argv');
  assert.match(source, /<key>UserName<\/key><string>\$RUN_USER<\/string>/,
    'launchd must drop privileges before executing the agent');
  assert.doesNotMatch(source, /export HOME=\/var\/root/,
    'the runtime wrapper must not inherit root as its home');
});

test('provider secrets and logs are owned only by the unprivileged runtime account', () => {
  const envWrite = source.indexOf('cat > "$WORK/agent.env"');
  const launchd = source.indexOf('cat > "$WORK/com.ocm.agent.plist"');
  const section = source.slice(envWrite, launchd);
  // Mode and owner are set on the staged copy and published by one rename (put).
  assert.match(section, /put 600 "\$RUN_USER" "\$WORK\/agent\.env" \/etc\/ocm\/agent\.env/);
  assert.match(section, /touch \/var\/log\/ocm-agent\.log/);
  assert.match(section, /chown "\$RUN_USER" \/var\/log\/ocm-agent\.log/);
  assert.match(section, /chmod 600 \/var\/log\/ocm-agent\.log/);
});

test('the resolved token is exported before the doctor runs under sudo', () => {
  // The prompt, OCM_HOST_TOKEN_FILE and stdin paths set a shell variable, and
  // `sudo --preserve-env=OCM_HOST_TOKEN` carries only exported variables. Every path
  // except the human --preserve-env one failed the doctor until this was added.
  const exported = source.indexOf('\nexport OCM_HOST_TOKEN\n');
  const doctor = source.indexOf('--preserve-env=OCM_HOST_TOKEN env');
  assert.ok(exported > 0 && doctor > 0 && exported < doctor,
    'install.sh must `export OCM_HOST_TOKEN` after resolving it and before the doctor');
});

test('the doctor runs from a directory the runtime account can enter', () => {
  // `sudo -u ec2-user uv run` from /var/root (700) fails with "Current directory does
  // not exist". Found on the first reinstall over SSM, where cwd is root's home.
  const doctor = source.indexOf('"$UV" run --quiet --python 3.12 "$TMP_AGENT" --doctor');
  const cd = source.lastIndexOf('\ncd /\n', doctor);
  assert.ok(doctor > 0 && cd > 0 && cd < doctor,
    'the installer must cd / before running the doctor as the runtime account');
});

test('the downloaded agent is proved before a working installation is replaced', () => {
  const download = source.indexOf('curl_https --fail "$SOURCE/agent.py"');
  const doctor = source.indexOf('"$UV" run --quiet --python 3.12 "$TMP_AGENT" --doctor');
  const install = source.indexOf('put 755 root "$TMP_AGENT" "$PREFIX/agent/agent.py"');
  assert.ok(download > 0 && doctor > download && install > doctor,
    'download -> unprivileged doctor -> install must be the only allowed order');
  assert.match(source, /no installed files were changed/);
});

test('token rotation validates credential, gateway and runtime owner', () => {
  const rotation = source.slice(source.indexOf("cat > \"$WORK/ocm-agent-token\""));
  assert.match(rotation, /expected an issued ocm_host_ provider token/);
  assert.match(rotation, /unsafe or missing gateway URL/);
  assert.match(rotation, /could not identify the provider account/);
  assert.match(rotation, /provider environment may not be owned by root/);
  assert.match(rotation, /nothing was changed/);
  assert.match(rotation, /chown "\$OWNER" "\$TMP"/);
  assert.match(rotation, /mktemp "\$ENV\.XXXXXX"/);
  assert.match(rotation, /do not pass the token on the command line/);
  assert.match(rotation, /OCM_HOST_TOKEN_FILE/);
  assert.match(rotation, /stty -echo/);
});

test('human and automation install paths never put the token on argv', () => {
  assert.match(source, /read -rsp "Provider token: " OCM_HOST_TOKEN/,
    'the documented human path must prompt without echo');
  assert.match(source, /sudo --preserve-env=OCM_HOST_TOKEN sh install\.sh/,
    'sudo must inherit the prompted token rather than receiving it as env argv');
  assert.match(source, /OCM_HOST_TOKEN_FILE/,
    'automation must have a secret-file path');
  assert.match(source, /sudo sh install\.sh < \/path\/to\/token/,
    'automation must have a stdin path');
  assert.match(source, /stty -echo/,
    'an interactive sudo without the env var must prompt with echo disabled');
  assert.doesNotMatch(source, /sudo env OCM_HOST_TOKEN=/);
});

test('rendered provider guide, README and install comments reject copy-paste token argv', () => {
  const guide = renderProviderGuide({
    account: { email: 'provider@test.dev' },
    apiHost: 'api.ocm.getdasha.com',
    models: [],
  });
  assert.doesNotMatch(source, COPY_PASTE_TOKEN_ARGV,
    'install.sh must not document OCM_HOST_TOKEN="ocm_host_…" as a command');
  assert.doesNotMatch(readme, COPY_PASTE_TOKEN_ARGV,
    'README must not document OCM_HOST_TOKEN="ocm_host_…" as a command');
  assert.doesNotMatch(guide, COPY_PASTE_TOKEN_ARGV,
    'the rendered provider guide must not document OCM_HOST_TOKEN="ocm_host_…" as a command');
  assert.doesNotMatch(verifyM4, COPY_PASTE_TOKEN_ARGV,
    'verify-m4.sh must not document OCM_HOST_TOKEN=ocm_host_… as a command');
  assert.match(guide, /sudo OCM_AGENT_ID="my-mac" sh install.sh/,
    'the human install path is one line with no token on it');
  assert.match(guide, /typing hidden/,
    'the guide must say the installer prompts for the token without echo');
  assert.match(verifyM4, /OCM_HOST_TOKEN_FILE/,
    'M4 verification must offer a secret-file path');
  assert.match(verifyM4, /read -rsp "Provider token: " OCM_HOST_TOKEN/,
    'M4 verification must document a hidden-prompt path');
});

test('the installer never logs the provider token', () => {
  for (const line of source.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    if (/\/etc\/ocm\/agent\.env/.test(line)) continue;
    if (/Authorization: Bearer/.test(line)) continue;
    if (/printf 'OCM_HOST_TOKEN=%s/.test(line)) continue;
    // Quiet grep is validation, not a log line.
    if (/\| LC_ALL=C grep -Eq/.test(line)) continue;
    assert.doesNotMatch(line, /(?:echo|printf).*\$\{?OCM_HOST_TOKEN/,
      `installer must not print the token: ${line}`);
    assert.doesNotMatch(line, /(?:echo|printf).*\$\{?NEW_TOKEN/,
      `token rotator must not print the token: ${line}`);
  }
  assert.doesNotMatch(source, /^\s*set -x/m);
});

test('the update helper reinstalls from what is on disk and never exposes the token', () => {
  const start = source.indexOf("cat > \"$WORK/ocm-agent-update\" <<'UPD'");
  assert.ok(start > 0, 'install.sh must install ocm-agent-update');
  const end = source.indexOf('\nUPD\n', start);
  assert.ok(end > start);
  const helper = source.slice(source.indexOf('\n', start) + 1, end + 1);
  // It is a reinstall with the values already on disk, gated by the same checksum a
  // human is told to verify, and the token travels in a root-only file.
  assert.match(helper, /shasum -a 256 -c install\.sh\.sha256/);
  assert.match(helper, /does not match its published checksum; nothing was changed/);
  assert.match(helper, /OCM_HOST_TOKEN_FILE="\$WORK\/token"/);
  assert.match(helper, /umask 077/);
  assert.match(helper, /trap 'rm -rf "\$WORK"'/);
  assert.match(helper, /provider environment may not be owned by root/);
  assert.match(helper, /--check/);
  // Never the token on argv or in a visible environment assignment.
  // (the sed that reads the env file mentions the key after a `^` anchor; that is a
  // pattern, not an assignment)
  assert.doesNotMatch(helper, /(^|[\s;])OCM_HOST_TOKEN=/m);
  assert.doesNotMatch(helper, COPY_PASTE_TOKEN_ARGV);
  // The installer overwrites the helper while it runs; it must continue from a snapshot.
  assert.match(helper, /OCM_UPDATE_WORK/);
  assert.match(helper, /cp \/opt\/ocm\/bin\/ocm-agent-update "\$WORK\/self"/);
  // No shell expansion leaks: the heredoc is quoted, and the generated file is valid sh.
  assert.match(source, /<<'UPD'\n/);
  const check = spawnSync('sh', ['-n'], { input: helper, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  // It is installed executable, after the rotation helper and before launchd is touched.
  const chmod = source.indexOf('put 755 root "$WORK/ocm-agent-update" "$PREFIX/bin/ocm-agent-update"');
  const token = source.indexOf('put 755 root "$WORK/ocm-agent-token" "$PREFIX/bin/ocm-agent-token"');
  const bootout = source.indexOf('launchctl bootout system/com.ocm.agent 2>/dev/null || true');
  assert.ok(token < start && chmod > end && chmod < bootout);
  // And it is documented where a provider will look.
  assert.match(source, /update\s+sudo \$PREFIX\/bin\/ocm-agent-update/);
  const guide = renderProviderGuide({ apiHost: 'api.example', models: ['ocm-coder'] });
  assert.match(guide, /sudo \/opt\/ocm\/bin\/ocm-agent-update/);
  assert.match(guide, /--check/);
});

test('an enrollment code is exchanged for a bound token, in a body, before anything is written', () => {
  const agentCheck = source.indexOf(`matches "$AGENT_ID" '^[-A-Za-z0-9._]{1,64}$'`);
  const exchange = source.indexOf(`if matches "$OCM_HOST_TOKEN" '^ocm_enroll_[-A-Za-z0-9_]{16,}$'; then`);
  const tokenCheck = source.indexOf(`matches "$OCM_HOST_TOKEN" '^ocm_host_[-A-Za-z0-9_]{16,}$'`);
  const verify = source.indexOf('"$SOURCE/v1/provider/verify"');
  assert.ok(agentCheck > 0 && exchange > agentCheck,
    'the agent id goes into the enrollment body, so it must be validated first');
  assert.ok(tokenCheck > exchange && verify > tokenCheck,
    'exchange -> token-shape check -> verify must be the order');
  const block = source.slice(exchange, tokenCheck);
  // The code and the token are secrets: JSON body over HTTPS through curl_https,
  // never a query string, never argv of anything but curl, never printed.
  assert.match(block, /curl_https --fail -H 'content-type: application\/json'/);
  assert.match(block, /printf '%s' "\$ENROLL_BODY" \| curl_https/, 'the code reaches curl on stdin');
  assert.match(block, /--data @-/);
  assert.doesNotMatch(source, /--data "\{/, '--data "…" is argv and shows the code in ps for the life of the request');
  assert.match(block, /"\$SOURCE\/v1\/provider\/enroll"/);
  assert.doesNotMatch(source, /enroll\?/);
  assert.doesNotMatch(source, /[?&]code=/);
  assert.match(block, /sed -n 's\/\.\*"token":"\\\(ocm_host_\[-A-Za-z0-9_\]\*\\\)"\.\*\/\\1\/p'/,
    'the returned token is parsed with a shape-restricted pattern');
  assert.match(block, /\n  export OCM_HOST_TOKEN\n/, 'the exchanged token must be exported for the doctor');
  assert.match(block, /nothing was installed/);
  assert.match(block, /enrolled as %s/);
  assert.match(block, /rotated %s older token/);
  for (const line of block.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    assert.doesNotMatch(line, /printf[^\n]*\$(?:\{)?(?:OCM_HOST_TOKEN|ENROLL)\b(?![^\n]*\| sed -n)/,
      `exchange must not print the code, the token or the raw response: ${line}`);
  }
  // Prompt and header document the code path; the token path stays.
  assert.match(source, /Provider token or enrollment code \(input is hidden\): /);
  assert.match(source, /get an enrollment code from the console/);
  assert.match(source, /sudo OCM_AGENT_ID="my-mac" sh install\.sh/);
  assert.match(source, /A provider token works everywhere a code does/);
  assert.match(source, /or an ocm_enroll_ code/);
});

test('the rotation helper accepts an enrollment code and exchanges it the same way', () => {
  const start = source.indexOf("cat > \"$WORK/ocm-agent-token\" <<'TOK'");
  const end = source.indexOf('\nTOK\n', start);
  assert.ok(start > 0 && end > start);
  const helper = source.slice(source.indexOf('\n', start) + 1, end + 1);
  const exchange = helper.indexOf("grep -Eq '^ocm_enroll_[-A-Za-z0-9_]{16,}$'");
  const shape = helper.indexOf("grep -Eq '^ocm_host_[-A-Za-z0-9_]{16,}$'");
  const verify = helper.indexOf('"$BASE/v1/provider/verify"');
  assert.ok(exchange > 0 && shape > exchange && verify > shape,
    'code exchange -> token-shape check -> verify, so a bad exchange never reaches the env file');
  assert.match(helper, /AGENT_ID=\$\(sed -n 's\|\^OCM_AGENT_ID=\|\|p' "\$ENV"\)/,
    'the helper enrolls under the id already recorded on this machine');
  assert.match(helper, /printf '%s' "\$ENROLL_BODY" \| curl/, 'the rotation helper also feeds the code on stdin');
  assert.match(helper, /--data @-/);
  assert.match(helper, /"\$BASE\/v1\/provider\/enroll"/);
  assert.match(helper, /Provider token or enrollment code \(input is hidden\): /);
  assert.match(helper, /do not pass the token on the command line/);
  assert.match(helper, /expected an issued ocm_host_ provider token/);
  const check = spawnSync('sh', ['-n'], { input: helper, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('a reinstall keeps the region the machine already reports', () => {
  // The M4 reported us-west-2 from a hand-added OCM_REGION line; the first enrollment
  // reinstall rewrote agent.env without it and the host silently became "local".
  assert.match(source, /REGION="\$\{OCM_REGION:-\$\(sed -n 's\|\^OCM_REGION=\|\|p' \/etc\/ocm\/agent\.env 2>\/dev\/null \| head -1\)\}"/,
    'explicit OCM_REGION wins, then the existing env file, then unset');
  assert.match(source, /matches "\$REGION" '\^\[-A-Za-z0-9\._\]\{1,32\}\$'/, 'the region is allowlisted before it is written to a sourced file');
  const write = source.indexOf("printf 'OCM_REGION=%s\\n' \"$REGION\" >> \"$WORK/agent.env\"");
  const env = source.indexOf('cat > "$WORK/agent.env" <<ENV');
  const publish = source.indexOf('put 600 "$RUN_USER" "$WORK/agent.env" /etc/ocm/agent.env');
  assert.ok(env > 0 && write > env && write < publish, 'the region line is appended to the staged env file before it is published');
});

test('--dry-run runs every check, spends no enrollment code, and exits before anything is written', () => {
  // P8: an agent's instinct is to preview privileged changes. The preview must be the
  // real preflight (same PATH, same allowlists, same uv and account resolution), and
  // it must stop before the first byte lands on disk.
  assert.match(source, /--dry-run\) DRY_RUN=1 ;;/, 'install.sh must accept --dry-run');
  assert.match(source, /\*\) die "usage: sudo sh install\.sh \[--dry-run\]" ;;/, 'any other argument is refused');
  const stop = source.indexOf('dry run; nothing was changed\nPLAN\n  exit 0\nfi\n');
  assert.ok(stop > 0, 'the dry run ends with a clear message and exit 0');
  const verify = source.indexOf('"$SOURCE/v1/provider/verify"');
  assert.ok(verify > 0 && verify < stop, 'the token is still checked against the gateway before the dry run stops');
  // Every write-shaped step comes after the stop: nothing before it touches the disk.
  for (const write of [
    'mktemp -d "${TMPDIR:-/tmp}/ocm-install.XXXXXX"',
    'curl_https --fail "$SOURCE/agent.py"',
    'curl_https --fail "$SOURCE/agent.py.sha256" -o',
    'mkdir -p "$PREFIX/agent" "$PREFIX/bin"',
    'put 755 root "$TMP_AGENT"',
    'install -d -m 700 /etc/ocm',
    'cat > "$WORK/agent.env"',
    'put 600 "$RUN_USER" "$WORK/agent.env" /etc/ocm/agent.env',
    'cat > "$WORK/ocm-agent-run"',
    'cat > "$WORK/ocm-agent-token"',
    'cat > "$WORK/ocm-agent-update"',
    'cat > "$WORK/ocm-agent-uninstall"',
    'touch /var/log/ocm-agent.log',
    'cat > "$WORK/com.ocm.agent.plist"',
    'put 644 root "$WORK/com.ocm.agent.plist" /Library/LaunchDaemons/com.ocm.agent.plist',
    'launchctl bootout system/com.ocm.agent 2>/dev/null || true',
    'launchctl bootstrap system',
  ]) {
    const at = source.indexOf(write);
    assert.ok(at > stop, `${write} must come after the dry-run exit, not before it`);
  }
  // A code is single-use and exchanging it revokes the machine's older token, so the
  // dry run must never reach the exchange with one.
  const guard = source.indexOf(`if [ "$DRY_RUN" = 1 ] && matches "$OCM_HOST_TOKEN" '^ocm_enroll_[-A-Za-z0-9_]{16,}$'; then`);
  const exchange = source.indexOf(`if matches "$OCM_HOST_TOKEN" '^ocm_enroll_[-A-Za-z0-9_]{16,}$'; then`);
  assert.ok(guard > 0 && guard < exchange, 'the dry-run guard must precede the exchange');
  assert.match(source.slice(guard, exchange), /ENROLL_PENDING=1\n  OCM_HOST_TOKEN=""\n/,
    'a code seen by a dry run is set aside, not exchanged');
  assert.match(source, /left unspent/);
  // No credential is needed for a preview: the interactive prompt is skipped and the
  // empty value is tolerated only under --dry-run.
  assert.match(source, /if \[ -z "\$\{OCM_HOST_TOKEN:-\}" \] && \[ "\$DRY_RUN" = 1 \] && \[ -t 0 \]; then\n  :/);
  assert.match(source, /\[ -n "\$\{OCM_HOST_TOKEN:-\}" \] \|\| \[ "\$DRY_RUN" = 1 \] \|\| die "provide OCM_HOST_TOKEN/);
  assert.match(source, /if \[ -n "\$OCM_HOST_TOKEN" \] \|\| \[ "\$DRY_RUN" = 0 \]; then\n  matches "\$OCM_HOST_TOKEN" '\^ocm_host_/,
    'the real run still requires a well-formed token');
  // The plan names every file the real run writes, with mode and owner.
  const plan = source.slice(source.indexOf('# Everything above only reads.'), stop);
  for (const file of [
    '$PREFIX/agent/agent.py', '$PREFIX/bin/ocm-agent-run', '$PREFIX/bin/ocm-agent-token',
    '$PREFIX/bin/ocm-agent-update', '$PREFIX/bin/ocm-agent-uninstall', '/etc/ocm/agent.env',
    '/var/log/ocm-agent.log', '/Library/LaunchDaemons/com.ocm.agent.plist',
  ]) assert.match(plan, new RegExp(file.replace(/[$./]/g, '\\$&')), `the dry-run plan must list ${file}`);
  assert.match(plan, /600, owned by \$RUN_USER; holds the token/);
  assert.match(plan, /\$RUN_HOME\/\.cache\/huggingface\/hub\/models--/, 'the plan must say where the model cache lives');
  assert.doesNotMatch(plan, /\$OCM_HOST_TOKEN|\$VERIFY/, 'the plan must not print the token or the gateway response');
  // It is documented where a provider will look.
  assert.match(source, /sudo OCM_AGENT_ID="my-mac" sh install\.sh --dry-run/);
  const guide = renderProviderGuide({ apiHost: 'api.example', models: ['ocm-coder'] });
  assert.match(guide, /sh install\.sh --dry-run/);
  assert.match(guide, /spending a code/);
  assert.doesNotMatch(guide, /About 340 lines/, 'the guide must not understate the installer');
});

test('the uninstaller removes exactly what the installer wrote and can preview that', () => {
  const start = source.indexOf("cat > \"$WORK/ocm-agent-uninstall\" <<'UNINST'");
  assert.ok(start > 0, 'install.sh must install ocm-agent-uninstall');
  const end = source.indexOf('\nUNINST\n', start);
  assert.ok(end > start);
  const helper = source.slice(source.indexOf('\n', start) + 1, end + 1);
  // Quoted heredoc, valid sh, parsed whole before it deletes itself.
  assert.match(source, /<<'UNINST'\n/);
  const check = spawnSync('sh', ['-n'], { input: helper, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.match(helper, /^main\(\) \{$/m);
  assert.match(helper, /\nmain "\$@"\n$/);
  assert.match(helper, /\[ "\$\(id -u\)" = "0" \] \|\| \{ echo "run with sudo" >&2; exit 1; \}/);
  // Preview, and refuse anything it does not understand.
  assert.match(helper, /--dry-run\) DRY_RUN=1 ;;/);
  assert.match(helper, /--purge-cache\) PURGE=1 ;;/);
  assert.match(helper, /\*\) echo "usage: ocm-agent-uninstall \[--dry-run\] \[--purge-cache\]" >&2; exit 1 ;;/);
  const stop = helper.indexOf('echo "dry run; nothing was changed"\n  exit 0\n');
  assert.ok(stop > 0);
  // Every rm is a literal path the installer wrote, or the one allowlisted model dir,
  // and every one of them comes after the dry-run exit.
  const rms = [...helper.matchAll(/^\s*(?:if [^\n]*; then )?(rm -r?f [^\n;]+)/gm)].map((m) => m[1].trim());
  assert.deepEqual(rms.sort(), [
    'rm -f "$LOG"',
    'rm -f "$PLIST"',
    'rm -rf "$HUB"',
    'rm -rf /opt/ocm /etc/ocm',
  ]);
  for (const rm of rms) assert.ok(helper.indexOf(rm) > stop, `${rm} must come after the dry-run exit`);
  assert.match(helper, /^PLIST=\/Library\/LaunchDaemons\/com\.ocm\.agent\.plist$/m);
  assert.match(helper, /^LOG=\/var\/log\/ocm-agent\.log$/m);
  // The cache purge is opt-in and scoped to one model directory whose shape is checked
  // right before use; the whole ~/.cache or hub is never a target.
  assert.match(helper, /if \[ "\$PURGE" = 1 \] && \[ -n "\$HUB" \]; then rm -rf "\$HUB"; fi/);
  assert.ok(helper.includes(`grep -Eq '^/[-A-Za-z0-9._/+]+/\\.cache/huggingface/hub/models--[-A-Za-z0-9._+]+$'`),
    'the model directory must be allowlisted before it can be removed');
  assert.match(helper, /\[ -n "\$HUB" \] && \[ -d "\$HUB" \] \|\| HUB=""/);
  assert.doesNotMatch(helper, /rm -rf "\$OWNER_HOME|rm -rf "\$HOME|\.cache"\s*$/m);
  // The owner is resolved the way the other helpers do it, and root's home is never used.
  assert.match(helper, /OWNER=\$\(stat -f '%Su' "\$ENV"/);
  assert.match(helper, /\[ "\$OWNER" != root \]/);
  // bootout waits for the job to go, as the installer learned to.
  assert.match(helper, /launchctl bootout system\/com\.ocm\.agent 2>\/dev\/null \|\| true\nn=0\nwhile launchctl print system\/com\.ocm\.agent/);
  // It never prints or forwards the token, and tells the operator to revoke it.
  for (const line of helper.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    assert.doesNotMatch(line, /(?:echo|printf|cat)[^\n]*OCM_HOST_TOKEN/, `uninstaller must not print the token: ${line}`);
  }
  assert.doesNotMatch(helper, /cat "\$ENV"|cat \/etc\/ocm\/agent\.env/);
  assert.doesNotMatch(helper, /curl/);
  assert.match(helper, /not revoked/);
  // Installed executable after the update helper and before launchd is touched; the
  // printed rm -rf is gone from the closing instructions and the guide documents it.
  const chmod = source.indexOf('put 755 root "$WORK/ocm-agent-uninstall" "$PREFIX/bin/ocm-agent-uninstall"');
  const update = source.indexOf('put 755 root "$WORK/ocm-agent-update" "$PREFIX/bin/ocm-agent-update"');
  // The uninstaller carries its own bootout line; the installer's is the last one.
  const bootout = source.lastIndexOf('launchctl bootout system/com.ocm.agent 2>/dev/null || true');
  assert.ok(update < start && chmod > end && chmod < bootout);
  assert.match(source, /remove\s+sudo \$PREFIX\/bin\/ocm-agent-uninstall/);
  assert.doesNotMatch(source, /remove\s+sudo launchctl bootout[^\n]*rm -rf/, 'the printed rm -rf uninstall is retired');
  const guide = renderProviderGuide({ apiHost: 'api.example', models: ['ocm-coder'] });
  assert.match(guide, /sudo \/opt\/ocm\/bin\/ocm-agent-uninstall/);
  assert.match(guide, /--purge-cache/);
  assert.match(guide, /Remove later with: sudo \/opt\/ocm\/bin\/ocm-agent-uninstall/);
});

test('the machine name is kept on reinstall and otherwise derived from the hardware id (P3)', () => {
  // Precedence: OCM_AGENT_ID, then the name already on disk, then hostname + a hash
  // of the platform UUID. The old default was the bare hostname, so a household of
  // identically named Macs registered as one, and a reinstall without OCM_AGENT_ID
  // registered a second host instead of recovering the first.
  assert.match(source, /AGENT_ID="\$\{OCM_AGENT_ID:-\$\(sed -n 's\|\^OCM_AGENT_ID=\|\|p' \/etc\/ocm\/agent\.env 2>\/dev\/null \| head -1\)\}"/,
    'an explicit name wins, then the one already recorded on this machine');
  assert.match(source, /IOPlatformUUID/);
  assert.doesNotMatch(source, /IOPlatformSerialNumber|hw\.serial|serialnumber/i,
    'the name is public on /v1/network; a device serial must never be part of it');
  assert.match(source, /shasum -a 256 \| cut -c1-6/, 'the suffix is a hash, not the UUID itself');
  const begin = source.indexOf('# --- name default (begin)\n');
  const end = source.indexOf('# --- name default (end)\n');
  assert.ok(begin > 0 && end > begin);
  const snippet = source.slice(begin, end);
  assert.equal((source.match(/hostname -s/g) || []).length, 1, 'the hostname is used only inside the fallback');
  assert.ok(snippet.includes('hostname -s'));
  // The dry run says where the name came from.
  assert.match(source, /name        \$AGENT_ID \(\$AGENT_ID_FROM\)/);

  // Run the fallback for real, with a fake ioreg and hostname on PATH and no env file,
  // and check the derived name byte for byte.
  const dir = mkdtempSync(join(tmpdir(), 'ocm-name-'));
  const uuid = '9E1C7A2B-1234-4ABC-9DEF-0123456789AB';
  writeFileSync(join(dir, 'ioreg'), `#!/bin/sh\nprintf '    | |   "IOPlatformUUID" = "${uuid}"\\n'\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'hostname'), '#!/bin/sh\necho "Michaels MacBook Air"\n', { mode: 0o755 });
  const expected = `michaels-macbook-air-${createHash('sha256').update(uuid).digest('hex').slice(0, 6)}`;
  const run = (env) => spawnSync('sh', ['-c', `${snippet}\nprintf '%s|%s' "$AGENT_ID" "$AGENT_ID_FROM"`],
    { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin`, ...env } });
  let r = run({});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${expected}|hostname + hardware id`);
  assert.match(expected, /^[-a-z0-9._]{1,64}$/, 'the derived name passes the installer allowlist');
  r = run({ OCM_AGENT_ID: 'chosen-name' });
  assert.equal(r.stdout, 'chosen-name|OCM_AGENT_ID');
  // No ioreg at all: refuse with advice rather than inventing a name.
  writeFileSync(join(dir, 'ioreg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  r = run({});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not read the hardware id; set OCM_AGENT_ID/);
});

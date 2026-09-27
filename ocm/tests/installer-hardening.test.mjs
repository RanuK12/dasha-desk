// Review findings P2-7, P2-8 and P2-12 (REVIEW-BUGS-SPEED-2026-09-11), roadmap R5/R8:
// the installer checksums agent.py, keeps the token off curl's argv, and never
// rewrites an installed file in place. Each is proved by running the real code lifted
// from install.sh — the marked regions and the functions they call — under a stub
// curl that records argv and stdin, never by grepping for a shape alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, statSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../agent/install.sh', import.meta.url), 'utf8');
// Announces itself as fake, which is what tests/no-secrets.test.mjs allows through.
const TOKEN = 'ocm_host_not_a_real_token_0123456789abcdef';

/** The text between `# --- <name> (begin)` and `# --- <name> (end)`. */
function region(text, name) {
  const begin = text.indexOf(`# --- ${name} (begin)\n`);
  const end = text.indexOf(`# --- ${name} (end)\n`);
  assert.ok(begin >= 0 && end > begin, `install.sh must mark the "${name}" region`);
  return text.slice(begin, end);
}
/** A shell function definition, lifted verbatim so the tests run the real one. */
function fn(name) {
  const m = source.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\}\\n`, 'm'))
    || source.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}\\n`, 'm'));
  assert.ok(m, `install.sh must define ${name}()`);
  return m[0];
}
/** The body of a helper the installer writes through a quoted heredoc. */
function helper(name, delimiter) {
  const start = source.indexOf(`cat > "$WORK/${name}" <<'${delimiter}'\n`);
  const end = source.indexOf(`\n${delimiter}\n`, start);
  assert.ok(start > 0 && end > start, `install.sh must generate ${name}`);
  return source.slice(source.indexOf('\n', start) + 1, end + 1);
}
const uncommented = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l));

/**
 * A stub curl on PATH: records every argument, one per line, and everything on stdin,
 * then serves the fixture whose path matches the URL. A missing fixture is a 22 under
 * --fail (curl's own code for an HTTP error) and an error body otherwise, which is
 * what the real gateway does with a bad token. A stub chown records the destination's
 * content at the moment it is called, which is how the atomic-write tests see whether
 * the target was already touched, and fails for one owner so failure paths can be run.
 */
function stubs() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-hardening-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'fixtures'), { recursive: true });
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
printf '%s\\n' "$@" >> "$STUB_DIR/argv"
cat >> "$STUB_DIR/stdin"
out=""; url=""; prev=""; fail=0
for a in "$@"; do
  [ "$prev" = "-o" ] && out=$a
  case $a in https://*|http://*) url=$a ;; --fail) fail=1 ;; esac
  prev=$a
done
rest=\${url#*://}; path=/\${rest#*/}
f="$STUB_DIR/fixtures$path"
if [ ! -f "$f" ]; then
  [ "$fail" = 1 ] && exit 22
  printf '{"message":"stub: no fixture for %s"}' "$path"; exit 0
fi
if [ -n "$out" ]; then cat "$f" > "$out"; else cat "$f"; fi
`, { mode: 0o755 });
  writeFileSync(join(bin, 'chown'), `#!/bin/sh
[ "$1" = "refused-owner" ] && exit 1
cat "$(cat "$STUB_DIR/watch")" > "$STUB_DIR/at-chown" 2>/dev/null || true
exit 0
`, { mode: 0o755 });
  const read = (name) => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return ''; } };
  return {
    dir, bin,
    env: (extra) => ({ PATH: `${bin}:/usr/bin:/bin`, STUB_DIR: dir, ...extra }),
    fixture: (path, body) => {
      mkdirSync(join(dir, 'fixtures', path, '..'), { recursive: true });
      writeFileSync(join(dir, 'fixtures', path), body);
    },
    unfixture: (path) => rmSync(join(dir, 'fixtures', path), { force: true }),
    argv: () => read('argv'),
    stdin: () => read('stdin'),
    atChown: () => read('at-chown'),
    reset: () => { for (const f of ['argv', 'stdin', 'at-chown']) rmSync(join(dir, f), { force: true }); },
  };
}
const run = (script, env) => spawnSync('sh', ['-c', `set -eu\n${script}`], { encoding: 'utf8', env });

// ---------------------------------------------------------------- P2-7: agent checksum

test('a downloaded agent that does not match its published checksum is refused (P2-7)', () => {
  const s = stubs();
  const work = join(s.dir, 'work');
  mkdirSync(work);
  const agent = '#!/usr/bin/env python3\nprint("agent")\n';
  const digest = createHash('sha256').update(agent).digest('hex');
  s.fixture('agent.py', agent);
  s.fixture('agent.py.sha256', `${digest}  agent.py\n`);
  const script = [fn('die'), fn('curl_https'), region(source, 'agent download'), 'echo reached-the-doctor'].join('\n');
  const env = s.env({ SOURCE: 'https://gateway.test', WORK: work });

  // The gateway's own file: accepted, executable, and identical to what was served.
  let r = run(script, env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reached-the-doctor/);
  assert.equal(readFileSync(join(work, 'agent.py'), 'utf8'), agent);
  assert.equal(statSync(join(work, 'agent.py')).mode & 0o777, 0o755);
  assert.match(s.argv(), /^https:\/\/gateway\.test\/agent\.py\.sha256$/m, 'the checksum is fetched from the same origin as the code');

  // One byte changed in transit, or a truncated download: refused before the doctor,
  // with the plain message, and the file is never marked executable.
  for (const tampered of [agent.replace('agent', 'agent-tampered'), agent.slice(0, 10)]) {
    s.fixture('agent.py', tampered);
    rmSync(join(work, 'agent.py'));
    r = run(script, env);
    assert.equal(r.status, 1, 'a mismatch must stop the installer');
    assert.match(r.stderr, /the downloaded agent does not match its published checksum; nothing was installed/);
    assert.doesNotMatch(r.stdout, /reached-the-doctor/);
    assert.notEqual(statSync(join(work, 'agent.py')).mode & 0o111, 0o111);
  }
  // No checksum at all, or one that is not a checksum: refused rather than skipped.
  s.fixture('agent.py', agent);
  s.fixture('agent.py.sha256', 'not a checksum\n');
  r = run(script, env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not match its published checksum/);
  s.unfixture('agent.py.sha256');
  r = run(script, env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not fetch https:\/\/gateway\.test\/agent\.py\.sha256; nothing was installed/);
});

test('the checksum is checked between the download and the doctor, and the update helper checks it too (P2-7)', () => {
  const download = source.indexOf('curl_https --fail "$SOURCE/agent.py" -o "$TMP_AGENT"');
  const checksum = source.indexOf('curl_https --fail "$SOURCE/agent.py.sha256" -o "$WORK/agent.py.sha256"');
  const check = source.indexOf('( cd "$WORK" && shasum -a 256 -c agent.py.sha256 >/dev/null 2>&1 )');
  const doctor = source.indexOf('"$UV" run --quiet --python 3.12 "$TMP_AGENT" --doctor');
  const install = source.indexOf('put 755 root "$TMP_AGENT" "$PREFIX/agent/agent.py"');
  assert.ok(download > 0 && checksum > download && check > checksum && doctor > check && install > doctor,
    'download -> checksum -> verify -> doctor -> install must be the order');
  // --dry-run says so where it previews the write, and reports the served build.
  const plan = source.slice(source.indexOf('# Everything above only reads.'), source.indexOf('dry run; nothing was changed\nPLAN'));
  assert.match(plan, /\$PREFIX\/agent\/agent\.py\s+755, only after it matches \$SOURCE\/agent\.py\.sha256/);
  assert.match(plan, /build\s+\$BUILD/);
  assert.match(plan, /SERVED=\$\(curl_https --fail "\$SOURCE\/agent\.py\.sha256" 2>\/dev\/null \| cut -c1-12\)/);
  // ocm-agent-update fetches agent.py to say whether a new build exists; that report,
  // and the install it leads to, go through the same pin.
  const upd = helper('ocm-agent-update', 'UPD');
  const fetch = upd.indexOf('fetch "$BASE/agent.py" -o "$WORK/agent.py"');
  const sum = upd.indexOf('fetch "$BASE/agent.py.sha256" -o "$WORK/agent.py.sha256"');
  const verify = upd.indexOf('( cd "$WORK" && shasum -a 256 -c agent.py.sha256 >/dev/null 2>&1 )');
  const state = upd.indexOf('AGENT_STATE=');
  const reinstall = upd.indexOf('sh "$WORK/install.sh"');
  assert.ok(fetch > 0 && sum > fetch && verify > sum && state > verify && reinstall > state,
    'the update helper must verify agent.py before reporting a build or reinstalling');
  assert.match(upd, /the downloaded agent does not match its published checksum; nothing was changed/);
  assert.equal(spawnSync('sh', ['-n'], { input: upd, encoding: 'utf8' }).status, 0);
});

// ---------------------------------------------------------------- P2-8: token off argv

test('no curl in the installer or its helpers carries a credential on argv (P2-8)', () => {
  for (const line of uncommented(source)) {
    assert.doesNotMatch(line, /(?:-H|--header)\s+["']?Authorization/, `a header argument is argv, visible in ps: ${line}`);
    assert.doesNotMatch(line, /Authorization: Bearer \$/, `a bearer value interpolated on a command line: ${line}`);
    assert.doesNotMatch(line, /(?:-u|--user)\s+["']?\S*\$(?:OCM_HOST_TOKEN|NEW_TOKEN)/, `credential on argv: ${line}`);
    assert.doesNotMatch(line, /--data\s+["'{]/, `--data "…" is argv; the body must reach curl on stdin: ${line}`);
    if (/Authorization/.test(line)) {
      assert.match(line, /printf 'header = "Authorization: Bearer %s"\\n' "\$(?:OCM_HOST_TOKEN|NEW_TOKEN)"/,
        `the only way a bearer header may be built is a printf builtin feeding -K -: ${line}`);
    }
  }
  // Every verify goes through the config-on-stdin path, in the installer and the helper.
  assert.match(fn('curl_bearer'), /printf 'header = "Authorization: Bearer %s"\\n' "\$OCM_HOST_TOKEN" \| curl_https -K - "\$@"/);
  const check = region(source, 'token check');
  assert.equal((check.match(/curl_bearer/g) || []).length, 2, 'both verify calls use curl_bearer');
  for (const line of uncommented(check)) {
    if (/provider\/verify/.test(line)) assert.match(line, /curl_bearer/, `the verify call must go through curl_bearer: ${line}`);
    assert.doesNotMatch(line, /curl_https [^\n]*OCM_HOST_TOKEN/, `a bare curl with the token: ${line}`);
  }
  const tok = helper('ocm-agent-token', 'TOK');
  assert.equal((tok.match(/-K - "\$BASE\/v1\/provider\/verify"/g) || []).length, 2, 'both helper verify calls read the header from stdin');
  assert.equal((tok.match(/bearer \| curl/g) || []).length, 2);
  // The enrollment exchange already used stdin on purpose and still does.
  assert.equal((uncommented(source).join('\n').match(/--data @-/g) || []).length, 4, 'both exchanges, with their reason lookups, feed the code on stdin');
  assert.equal(spawnSync('sh', ['-n'], { input: tok, encoding: 'utf8' }).status, 0);
});

test('the installer verify sends the token on curl stdin and never on argv (P2-8, runtime)', () => {
  const s = stubs();
  const script = [fn('die'), fn('curl_https'), fn('curl_bearer'), region(source, 'token check'), 'printf "%s" "$CREDENTIAL"'].join('\n');
  const env = s.env({ SOURCE: 'https://gateway.test', OCM_HOST_TOKEN: TOKEN, ENROLL_PENDING: '0', AGENT_ID: 'mac-1' });
  s.fixture('v1/provider/verify', '{"ok":true,"agent_id":"mac-1"}');
  let r = run(script, env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /token accepted/);
  assert.match(r.stdout, /provider token, accepted by the gateway$/);
  assert.doesNotMatch(s.argv(), new RegExp(TOKEN), 'the token must not be an argument to curl');
  assert.doesNotMatch(s.argv(), /Authorization/, 'the header must not be an argument to curl');
  assert.match(s.argv(), /^-K\n-$/m, 'curl reads its config from stdin');
  assert.match(s.argv(), /^https:\/\/gateway\.test\/v1\/provider\/verify$/m);
  assert.equal(s.stdin(), `header = "Authorization: Bearer ${TOKEN}"\n`, 'the header arrives on stdin, once');

  // A rejected token: the gateway's reason is shown, still with nothing on argv.
  s.reset();
  s.unfixture('v1/provider/verify');
  r = run(script, env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: stub: no fixture for \/v1\/provider\/verify/);
  assert.doesNotMatch(s.argv(), new RegExp(TOKEN));
  assert.equal(s.stdin(), `header = "Authorization: Bearer ${TOKEN}"\n`.repeat(2), 'the status call and the reason call each carry the header on stdin');
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOKEN), 'the token is never printed');
});

test('the rotation helper verify sends the token on curl stdin and never on argv (P2-8, runtime)', () => {
  const s = stubs();
  const script = [region(helper('ocm-agent-token', 'TOK'), 'rotation token check'), 'echo verified'].join('\n');
  const env = s.env({ BASE: 'https://gateway.test', NEW_TOKEN: TOKEN });
  s.fixture('v1/provider/verify', '{"ok":true}');
  let r = run(script, env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verified/);
  assert.doesNotMatch(s.argv(), new RegExp(TOKEN));
  assert.doesNotMatch(s.argv(), /Authorization/);
  assert.match(s.argv(), /^-K\n-$/m);
  assert.equal(s.stdin(), `header = "Authorization: Bearer ${TOKEN}"\n`);
  s.reset();
  s.unfixture('v1/provider/verify');
  r = run(script, env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: stub: no fixture for \/v1\/provider\/verify/);
  assert.match(r.stderr, /nothing was changed/);
  assert.doesNotMatch(r.stdout, /verified/);
  assert.doesNotMatch(s.argv(), new RegExp(TOKEN));
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOKEN));
});

// ---------------------------------------------------------------- P2-12: atomic writes

test('ocm-agent-token rewrites agent.env beside itself and renames it into place (P2-12)', () => {
  const tok = helper('ocm-agent-token', 'TOK');
  // Statically: nothing is ever redirected onto the live file; it is reached by rename
  // from a sibling that already has its mode and owner.
  for (const line of uncommented(tok)) {
    assert.doesNotMatch(line, />>?\s*(?:"\$ENV"|\/etc\/ocm\/agent\.env)/, `an in-place write to the env file: ${line}`);
    assert.doesNotMatch(line, /cat "\$TMP"/, 'copying the temp file back is the truncating write this replaces');
  }
  const rewrite = region(tok, 'env rewrite');
  const order = ['TMP=$(mktemp "$ENV.XXXXXX")', 'trap \'rm -f "$TMP"\' EXIT HUP INT TERM', '> "$TMP"',
    'chown "$OWNER" "$TMP"', 'chmod 600 "$TMP"', 'mv -f "$TMP" "$ENV"', 'trap - EXIT HUP INT TERM']
    .map((step) => { const at = rewrite.indexOf(step); assert.ok(at >= 0, `env rewrite must ${step}`); return at; });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'mktemp -> write -> chown -> chmod -> mv must be the order');
  assert.doesNotMatch(uncommented(rewrite).join('\n'), /TMPDIR/, 'the temporary file must be a sibling of the target, or mv is a copy');

  // At runtime: the target keeps its old content until the rename, the result carries
  // the new token and every other line, the mode is 600, and nothing is left behind.
  const s = stubs();
  const etc = join(s.dir, 'etc');
  mkdirSync(etc);
  const envFile = join(etc, 'agent.env');
  const before = `OCM_HOST_TOKEN=ocm_host_not_a_real_old_one_0000000000\nOCM_GATEWAY_URL=wss://gateway.test\nOCM_AGENT_ID=mac-1\nOCM_MODEL_MAP=ocm-coder=x\nOCM_REGION=us-west-2\n`;
  writeFileSync(envFile, before, { mode: 0o600 });
  writeFileSync(join(s.dir, 'watch'), '');   // the stub chown snapshots whatever this names
  const inode = statSync(envFile).ino;
  const r = run(rewrite, s.env({ ENV: envFile, OWNER: userInfo().username, NEW_TOKEN: TOKEN }));
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(statSync(envFile).ino, inode, 'the file was renamed into place, not overwritten');
  assert.equal(readFileSync(envFile, 'utf8'),
    `OCM_GATEWAY_URL=wss://gateway.test\nOCM_AGENT_ID=mac-1\nOCM_MODEL_MAP=ocm-coder=x\nOCM_REGION=us-west-2\nOCM_HOST_TOKEN=${TOKEN}\n`);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(etc), ['agent.env'], 'no temporary file survives the rename');
});

test('at the moment the rewrite sets ownership, the live env file is still the old one (P2-12)', () => {
  // The stub chown copies the file named by $STUB_DIR/watch when it runs. That is after
  // the new content is fully written and before the rename, so an in-place write would
  // already show the new token here.
  const s = stubs();
  const etc = join(s.dir, 'etc');
  mkdirSync(etc);
  const envFile = join(etc, 'agent.env');
  const before = `OCM_GATEWAY_URL=wss://gateway.test\nOCM_HOST_TOKEN=ocm_host_not_a_real_old_one_0000000000\n`;
  writeFileSync(envFile, before, { mode: 0o600 });
  writeFileSync(join(s.dir, 'watch'), envFile);
  const r = run(region(helper('ocm-agent-token', 'TOK'), 'env rewrite'), s.env({ ENV: envFile, OWNER: userInfo().username, NEW_TOKEN: TOKEN }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.atChown(), before, 'the live file must be untouched until the rename');
  assert.equal(readFileSync(envFile, 'utf8'), `OCM_GATEWAY_URL=wss://gateway.test\nOCM_HOST_TOKEN=${TOKEN}\n`);
});

test('every file the installer writes goes through put(): sibling temp, mode, owner, rename (P2-12)', () => {
  // With every heredoc body (the generated helpers, the plan, the plist) set aside,
  // the only redirects left are into the private work directory or a descriptor; each
  // destination is reached by put and nothing else.
  const own = source.replace(/<<'?([A-Z]+)'?\n[\s\S]*?\n\1\n/g, '<<$1\n$1\n');
  for (const line of uncommented(own)) {
    for (const m of line.matchAll(/(?:^|[^&|<])>>?\s*("?[^\s";)]+"?)/g)) {
      const target = m[1];
      if (target === '/dev/null' || target.startsWith('&') || target.startsWith('"$WORK/')) continue;
      assert.fail(`a write outside the work directory that is not a put: ${line}`);
    }
  }
  const puts = [...own.matchAll(/^put (\d{3}) (\S+) (\S+) (\S+)(?:\s+#.*)?$/gm)].map((m) => [m[1], m[2], m[4]]);
  assert.deepEqual(puts, [
    ['755', 'root', '"$PREFIX/agent/agent.py"'],
    ['600', '"$RUN_USER"', '/etc/ocm/agent.env'],
    ['755', 'root', '"$PREFIX/bin/ocm-agent-run"'],
    ['755', 'root', '"$PREFIX/bin/ocm-agent-token"'],
    ['755', 'root', '"$PREFIX/bin/ocm-agent-update"'],
    ['755', 'root', '"$PREFIX/bin/ocm-agent-uninstall"'],
    ['644', 'root', '/Library/LaunchDaemons/com.ocm.agent.plist'],
  ]);
  assert.doesNotMatch(own, /install -m 755 "\$TMP_AGENT"/, 'install(1) unlinks and copies; it is not a rename');
  assert.doesNotMatch(own, /^chmod \d{3} (?:"\$PREFIX|\/etc\/ocm\/agent|\/Library)/m, 'modes are set on the sibling, not after the fact');
  const put = region(source, 'put');
  assert.match(put, /PUT_TMP=\$\(mktemp "\$4\.XXXXXX"\)/, 'the temporary file is a sibling of the destination');
  assert.match(put, /cp "\$3" "\$PUT_TMP" && chown "\$2" "\$PUT_TMP" && chmod "\$1" "\$PUT_TMP" \\\n\s+&& mv -f "\$PUT_TMP" "\$4"/);
  assert.match(source, /trap 'rm -rf "\$WORK"; \[ -z "\$PUT_TMP" \] \|\| rm -f "\$PUT_TMP"' EXIT HUP INT TERM/,
    'an interrupted put leaves no sibling behind');
});

test('put() leaves the destination whole until the rename, and untouched when it fails (P2-12, runtime)', () => {
  const s = stubs();
  const dir = join(s.dir, 'dest');
  mkdirSync(dir);
  const dest = join(dir, 'installed');
  const src = join(s.dir, 'staged');
  writeFileSync(dest, 'old and working\n', { mode: 0o600 });
  writeFileSync(src, 'new\n', { mode: 0o600 });
  writeFileSync(join(s.dir, 'watch'), dest);
  const script = [fn('die'), region(source, 'put'), 'put 755 "$OWNER" "$SRC" "$DEST"', 'echo installed'].join('\n');
  const inode = statSync(dest).ino;
  let r = run(script, s.env({ OWNER: userInfo().username, SRC: src, DEST: dest }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.atChown(), 'old and working\n', 'the destination is the old file until the rename');
  assert.notEqual(statSync(dest).ino, inode, 'the file was renamed into place, not overwritten');
  assert.equal(readFileSync(dest, 'utf8'), 'new\n');
  assert.equal(statSync(dest).mode & 0o777, 0o755, 'the mode travels with the rename');
  assert.equal(readFileSync(src, 'utf8'), 'new\n', 'the staged copy is left for the work-directory cleanup');
  assert.deepEqual(readdirSync(dir), ['installed'], 'no sibling temp survives');

  // chown refuses: the old file is still there, byte for byte, and no sibling remains.
  writeFileSync(dest, 'old and working\n');
  chmodSync(dest, 0o600);
  r = run(script, s.env({ OWNER: 'refused-owner', SRC: src, DEST: dest }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not install .*installed; what was there before is untouched/);
  assert.doesNotMatch(r.stdout, /installed/);
  assert.equal(readFileSync(dest, 'utf8'), 'old and working\n');
  assert.equal(statSync(dest).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['installed']);
});

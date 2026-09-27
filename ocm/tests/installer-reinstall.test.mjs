import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// TASKS.md item 4: reinstall idempotency tests for the installer. The
// machine-keeps-its-name behavior (P3) is pinned in installer-security.test.mjs;
// this file pins the other two reinstall promises: a reinstall never re-pulls the
// model (the Hugging Face cache is untouched), and the provider env file keeps
// the values already on disk unless the caller overrides them explicitly.
const source = readFileSync(new URL('../agent/install.sh', import.meta.url), 'utf8');

function snippet(name) {
  const begin = source.indexOf(`# --- ${name} (begin)\n`);
  const end = source.indexOf(`# --- ${name} (end)\n`);
  assert.ok(begin > 0 && end > begin, `the installer marks the ${name} block`);
  return source.slice(begin, end);
}

test('a reinstall never re-pulls the model: the installer downloads only the agent and its checksum', () => {
  const download = snippet('agent download');
  assert.match(download, /curl_https --fail "\$SOURCE\/agent\.py" -o "\$TMP_AGENT"/,
    'the one code download is the agent');
  assert.match(download, /curl_https --fail "\$SOURCE\/agent\.py\.sha256" -o "\$WORK\/agent\.py\.sha256"/,
    'the checksum comes from the same origin, and a mismatch stops the install');
  assert.equal((download.match(/curl_https --fail/g) || []).length, 2,
    'no other network fetch lives in the download block');
  assert.doesNotMatch(source, /snapshot_download|huggingface-cli|from huggingface_hub|hf download/i,
    'no model-weight download exists anywhere in the installer');
});

test('the real install path never names the model cache; only the dry run and the uninstaller do', () => {
  // Everything the live run does — fetch the agent, prove it, write the files,
  // start the daemon — sits between the dry run's early exit and the generated
  // uninstaller. If no step there can name the cache, no step can re-pull it.
  const dryRunEnd = source.indexOf('dry run; nothing was changed\nPLAN\n  exit 0\nfi\n');
  const uninstaller = source.indexOf('cat > "$WORK/ocm-agent-uninstall" <<\'UNINST\'');
  assert.ok(dryRunEnd > 0 && uninstaller > dryRunEnd);
  const realRun = source.slice(dryRunEnd, uninstaller);
  assert.doesNotMatch(realRun, /HUB\b/, 'the live install never references the model cache directory');
  assert.doesNotMatch(realRun, /huggingface\/hub/, 'the live install never names the weights cache');
});

test('the dry run reports the model cache state, and the detection runs for real', () => {
  assert.match(source, /model       \$HUB\n              \$CACHE/,
    'the dry-run plan shows the cache state under the model line');
  const cache = snippet('model cache');
  const model = 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit';
  const dir = mkdtempSync(join(tmpdir(), 'ocm-cache-'));
  const run = () => spawnSync('sh', ['-c', `${cache}\nprintf '%s|%s' "$HUB" "$CACHE"`],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', RUN_HOME: dir, MLX_MODEL: model } });
  const expectedHub = `${dir}/.cache/huggingface/hub/models--mlx-community--Qwen2.5-Coder-7B-Instruct-4bit`;

  // Cache absent: the plan says the download happens on first request, not now.
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${expectedHub}|absent; about 4.5 GB downloads on the first request, not during install`);

  // Cache present: the plan says the installer does not touch it.
  mkdirSync(expectedHub, { recursive: true });
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith(`${expectedHub}|present, `), 'a present cache is reported, with its size');
  assert.match(r.stdout, /the installer does not touch it$/,
    'a reinstall visibly skips the model it already has');
});

test('the provider env file keeps what is already on disk: name, region and preload all resolve explicit-then-kept', () => {
  // Precedence, in order: the OCM_* env var when given, otherwise the value already
  // recorded in /etc/ocm/agent.env, otherwise the default. The name half of this is
  // pinned in installer-security.test.mjs (P3); this pins the env-file half.
  assert.match(source,
    /REGION="\$\{OCM_REGION:-\$\(sed -n 's\|\^OCM_REGION=\|\|p' \/etc\/ocm\/agent\.env 2>\/dev\/null \| head -1\)\}"/,
    'explicit OCM_REGION wins, then the existing env file, then unset');
  assert.match(source,
    /PRELOAD="\$\{OCM_PRELOAD:-\$\(sed -n 's\|\^OCM_PRELOAD=\|\|p' \/etc\/ocm\/agent\.env 2>\/dev\/null \| head -1\)\}"/,
    'explicit OCM_PRELOAD wins, then the existing env file, then unset');
  assert.match(source, /matches "\$PRELOAD" '\^\[01\]\$'/,
    'a kept preload value is still allowlisted before it is written');
  // The kept values are written back into the staged env file, which stays minimal:
  // the region and preload lines appear only when they are set.
  const staged = source.indexOf('cat > "$WORK/agent.env" <<ENV');
  const published = source.indexOf('put 600 "$RUN_USER" "$WORK/agent.env" /etc/ocm/agent.env');
  assert.ok(staged > 0 && published > staged);
  const body = source.slice(staged, published);
  assert.match(body, /OCM_AGENT_ID=\$AGENT_ID/, 'the kept name is written back');
  assert.match(body, /\[ -z "\$REGION" \] \|\| printf 'OCM_REGION=%s\\n' "\$REGION" >> "\$WORK\/agent\.env"/,
    'the kept region is written back, and only when set');
  assert.match(body, /\[ -z "\$PRELOAD" \] \|\| printf 'OCM_PRELOAD=%s\\n' "\$PRELOAD" >> "\$WORK\/agent\.env"/,
    'the kept preload switch is written back, and only when set');
});

test('the preload precedence runs for real: explicit wins, unset means unset', () => {
  // The /etc/ocm/agent.env half of the precedence is pinned by the source shape
  // above (the same sed line the name and region keepers use); here the explicit
  // and default branches run.
  const resolve = `PRELOAD="\${OCM_PRELOAD:-$(sed -n 's|^OCM_PRELOAD=||p' /etc/ocm/agent.env 2>/dev/null | head -1)}"; printf '%s' "$PRELOAD"`;
  const run = (env) => spawnSync('sh', ['-c', resolve],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } });
  let r = run({ OCM_PRELOAD: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '1', 'an explicit OCM_PRELOAD wins over whatever is on disk');
  r = run({});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'with no override and no env file, preload stays unset and the agent reports lazy loading');
});

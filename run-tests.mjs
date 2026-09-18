#!/usr/bin/env node
/**
 * Root test runner for dasha-desk.
 *
 * Every gate runs to completion even when an earlier gate fails, so one
 * broken gate (or one missing browser) can no longer blind the rest of the
 * suite. The old `npm test` was a single `&&` chain: the first nonzero exit
 * swallowed every downstream gate. This runner reports each gate
 * independently and exits nonzero only after all of them have run.
 *
 *   node run-tests.mjs
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';

const testFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => `${dir}/${f}`);

/* [name, argv] — argv runs as `node <argv...>`. Keep the order the old &&
   chain used so output stays familiar. */
const GATES = [
  ['build check', ['build.mjs', '--check']],
  ['share pack', ['dasha-share.test.mjs']],
  ['oss docs', ['dasha-oss-docs.test.mjs']],
  ['mint consistency', ['dasha-mint-consistency.test.mjs']],
  ['desk resilience', ['dasha-desk-resilience.test.mjs']],
  ['build protocol', ['dasha-build-protocol.test.mjs']],
  ['home', ['home/home.test.mjs']],
  ['lobby', ['lobby/lobby.test.mjs']],
  ['leftover chess', ['leftover-chess.test.mjs']],
  ['leftover lobby', ['leftover-lobby.test.mjs']],
  ['surfaces', ['dasha-surfaces.test.mjs']],
  ['bounties', ['bounties/bounties.test.mjs']],
  ['release watch', ['watch.test.mjs']],
  ['compute', ['--test', ...testFiles('compute/tests')]],
  ['nodeblink settlement', ['--test', 'utility/nodeblink-settlement.test.mjs']],
];

const GATE_TIMEOUT_MS = 10 * 60 * 1000;

function runGate(name, argv) {
  return new Promise((resolve) => {
    const started = Date.now();
    console.log(`\n${'='.repeat(64)}\n▶ ${name}: node ${argv.join(' ')}\n${'='.repeat(64)}`);
    const child = spawn(process.execPath, argv, {
      cwd: new URL('.', import.meta.url).pathname,
      stdio: 'inherit',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, GATE_TIMEOUT_MS);
    timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ name, ok: false, code: 'spawn-error', detail: String(err).slice(0, 120), ms: Date.now() - started });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const ok = !timedOut && code === 0;
      resolve({
        name,
        ok,
        code: timedOut ? 'timeout' : (code === 0 ? 0 : code ?? `signal ${signal}`),
        ms: Date.now() - started,
      });
    });
  });
}

const results = [];
for (const [name, argv] of GATES) {
  // eslint-disable-next-line no-await-in-loop -- gates run sequentially on purpose
  results.push(await runGate(name, argv));
}

console.log(`\n${'='.repeat(64)}\nROOT TEST SUMMARY\n${'='.repeat(64)}`);
let failed = 0;
for (const r of results) {
  const status = r.ok ? 'PASS' : 'FAIL';
  const extra = r.ok ? '' : ` (exit ${r.code})`;
  console.log(`${r.ok ? '✔' : '✘'} ${status.padEnd(4)} ${r.name} — ${(r.ms / 1000).toFixed(1)}s${extra}`);
  if (!r.ok) failed += 1;
}
if (failed) {
  console.error(`\n${failed} of ${results.length} gates FAILED — see above.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} gates passed.`);

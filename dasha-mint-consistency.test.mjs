#!/usr/bin/env node
/** Assert associated mint stays consistent across config and UI sources. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/* The expected mint is pinned HERE, as a literal, and the config is checked against it.
   It used to be the other way round — `const mint = cfg.mint` — which made this gate self-
   referential: it asked whether the site agreed with its own config, never whether the config was
   right. Mutation-proved on 2026-08-11: replacing the mint across config/dasha.json, src/body.html
   and src/app.js with an unrelated address still printed PASS and exited 0. The shape check
   (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) accepted any base58 string, so it caught nothing either.
   Twelve other gates already pin this literal; this one is now the thirteenth. */
const MINT = '53uxQtB9pcjWvCHguz3JTTndvuKqGxhrD37EetnCpump';

const cfg = JSON.parse(read('config/dasha.json'));
const mint = cfg.mint;
assert.equal(typeof mint, 'string');
assert.equal(mint, MINT, 'config/dasha.json mint is not the associated $dasha mint');

const body = read('src/body.html');
const app = read('src/app.js');
assert.ok(body.includes(mint), 'src/body.html missing config mint');
assert.ok(app.includes(mint), 'src/app.js missing config mint');

/* Any pump-suffixed address on our own surfaces must be ours. This used to match
   /53uxQtB9[A-Za-z0-9]+/ — the current mint's own prefix — so a full substitution matched nothing
   and the loop body never ran. Keyed on the address shape instead, it still catches the paste-typo
   class it was written for and now also catches a wholesale swap. */
for (const [name, text] of [['body.html', body], ['app.js', app]]) {
  /* Percent-escapes are neutralised before scanning. The Desk shares the mint through an X intent
     URL, where the address is preceded by `%0A` — so a raw scan starts one character early, matches
     `A53uxQtB9…pump`, and reports the correct mint as divergent from itself. A lookbehind does not
     help: the `A` of `%0A` really is a base58 character preceded by a non-base58 `%`. */
  const scan = text.replace(/%[0-9A-Fa-f]{2}/g, ' ');
  for (const found of [...scan.matchAll(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}pump/g)].map((m) => m[0])) {
    assert.equal(found, MINT, `${name} shows a mint that is not ours — ${found}`);
  }
}

/* The Desk's paste-verify uses the same well-formed window the chain scan above
   does: 32-44 base58 chars. It once accepted 45-50 chars as "does not match the
   associated mint" — wrong, since those are not Solana addresses at all. */
assert.ok(
  /raw\.length >= 32 && raw\.length <= 44 &&/.test(app),
  'src/app.js verify() well-formed window is not 32-44'
);

console.log('dasha-mint-consistency: PASS');

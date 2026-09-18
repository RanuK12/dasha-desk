#!/usr/bin/env node
/**
 * The Desk under data failure.
 *
 * README.md promises: "Third-party links and data can fail; the mint and source paths should remain
 * usable when they do." That was never tested. The Desk fetches live market data from DexScreener,
 * and third parties go down, rate-limit, and return nonsense.
 *
 * The thing being protected is not the price. It is that during an outage the page must not state
 * something false. A market cap rendering as `0`, `NaN` or `$0.00` while the API is broken is worse
 * than showing nothing — a visitor reads it as a fact about the token.
 *
 * So each failure mode is injected independently and the page is rendered, then checked for:
 *   - the mint still visible and copyable, because that is the one thing people came for;
 *   - the independent source links still present;
 *   - no fabricated number standing in for missing data.
 *
 *   node dasha-desk-resilience.test.mjs        # uses CDP :9223 or launches installed Chrome
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const MINT = '53uxQtB9pcjWvCHguz3JTTndvuKqGxhrD37EetnCpump';

/* Serve real files, not the same HTML for every path. The first version of this test answered every
   request with index.html, so `src/app.js` arrived as HTML, the browser threw "Unexpected token '<'"
   and the app never ran — which meant the test was checking static markup and would have passed no
   matter how badly the failure handling behaved. A harness that cannot fail is worse than none. */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const body = await readFile(new URL('.' + path, import.meta.url));
    const ext = path.slice(path.lastIndexOf('.'));
    res.setHeader('Content-Type', (TYPES[ext] || 'application/octet-stream') + '; charset=utf-8');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

/* Each mode is a way a third party actually fails, not a way it theoretically could. Timeouts and
   malformed bodies are the common ones; the "plausible but wrong" case is the dangerous one,
   because the shape passes and the values are lies. */
const MODES = {
  'http 500': (req) => req.respond({ status: 500, contentType: 'text/plain', body: 'upstream error' }),
  'connection failure': (req) => req.abort('failed'),
  'malformed json': (req) => req.respond({ status: 200, contentType: 'application/json', body: '{"pairs":[' }),
  'empty pair list': (req) => req.respond({ status: 200, contentType: 'application/json', body: '{"pairs":[]}' }),
  'nulls in every field': (req) => req.respond({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ pairs: [{ priceUsd: null, marketCap: null, liquidity: null, priceChange: null, txns: null }] }),
  }),
};

let ownsBrowser = false;
let browser;
try {
  browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9223' });
} catch {
  const executablePath = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((path) => path && existsSync(path));
  /* This gate must never abort the whole npm test chain for an environment
     reason. If there is no browser to drive, say so and skip — the gate
     reports PASS-with-skip so the other gates still run. */
  if (!executablePath) {
    console.log(
      'Desk resilience: SKIP — no Chrome/Chromium found and no CDP endpoint on ' +
      'http://127.0.0.1:9223. Install Chrome/Chromium or set PUPPETEER_EXECUTABLE_PATH to run this gate.'
    );
    server.close();
    process.exit(0);
  }
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  ownsBrowser = true;
}
const failures = [];

for (const [mode, handler] of Object.entries(MODES)) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 90)));
  /* Counted, and asserted below. The first version of this test never loaded app.js, so the fetch
     never happened and every mode "passed" without exercising a line of failure handling. If the
     app does not reach for its data, this test proves nothing and must say so. */
  let intercepted = 0;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('api.dexscreener.com')) { intercepted++; handler(req); }
    else req.continue();
  });
  await page.setViewport({ width: 1100, height: 900 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2500)); // let the fetch resolve and the UI settle

  const state = await page.evaluate((mint) => {
    const text = document.body.innerText;
    const links = [...document.querySelectorAll('a[href]')].map((a) => a.href);
    return {
      mintShown: text.includes(mint) || [...document.querySelectorAll('*')].some((el) => el.textContent.trim() === mint),
      solscan: links.some((h) => h.includes('solscan.io')),
      jupiter: links.some((h) => h.includes('jup.ag')),
      // a number standing in for missing data is the failure we care about
      fabricated: /\bNaN\b|\$0\.00\b|\$NaN|undefined/.test(text),
      text,
    };
  }, MINT);

  const say = (ok, what) => { if (!ok) failures.push(`${mode}: ${what}`); };
  say(intercepted > 0, 'the app never requested market data — this mode tested nothing');
  say(state.mintShown, 'the mint disappeared — the one thing the page exists to show');
  say(state.solscan && state.jupiter, 'source links went missing');
  say(!state.fabricated, 'rendered NaN/undefined/$0.00 in place of missing data — that reads as a fact');
  say(pageErrors.length === 0, `uncaught page error: ${pageErrors[0] || ''}`);

  console.log(`${mode.padEnd(22)} fetches:${intercepted} mint:${state.mintShown ? 'ok ' : 'GONE'} links:${state.solscan && state.jupiter ? 'ok ' : 'GONE'} fabricated:${state.fabricated ? 'YES' : 'no '} errors:${pageErrors.length}`);
  await page.close();
}

if (ownsBrowser) await browser.close();
else await browser.disconnect();
server.closeAllConnections();
server.close();

if (failures.length) {
  console.error(`\nDesk resilience: ${failures.length} FAILURE(S)\n`);
  for (const f of failures) console.error('  · ' + f);
  process.exit(1);
}
console.log('\nDesk resilience: PASS (mint and sources survive every injected data failure, no fabricated numbers)');

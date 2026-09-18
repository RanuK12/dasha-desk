/**
 * Trust-reset contract for dasha desk.
 * Neutral mint/source surface — no FOMO, raid, referral, or Telegram.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, 'src/app.js'), 'utf8');
const body = readFileSync(join(__dirname, 'src/body.html'), 'utf8');
const styles = readFileSync(join(__dirname, 'src/styles.css'), 'utf8');
const build = readFileSync(join(__dirname, 'build.mjs'), 'utf8');
const standalone = readFileSync(join(__dirname, 'index.html'), 'utf8');

const sandbox = {
  globalThis: {},
  window: undefined,
  document: undefined,
  navigator: undefined,
  console,
  URL,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(src, sandbox, { filename: 'src/app.js' });

const DD = sandbox.globalThis.DDShare;
assert.ok(DD, 'DDShare must export from app.js');
assert.equal(DD.CA, '53uxQtB9pcjWvCHguz3JTTndvuKqGxhrD37EetnCpump');
assert.ok(DD.BUY.includes('jup.ag') && DD.BUY.includes(DD.CA), 'BUY is Jupiter + mint');
assert.equal(DD.PAIR, 'https://www.geckoterminal.com/solana/pools/9KkDpvUQRqXjiuyMFcy1CwqrxLwDcGGUR2Cap2Qt7bU7');

const share = DD.buildSharePack('share');
assert.ok(share.includes(DD.CA), 'share pack includes mint');
assert.ok(!share.includes('jup.ag'), 'share pack does not disguise a second buy route');
assert.ok(share.includes(DD.PAIR), 'share pack includes the canonical GeckoTerminal pool');
assert.ok(!share.includes('dexscreener.com'), 'share pack must not restore the editable Dexscreener profile');
assert.ok(!/raid|fomo|invite|referral|telegram|t\.me/i.test(share), 'share pack stays neutral');
assert.ok(!/culture coin|rugcheck|risk/i.test(share), 'retired coin framing returned');

const verify = DD.buildSharePack('verify');
assert.ok(verify.includes('solscan.io/token/' + DD.CA));
assert.ok(verify.includes(DD.CA));
assert.ok(!verify.includes('jup.ag'), 'verify pack stays informational');

// Mint paste: explorer URLs and zero-width junk
assert.equal(DD.normalizeMint(DD.CA), DD.CA);
assert.equal(DD.normalizeMint('  ' + DD.CA + '  '), DD.CA);
assert.equal(DD.normalizeMint('https://solscan.io/token/' + DD.CA), DD.CA);
assert.equal(DD.normalizeMint('https://jup.ag/swap?sell=So11111111111111111111111111111111111111112&buy=' + DD.CA), DD.CA);
assert.equal(DD.normalizeMint('\u200b' + DD.CA), DD.CA);
assert.notEqual(DD.normalizeMint('11111111111111111111111111111111'), DD.CA);

// Last-visit stamp (localStorage-shaped mock)
assert.equal(typeof DD.visitStamp, 'function', 'visitStamp exported');
const mem = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
})();
const first = DD.visitStamp(mem, 1_700_000_000_000, DD.CA);
assert.equal(first.mintChanged, false);
assert.match(first.label, /first check/i);
const second = DD.visitStamp(mem, 1_700_000_100_000, DD.CA);
assert.equal(second.mintChanged, false);
assert.match(second.label, /last check/i);
const drift = DD.visitStamp(mem, 1_700_000_200_000, '11111111111111111111111111111111');
assert.equal(drift.mintChanged, true);
assert.match(drift.label, /differs|re-verify/i);

assert.ok(body.includes('id="dd-visit"'), 'body has #dd-visit');
assert.ok(body.includes('id="dd-age"'), 'body has #dd-age');

assert.equal(typeof DD.ageLabel, 'function', 'ageLabel exported');
assert.equal(DD.ageLabel(0, 50_000), '');
assert.equal(DD.ageLabel(1_000, 5_000), 'just now');
assert.equal(DD.ageLabel(1_000, 41_000), 'checked 40 seconds ago');
assert.equal(DD.ageLabel(1_000, 64_400), 'about a minute ago');
assert.doesNotMatch(DD.ageLabel(1_000, 64_400), /\d+\.\d|63\.4s|64\.4s/);
assert.equal(DD.ageLabel(1_000, 1_000 + 5 * 60_000), 'checked 5 minutes ago');
assert.equal(DD.ageLabel(1_000, 1_000 + 60 * 60_000), 'about an hour ago');


// Body contract: core IDs present, pressure surfaces gone
for (const id of [
  'dd-ca',
  'dd-copy',
  'dd-copy-share',
  'dd-share',
  'dd-tweet',
  'dd-paste',
  'dd-verify',
  'dd-refresh',
  'dd-buy',
  'dd-chart',
]) {
  assert.ok(body.includes('id="' + id + '"'), 'body has #' + id);
}

assert.ok(body.includes('id="dd-buy"') && body.includes('jup.ag/swap'), 'one Jupiter buy route');
assert.equal((body.match(/jup\.ag\/swap/g) || []).length, 1, 'exactly one Jupiter swap URL in body');
assert.ok(!/t\.me|telegram/i.test(body), 'no Telegram');
assert.ok(!/id="dd-fomo"|dd-fomo-|Raid this|raid kit|invite loop|dd-ref-chip|dd-sticky|dd-kit-raid/i.test(body), 'no FOMO/raid/referral/sticky chrome');
assert.ok(!/data-raid|data-pack="raid"|Copy raid|Buy the dip/i.test(body), 'no raid/dip CTAs');
assert.ok(body.includes('solscan'), 'source link present');
assert.ok(!/rugcheck|source, risk/i.test(body), 'negative risk framing returned');
const decodedBody = body.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
assert.ok(!/can go to zero|not financial advice|association is not endorsement|\bNFA\b/i.test(decodedBody),
  'URL-encoded share copy must not hide retired coin disclaimers');

// Poster spine: five tokens, hard offsets, no lavender glass.
assert.match(styles, /--ink:\s*#070608/i);
assert.match(styles, /--paper:\s*#f4eddb/i);
assert.match(styles, /--acid:\s*#dfff00/i);
assert.match(styles, /--hot:\s*#ff3b81/i);
assert.match(styles, /--violet:\s*#7c4dff/i);
assert.match(styles, /"Arial Black",Arial,Helvetica/);
assert.match(styles, /box-shadow:\s*4px 4px 0 var\(--hot\)/);
assert.doesNotMatch(styles, /system-ui|\bExo\b|\bBangers\b|\bRaleway\b/i);
assert.doesNotMatch(styles, /#f6f1ff|#c4a5ff|#7c3aed|#7dffa3|#a78bfa|#5b21b6|#2a1840/i);
assert.doesNotMatch(styles, /backdrop-filter/);
assert.doesNotMatch(styles, /linear-gradient\s*\(\s*135deg/i);
assert.ok(!body.includes('dd-avatar'), 'likeness must not be used as a logo');
assert.match(body, /class="dd-nav"/);
assert.match(body, /\$<span>DASHA<\/span>/);
assert.doesNotMatch(body, /dgnav|\.dgnav/);

// Styles stay free of pressure chrome
assert.ok(styles.includes('.dd-btn') && styles.includes('.dd-verify'), 'core styles present');
assert.ok(!/\.dd-fomo|\.dd-sticky|\.dd-raid/i.test(styles), 'no FOMO/sticky/raid styles');
for (const selector of ['#dd-app a:focus-visible', '#dd-app button:focus-visible', '#dd-app input:focus-visible', '#dd-app textarea:focus-visible']) {
  assert.ok(styles.includes(selector), `visible focus rule missing ${selector}`);
}
assert.ok(body.includes('id="dd-asof" role="status" aria-live="polite"'), 'market status is not announced');
assert.ok(body.includes('id="dd-toast" role="status" aria-live="polite"'), 'copy status is not announced');

// Standalone previews use the verified, no-likeness Dasha card rather than the retired casino image.
assert.ok(build.includes('<link rel="canonical" href="https://www.getdasha.com/dasha"/>'), 'Desk canonical missing');
assert.ok(build.includes('<meta property="og:url" content="https://www.getdasha.com/dasha"/>'), 'Desk og:url missing');
assert.ok(build.includes('<title>$dasha desk — verify, chart, buy</title>'), 'Desk title drifted from production');
assert.ok(build.includes('dasha-icon-32.png') && build.includes('dasha-icon-180.png'), 'standalone Desk icons missing');
const socialCard = 'https://cdn.prod.website-files.com/5f1458122ba25e70a3ff2bd0/6a773b5a0a2303b170ea67c0_dasha-social-card-v3.png';
assert.ok(build.includes(`<meta property="og:image" content="${socialCard}"/>`), 'standalone Desk social card missing');
assert.ok(build.includes(`<meta name="twitter:image" content="${socialCard}"/>`), 'standalone Desk Twitter card missing');
assert.ok(build.includes('<meta property="og:image:width" content="1200"/>') && build.includes('<meta property="og:image:height" content="630"/>'), 'standalone Desk social dimensions missing');
assert.ok(!/gpjyb0|casino-open-card/i.test(build), 'standalone Desk retained the retired casino card');
for (const url of ['https://www.getdasha.com/', 'https://www.getdasha.com/lobby', 'https://www.getdasha.com/bounties', 'https://www.getdasha.com/how-to-buy']) {
  assert.ok(standalone.includes(`href="${url}"`), `standalone navigation lost ${url}`);
}
assert.ok(!standalone.includes('https://www.getdasha.com/studio'), 'standalone must not advertise live /studio');
assert.ok(!/href="\/(?:studio|dasha|bounties)\/?"/.test(standalone), 'standalone navigation breaks on a subpath host');
assert.match(build, /theme-color" content="#070608"/);
assert.doesNotMatch(build, /#2a1840|#07060a|#0b0a10/);
assert.doesNotMatch(build, /<iframe/i);

// App must not reintroduce pressure builders
assert.ok(!/fomoDipHeadline|dipRaidLabel|buildSharePack\('raid'|dd-fomo-raid|invite loop|ref=/i.test(src), 'app.js free of FOMO/raid/ref builders');
assert.ok(src.includes('DDShare') && src.includes('buildSharePack'), 'DDShare export kept');

// A later Dex failure must clear previously painted numbers instead of presenting stale data.
{
  const elements = new Proxy({}, {
    get(store, id) {
      if (!store[id]) store[id] = {
        textContent: '',
        value: '',
        hidden: false,
        style: { removeProperty(name) { delete this[name]; } },
        listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
      };
      return store[id];
    },
  });
  let requests = 0;
  const dom = {
    globalThis: null,
    document: { getElementById: id => elements[id], addEventListener() {}, visibilityState: 'visible' },
    navigator: {},
    URL,
    console,
    isFinite,
    AbortController,
    clearTimeout() {},
    setTimeout() { return 1; },
    setInterval() { return 1; },
    fetch: async () => ++requests === 1
      ? { ok: true, json: async () => ({ pairs: [{ priceUsd: '1', marketCap: 2000, liquidity: { usd: 3000 }, priceChange: { h24: 4 }, dexId: 'test' }] }) }
      : { ok: false, status: 503 },
  };
  dom.globalThis = dom;
  vm.runInNewContext(src, dom, { filename: 'src/app.js' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements['s-price'].textContent, '$1.00', 'successful Dex response did not paint');
  assert.match(elements['dd-age'].textContent, /just now|checked|ago/);
  const ageAfterOk = elements['dd-age'].textContent;
  elements['dd-refresh'].listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(['s-price', 's-mcap', 's-liq', 's-24h', 'dd-px'].map(id => elements[id].textContent), ['—', '—', '—', '—', '—'], 'failed Dex refresh left stale data');
  assert.match(elements['dd-asof'].textContent, /unavailable · use sources below/i);
  assert.equal(elements['dd-age'].textContent, ageAfterOk, 'failed refresh must not reset age to a new just-now');
}

// Null numerics from Dex must paint '—', never $0.00. Number(null) === 0, so a
// Dex response with null price/marketCap once rendered $0.00 — which reads as
// a fact about the token and contradicts this page's own honesty tests.
{
  const elements = new Proxy({}, {
    get(store, id) {
      if (!store[id]) store[id] = {
        textContent: '',
        value: '',
        hidden: false,
        style: { removeProperty(name) { delete this[name]; } },
        listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
      };
      return store[id];
    },
  });
  const dom = {
    globalThis: null,
    document: { getElementById: id => elements[id], addEventListener() {}, visibilityState: 'visible' },
    navigator: {},
    URL,
    console,
    isFinite,
    AbortController,
    clearTimeout() {},
    setTimeout() { return 1; },
    setInterval() { return 1; },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        pairs: [{
          priceUsd: null,
          marketCap: null,
          liquidity: { usd: null },
          priceChange: { h24: null },
          dexId: 'test',
        }],
      }),
    }),
  };
  dom.globalThis = dom;
  vm.runInNewContext(src, dom, { filename: 'src/app.js' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    ['s-price', 's-mcap', 's-liq', 's-24h'].map(id => elements[id].textContent),
    ['—', '—', '—', '—'],
    'null Dex numerics painted a number instead of —'
  );
}

console.log('dasha-share.test.mjs: PASS (trust-reset)');

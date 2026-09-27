#!/usr/bin/env node
/**
 * dasha bounties — USDC Solana Pay, GitHub identity required, X optional via lobby.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBountiesEmbed } from './embed-build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);
const B = require('./board.js');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const seed = JSON.parse(read('config/bounties.seed.json'));
const feed = JSON.parse(read('bounties/feed.json'));
const rootFeed = JSON.parse(read('bounties.json'));
const html = readFileSync(join(here, 'index.html'), 'utf8');
const css = readFileSync(join(here, 'board.css'), 'utf8');
const js = readFileSync(join(here, 'board.js'), 'utf8');
const template = read('.github/ISSUE_TEMPLATE/bounty-project.yml');
const copy = html + css + js;

assert.ok(existsSync(join(here, 'index.html')));
assert.ok(existsSync(join(here, 'feed.json')));
assert.ok(existsSync(join(root, 'bounties.json')));
assert.ok(existsSync(join(root, 'config/bounties.seed.json')));
assert.match(html, /id="bb-form"/);
assert.match(html, /id="bb-item"/);
assert.match(html, /id="bb-payto"/);
assert.match(html, /id="bb-github"/);
assert.match(html, /id="bb-x"/);
assert.match(html, /bb-id-badge/);
assert.match(html, />optional</);
assert.match(html, /aria-label="X \(optional\)"/);
assert.match(css, /\.bb-id-badge/);
assert.doesNotMatch(copy, /GitHub soon/, 'the dead "GitHub soon" placeholder is gone everywhere');
assert.match(js, /live\.githubStatus/);
assert.match(js, /'Connect GitHub'/);
assert.match(js, /'GitHub unavailable'/);
assert.match(html, /href="https:\/\/lobby\.getdasha\.com\/oauth\/github\/start"/);
assert.match(html, /href="https:\/\/lobby\.getdasha\.com\/oauth\/x\/start"/);
assert.doesNotMatch(html, /href="https:\/\/www\.getdasha\.com\/studio"/);
assert.match(html, /href="https:\/\/www\.getdasha\.com\/lobby"/);
assert.match(html, /href="https:\/\/www\.getdasha\.com\/bounties"/);
assert.match(html, /href="https:\/\/www\.getdasha\.com\/how-to-buy"/);
assert.match(html, /href="https:\/\/x\.com\/dash_eats"/);
assert.match(html, /id="bb-payto"[^>]*required/);
assert.match(html, /id="bb-amount"[^>]*required/);
assert.doesNotMatch(html, /href="\/studio"/);
assert.doesNotMatch(html, /href="\/bounties\/"/);
assert.equal(B.githubCtaLabel(false), 'GitHub…', 'loading state before the lobby answers');
assert.equal(B.githubCtaLabel(true), 'Connect GitHub');
assert.equal(B.githubCtaLabel(false, { login: 'Uuriko' }), 'Uuriko');

// Live GitHub connect states come from the lobby /oauth/github/status endpoint,
// exercised through loadLobbyIdentity with a stubbed fetch.
{
  const configured = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(url.includes('github/status') ? { configured: true } : {}),
  });
  await B.loadLobbyIdentity(configured);
  assert.equal(B.githubCtaLabel(false), 'Connect GitHub', 'lobby says OAuth available');
}
{
  const down = async (url) => {
    if (url.includes('github/status')) throw new Error('lobby down');
    return { ok: true, status: 200, text: async () => '{}' };
  };
  await B.loadLobbyIdentity(down);
  assert.equal(B.githubCtaLabel(false), 'GitHub unavailable', 'lobby unreachable');
}
{
  const notConfigured = async () => ({ ok: true, status: 200, text: async () => '{}' });
  await B.loadLobbyIdentity(notConfigured);
  assert.equal(B.githubCtaLabel(false), 'GitHub unavailable', 'lobby says not configured');
}
{
  const withProfile = async (url) => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify(url.includes('github/status') ? { configured: true, github: { login: 'Uuriko' } } : {}),
  });
  const ident = await B.loadLobbyIdentity(withProfile);
  assert.equal(ident.github.login, 'Uuriko');
  assert.equal(B.githubCtaLabel(false, ident.github), 'Uuriko', 'connected profile wins');
}
assert.match(html, /We don't hold it\./);
assert.match(html, /rel="alternate"[^>]*feed\.json/);
assert.doesNotMatch(copy, /[1-9A-HJ-NP-Za-km-z]{32,44}pump/);
assert.doesNotMatch(html, /1% platform fee|signed compute|14-day wallet|potter@|hiring|10% fee/i);
assert.doesNotMatch(js, /merge_cap|issue_close|DEFAULT_SCORING|contributors\?per_page/);
assert.doesNotMatch(html, /first-timers welcome|simp board is different|payout policy|declared bounties, not escrow/i);
assert.doesNotMatch(html, /eligibility|potter@|10% fee|hiring/i);
assert.doesNotMatch(copy, /25 USD|50 USD|\$25|\$50/);
assert.match(template, /name: Bounty listing/);
assert.match(template, /bounty-project/);
assert.match(template, /id: listing/);
assert.match(template, /itemUrl/);
assert.match(template, /"currency": "USDC"/);
assert.match(template, /id: payTo[\s\S]*?label: Pay to[\s\S]*?required: true/);
assert.doesNotMatch(template, /"payTo":\s*""/);

assert.match(css, /--ink:\s*#070608/i);
assert.match(css, /--paper:\s*#f4eddb/i);
assert.match(css, /--acid:\s*#dfff00/i);
assert.match(css, /--hot:\s*#ff3b81/i);
assert.match(css, /--hot-deep:\s*#c21f5a/i);
assert.match(css, /--violet:\s*#7c4dff/i);
assert.match(css, /Arial,Helvetica/);
assert.match(css, /box-shadow:\s*4px 4px 0 var\(--hot\)/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /min-height:\s*44px/);
assert.match(css, /#bb-hunt:empty/);
assert.match(css, /\.bb-id-btn\{/);
assert.doesNotMatch(html, /<iframe/i);
assert.doesNotMatch(html, /dgnav/);

assert.equal(B.CURRENCY, 'USDC');
assert.equal(B.CHAIN, 'solana');
assert.equal(B.USDC_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
assert.equal(B.LOBBY_URL, 'https://lobby.getdasha.com');
assert.equal(B.X_OAUTH_START, 'https://lobby.getdasha.com/oauth/x/start');
assert.equal(B.X_OAUTH_WINDOW, 'dasha_x');
assert.equal(B.GITHUB_OAUTH_START, 'https://lobby.getdasha.com/oauth/github/start');
assert.equal(B.SIMP_ME, 'https://lobby.getdasha.com/simp/me');
assert.match(js, /dasha_x/);
assert.match(js, /oauth\/x\/start/);
assert.match(js, /simp\/me/);

const SYS = '11111111111111111111111111111111';
const PAYOUT = 'DwpCrg5qfCMW11a9FYFsAR9ZYQUYKNhfLdnzpci7sYgb';
const payUrl = B.solanaPayUrl(25, PAYOUT, 'docs');
assert.match(payUrl, new RegExp('^solana:' + PAYOUT + '\\?amount=25&spl-token=' + B.USDC_MINT + '&reference=[1-9A-HJ-NP-Za-km-z]{32,44}&label=docs$'));
assert.equal(B.solanaPayUrl(25, PAYOUT, 'docs'), payUrl);
assert.equal(B.solanaPayUrl(25, '', 'docs'), '');
assert.equal(B.solanaPayUrl(25, SYS, 'docs'), '');
assert.equal(B.solanaPayUrl('nope', PAYOUT, 'docs'), '');
assert.equal(
  B.phantomBrowseUrl(payUrl),
  'https://phantom.app/ul/browse/' + encodeURIComponent(payUrl),
);
assert.equal(B.normalizePayTo('solana:' + PAYOUT + '?amount=1'), PAYOUT);
assert.equal(B.normalizePayTo('solana:' + SYS + '?amount=1'), null);
assert.equal(B.normalizePayTo('https://example.com/' + PAYOUT), null);
assert.equal(B.normalizePayTo(''), null);
assert.equal(B.normalizePayTo(null), null);
assert.equal(B.canList({ payTo: PAYOUT }), true);
assert.equal(B.canList({ payTo: SYS }), false);
assert.equal(B.payClipboardText({ amount: 25 }), '25 USDC Solana');

const ident = B.identityFromLobbyMe({
  linked: true,
  x: { handle: 'dash_eats', display: '@dash_eats', href: 'https://x.com/dash_eats', avatar: 'https://pbs.twimg.com/x.jpg' },
  github: { login: 'Uuriko' },
});
assert.equal(ident.x.handle, 'dash_eats');
assert.equal(ident.github.login, 'Uuriko');
assert.equal(B.hasGitHub(ident), true);
assert.equal(B.canAct(ident), true);
assert.equal(B.canAct({ github: null, x: ident.x }), false);
assert.equal(B.hasGitHub(B.normalizeIdentity({})), false);
assert.equal(B.normalizeIdentity({ github: 'Uuriko' }).github.login, 'Uuriko');

const memId = { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = String(v); } };
assert.equal(B.saveIdentity({ github: 'Uuriko', x: 'dash_eats' }, memId), true);
assert.equal(B.loadIdentity(memId).github.login, 'Uuriko');
assert.equal(B.loadIdentity(memId).x.handle, 'dash_eats');

const gated = B.renderRow(
  B.normalizeListing({ itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8', amount: 25, currency: 'USDC', payTo: PAYOUT }),
  { github: null, x: null },
);
assert.match(gated, /aria-disabled="true"/);
assert.match(gated, />Pay</);
assert.match(gated, />Claim</);
const emptyPayTo = B.renderRow(
  B.normalizeListing({ itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8', amount: 25, currency: 'USDC', payTo: '' }),
  { github: { login: 'Uuriko' }, x: null },
);
assert.doesNotMatch(emptyPayTo, />Pay</);
assert.match(emptyPayTo, /bb-pay-na/);
const nullPayTo = B.renderRow(
  B.normalizeListing({ itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8', amount: 25, currency: 'USDC', payTo: null }),
  { github: { login: 'Uuriko' }, x: null },
);
assert.doesNotMatch(nullPayTo, />Pay</);
assert.match(nullPayTo, /bb-pay-na/);
const destListing = B.normalizeListing({ itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8', amount: 25, payTo: PAYOUT });
assert.equal(destListing.payTo, PAYOUT);
assert.notEqual(destListing.payoutStatus, 'not_implemented');
const liveRow = B.renderRow(
  B.normalizeListing({ itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8', amount: 25, payTo: PAYOUT }),
  { github: { login: 'Uuriko' }, x: null },
);
assert.doesNotMatch(liveRow, /aria-disabled="true"/);
assert.match(liveRow, /data-bb-pay="wallet"/);
assert.match(liveRow, /solana:/);

const fenced = B.listingFromIssue({
  number: 11,
  title: '[bounty] dasha desk',
  html_url: 'https://github.com/Uuriko/dasha-desk/issues/11',
  created_at: '2026-08-13T12:00:00Z',
  body: `hello
\`\`\`json
{
  "name": "dasha desk",
  "repo": "Uuriko/dasha-desk",
  "pool": { "amount": 50, "currency": "USD" },
  "github": "Uuriko",
  "payTo": ""
}
\`\`\`
`,
});
assert.equal(fenced, null, 'an issue with empty payTo must not become a listing');
const fundedFenced = B.listingFromIssue({
  number: 12,
  title: '[bounty] dasha desk',
  html_url: 'https://github.com/Uuriko/dasha-desk/issues/12',
  created_at: '2026-08-13T12:00:00Z',
  body: `\`\`\`json\n{"name":"dasha desk","repo":"Uuriko/dasha-desk","amount":50,"currency":"USDC","payTo":"${SYS}"}\n\`\`\`\n\n### Pay to\n\n${PAYOUT}`,
});
assert.equal(fundedFenced.name, 'dasha desk');
assert.equal(fundedFenced.repo, 'Uuriko/dasha-desk');
assert.equal(fundedFenced.kind, 'project');
assert.equal(fundedFenced.pool.amount, 50);
assert.equal(fundedFenced.currency, 'USDC');
assert.equal(fundedFenced.origin, 'issue');
assert.equal(fundedFenced.payTo, PAYOUT);
assert.ok(fundedFenced.createdAt);

const namedOnly = B.normalizeListing({ name: 'Zine', pays: 'A printed page' });
assert.equal(namedOnly.name, 'Zine');
assert.equal(namedOnly.kind, 'project');
assert.equal(namedOnly.repo, '');
assert.equal(namedOnly.pool, null);
assert.equal(B.formatPool(namedOnly.pool), 'undeclared');
assert.match(B.renderRules(namedOnly), /A printed page/);
assert.equal(B.normalizeListing({ title: 'Poster' }).name, 'Poster');

const fromUrl = B.normalizeListing({ name: 'desk', repo: 'https://github.com/Uuriko/dasha-desk.git' });
assert.equal(fromUrl.repo, 'Uuriko/dasha-desk');
assert.equal(fromUrl.kind, 'project');

const item = B.normalizeListing({
  itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8',
  amount: 25,
  currency: 'USD',
  createdAt: '2026-08-13T00:00:00.000Z',
});
assert.equal(item.kind, 'item');
assert.equal(item.repo, 'Uuriko/dasha-desk');
assert.equal(item.itemUrl, 'https://github.com/Uuriko/dasha-desk/issues/8');
assert.equal(item.amount, 25);
assert.equal(item.currency, 'USDC');
assert.equal(item.chain, 'solana');
assert.equal(item.tokenMint, B.USDC_MINT);
assert.match(item.name, /#8/);
assert.equal(B.formatAmount(item), '25 USDC');
assert.equal(B.parseGithubItem('Uuriko/dasha-desk#8').url, 'https://github.com/Uuriko/dasha-desk/issues/8');

assert.equal(B.normalizeListing({}), null);
assert.equal(B.normalizeListing({ repo: 'not a repo' }), null);
assert.equal(B.normalizeListing({ kind: 'item', itemUrl: 'https://example.com/not-github' }), null);
assert.equal(B.extractJsonObject('no json here'), null);
assert.equal(B.extractJsonObject('```json\n{not json}\n```'), null);

const parsed = B.listingsFromIssues([
  { number: 1, title: '[bounty] good', html_url: 'https://x/1', body: `\`\`\`json\n{"name":"Alpha","repo":"a/b","pool":{"amount":10,"currency":"USDC"},"payTo":"${PAYOUT}"}\n\`\`\`` },
  { number: 2, title: '[bounty] junk', html_url: 'https://x/2', body: 'I forgot the json' },
  { number: 3, title: '[bounty] empty', html_url: 'https://x/3', body: '{"repo":"nope"}' },
  { number: 4, title: 'not a listing', html_url: 'https://x/4', body: '```json\n{"name":"skip"}\n```' },
  { number: 5, title: '[bounty] pr', pull_request: { url: 'https://api.github.com' }, body: '```json\n{"name":"nope"}\n```' },
  { number: 6, title: 'Labeled', labels: [{ name: 'bounty-project' }], html_url: 'https://x/6', body: `\`\`\`json\n{"name":"Zed","payTo":"${PAYOUT}"}\n\`\`\`` },
  { number: 7, title: '[bounty] item', html_url: 'https://x/7', body: `\`\`\`json\n{"kind":"item","itemUrl":"https://github.com/a/b/issues/9","amount":5,"currency":"USD","payTo":"${PAYOUT}"}\n\`\`\`` },
]);
assert.deepEqual(
  parsed.map((row) => row.name),
  ['Alpha', 'Zed', 'a/b#9'],
);
assert.equal(B.formatPool(parsed[0].pool), '10 USDC');
assert.equal(parsed[2].kind, 'item');
assert.equal(parsed[2].itemUrl, 'https://github.com/a/b/issues/9');
assert.equal(parsed[2].currency, 'USDC');

const failedBoard = B.renderGlobalBoard({
  boardError: 'GitHub contributor fetch failed.',
  outcomes: [],
});
assert.match(failedBoard, /failed|unavailable|no ranks/i);
assert.doesNotMatch(failedBoard, /#1/);
assert.doesNotMatch(failedBoard, /\$50/);

const emptyBoard = B.renderOutcomes([]);
assert.equal(emptyBoard.includes(B.EMPTY_OUTCOMES), true);
assert.match(emptyBoard, /No accepted outcomes in this cycle yet\./);
assert.doesNotMatch(emptyBoard, /#1/);

assert.deepEqual(B.normalizeOutcomes([{ login: 'ada', url: 'https://github.com/ada' }]), []);
assert.equal(
  B.normalizeOutcomes([{ login: 'ada', url: 'https://github.com/Uuriko/dasha-desk/pull/19' }]).length,
  1,
);
const scoredRow = B.renderOutcomes([
  { login: 'ada', url: 'https://github.com/Uuriko/dasha-desk/pull/19', note: 'merged' },
]);
assert.match(scoredRow, /href="https:\/\/github\.com\/Uuriko\/dasha-desk\/pull\/19"/);
assert.match(scoredRow, /PR #19/);
assert.doesNotMatch(scoredRow, /Projected|Total paid/);

const seedListings = B.listingsFromSeed(seed);
const project = seedListings.find((row) => row.kind === 'project');
const itemSeed = seedListings.find((row) => row.kind === 'item');
const failCard = B.renderProjectCard(project);
assert.match(failCard, /Uuriko\/dasha-desk/);
assert.doesNotMatch(failCard, /#1/);
assert.match(failCard, /50/);
assert.match(failCard, /USDC/);
assert.doesNotMatch(failCard, /\$50|Merged pull requests|first-timers/i);

const hunt = B.renderHunt(seedListings);
assert.match(hunt, /25/);
assert.match(hunt, /USDC/);
assert.match(hunt, /issues\/8/);
assert.doesNotMatch(hunt, />Pay</);
assert.match(hunt, /bb-pay-na/);
assert.match(hunt, />Claim</);

const built = B.buildIssueUrl({
  kind: 'project',
  name: 'dasha desk',
  repo: 'Uuriko/dasha-desk',
  amount: '50',
  payTo: PAYOUT,
}, { github: { login: 'Uuriko' }, x: { handle: 'dash_eats' } });
assert.equal(built.ok, true);
const issueUrl = new URL(built.url);
assert.equal(issueUrl.pathname, '/Uuriko/dasha-desk/issues/new');
assert.equal(issueUrl.searchParams.get('template'), 'bounty-project.yml');
assert.equal(issueUrl.searchParams.get('payTo'), PAYOUT);
assert.match(issueUrl.searchParams.get('title'), /^\[bounty\]/);
const listing = JSON.parse(issueUrl.searchParams.get('listing'));
assert.equal(listing.name, 'dasha desk');
assert.equal(listing.repo, 'Uuriko/dasha-desk');
assert.equal(listing.kind, 'project');
assert.equal(listing.pool.amount, 50);
assert.equal(listing.currency, 'USDC');
assert.equal(listing.payTo, PAYOUT);
assert.equal(listing.github, 'Uuriko');
assert.equal(listing.x, 'dash_eats');
assert.ok(!listing.scoring);

assert.equal(B.buildIssueUrl({ kind: 'project', name: 'Zine' }).ok, false);
assert.equal(B.buildIssueUrl({ kind: 'item', itemUrl: 'https://example.com/nope' }).ok, false);
assert.equal(B.buildIssueUrl({ repo: 'nope' }).ok, false);
assert.equal(B.buildIssueUrl({}).ok, false);
assert.equal(
  B.buildIssueUrl({
    kind: 'item',
    itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8',
    amount: '25',
  }).ok,
  false,
);
assert.match(
  B.buildIssueUrl({
    kind: 'item',
    itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8',
    amount: '25',
  }).error,
  /pay to/i,
);
assert.equal(B.buildIssueUrl({
  kind: 'item',
  itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8',
  amount: '25',
  payTo: SYS,
}).ok, false);
assert.equal(
  B.buildIssueUrl({
    kind: 'item',
    itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8',
    payTo: SYS,
  }).ok,
  false,
);
assert.match(
  B.buildIssueUrl({
    kind: 'item',
    itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8',
    payTo: SYS,
  }).error,
  /USDC/i,
);

const itemForm = B.buildIssueUrl({
  kind: 'item',
  itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8',
  amount: '25',
  payTo: PAYOUT,
});
assert.equal(itemForm.ok, true);
const itemListing = JSON.parse(new URL(itemForm.url).searchParams.get('listing'));
assert.equal(itemListing.kind, 'item');
assert.equal(itemListing.itemUrl, 'https://github.com/Uuriko/dasha-desk/issues/8');
assert.equal(itemListing.amount, 25);
assert.equal(itemListing.currency, 'USDC');
assert.ok(!itemListing.pool);

assert.equal(seedListings.length, 2);
assert.equal(project.repo, 'Uuriko/dasha-desk');
assert.equal(project.origin, 'seed');
assert.equal(itemSeed.kind, 'item');
assert.equal(itemSeed.payTo, null);
assert.equal(itemSeed.payoutStatus, 'not_implemented');
assert.equal(project.payTo, null);
assert.equal(project.payoutStatus, 'not_implemented');
assert.equal(itemSeed.itemUrl, 'https://github.com/Uuriko/dasha-desk/issues/8');
assert.ok(!('contributors' in seed.listings[0]));
assert.ok(!('score' in seed.listings[0]));
assert.ok(!('scoring' in seed.listings[0]));
assert.deepEqual(seed.listings, feed.listings);
assert.deepEqual(feed, rootFeed);
assert.equal(feed.schema, 'dasha-bounties-feed/v1');
assert.equal(rootFeed.schema, 'dasha-bounties-feed/v1');
assert.equal(seed.schema, 'dasha-bounties-feed/v1');
assert.equal(B.FEED_SCHEMA, 'dasha-bounties-feed/v1');
assert.equal(feed.url, 'https://www.getdasha.com/bounties');
assert.equal(B.BOARD_URL, 'https://www.getdasha.com/bounties');
assert.doesNotMatch(feed.url, /\/$/);
assert.ok(Array.isArray(feed.listings));
assert.ok(!('items' in feed));
assert.match(html, /rel="canonical" href="https:\/\/www\.getdasha\.com\/bounties"/);
assert.doesNotMatch(html, /rel="canonical" href="https:\/\/www\.getdasha\.com\/bounties\/"/);
assert.match(html, /property="og:url" content="https:\/\/www\.getdasha\.com\/bounties"/);
assert.match(html, /https:\/\/www\.getdasha\.com\/bounties\.json/);
assert.match(html, /https:\/\/uuriko\.github\.io\/dasha-desk\/bounties\/feed\.json/);
assert.match(html, /https:\/\/uuriko\.github\.io\/dasha-desk\/bounties\.json/);
assert.match(html, /https:\/\/raw\.githubusercontent\.com\/Uuriko\/dasha-desk\/main\/bounties\/feed\.json/);
assert.doesNotMatch(html, /www\.getdasha\.com\/bounties\/feed\.json/);
assert.doesNotMatch(html, /href="\/bounties\.json"/);
assert.match(html, /schema: dasha-bounties-feed\/v1/);
const serializedFeed = B.toFeed([]);
assert.equal(serializedFeed.schema, 'dasha-bounties-feed/v1');
assert.equal(serializedFeed.url, 'https://www.getdasha.com/bounties');
assert.ok(Array.isArray(serializedFeed.listings));

function assertHonestPayTo(row) {
  assert.ok('payTo' in row);
  assert.notEqual(row.payTo, '');
  if (row.payTo == null) {
    assert.equal(row.payTo, null);
    assert.equal(row.payoutStatus, 'not_implemented');
  } else {
    assert.notEqual(row.payoutStatus, 'not_implemented');
  }
}

feed.listings.forEach((row) => {
  assert.ok('repo' in row);
  assert.ok('itemUrl' in row);
  assert.ok('amount' in row);
  assert.equal(row.currency, 'USDC');
  assert.equal(row.chain, 'solana');
  assertHonestPayTo(row);
  assert.equal(row.tokenMint, B.USDC_MINT);
  assert.ok('github' in row);
  assert.ok('x' in row);
  assert.ok('createdAt' in row);
});
const serialized = B.toFeed(seedListings);
assert.deepEqual(serialized.listings, [], 'unfunded seed rows must not enter a public feed');
serialized.listings.forEach((row) => {
  assert.ok('repo' in row);
  assert.ok('itemUrl' in row);
  assert.ok('amount' in row);
  assert.ok('currency' in row);
  assert.ok('chain' in row);
  assertHonestPayTo(row);
  assert.ok('tokenMint' in row);
  assert.ok('github' in row);
  assert.ok('x' in row);
  assert.ok('createdAt' in row);
});
assert.doesNotMatch(read('bounties.json'), /"payTo":\s*""/);
assert.doesNotMatch(read('bounties/feed.json'), /"payTo":\s*""/);
assert.doesNotMatch(read('config/bounties.seed.json'), /"payTo":\s*""/);
assert.doesNotMatch(JSON.stringify(serialized), /"payTo":""/);
assert.doesNotMatch(JSON.stringify(B.listingPayload(itemSeed)), /"payTo":""/);
const paidEntry = B.toFeedEntry(
  B.normalizeListing({ itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8', amount: 25, payTo: PAYOUT }),
);
assert.equal(paidEntry.payTo, PAYOUT);
assert.notEqual(paidEntry.payoutStatus, 'not_implemented');
assert.doesNotMatch(JSON.stringify(paidEntry), /"payTo":""/);
const paidPayload = B.listingPayload(
  B.normalizeListing({ itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8', amount: 25, payTo: PAYOUT }),
);
assert.equal(paidPayload.payTo, PAYOUT);
assert.notEqual(paidPayload.payoutStatus, 'not_implemented');
const fundedSerialized = B.toFeed([
  B.normalizeListing({ itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8', amount: 25, payTo: PAYOUT }),
]);
assert.equal(fundedSerialized.listings[0].itemUrl, 'https://github.com/Uuriko/dasha-desk/issues/8');
assert.ok(serialized.listings.every((row) => Array.isArray(row.outcomes)));
assert.ok(serialized.listings.every((row) => row.outcomes.every((o) => B.parseGithubProof(o.url))));

const mem = {
  data: {},
  getItem(k) { return this.data[k] || null; },
  setItem(k, v) { this.data[k] = String(v); },
};
assert.equal(B.saveLocal([namedOnly], mem), true);
assert.equal(B.loadLocal(mem)[0].name, 'Zine');
const token = B.encodeShare({ name: 'Poster', pays: 'A remix' });
const shared = B.decodeShare(token);
assert.equal(shared.name, 'Poster');
assert.equal(shared.pays, 'A remix');

assert.deepEqual(B.collectOutcomes(seedListings), []);

assert.match(html, /Home/);
assert.match(html, /Studio/);
assert.match(html, /Bounties/);
assert.match(html, /List a bounty/);
assert.doesNotMatch(html, /also on trydemigod\.com\/bounties/);
assert.doesNotMatch(html, /1% platform fee|signed compute|14-day wallet|potter@/i);

assert.deepEqual(B.EXTRA_SEED_URLS, [
  'https://raw.githubusercontent.com/Uuriko/demigod-site-cdn/main/bounties-feed.json',
  'https://cdn.jsdelivr.net/gh/Uuriko/demigod-site-cdn@main/bounties-feed.json',
]);
assert.ok(B.EXTRA_SEED_URLS.every((url) => !/trydemigod\.com/i.test(url)));
assert.doesNotMatch(js, /seedUrls[\s\S]{0,200}demigod-site-cdn/);
assert.doesNotMatch(js, /https:\/\/(?:www\.)?trydemigod\.com[^"'\s]*bounties-feed/i);

const demigodFeed = {
  name: 'demigod bounties',
  schema: 'dasha-bounties-feed/v1',
  url: 'https://trydemigod.com/bounties',
  listings: [
    {
      kind: 'item',
      name: 'docs: add CONTRIBUTING screenshot of GitHub web edit flow',
      repo: 'Uuriko/dasha-desk',
      itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8',
      amount: 25,
      currency: 'USD',
      createdAt: '2026-08-13T00:00:00.000Z',
      outcomes: [],
    },
    {
      kind: 'item',
      name: 'Demigod-only hunt',
      repo: 'Uuriko/demigod',
      itemUrl: 'https://github.com/Uuriko/demigod/issues/3',
      amount: 40,
      currency: 'USD',
      createdAt: '2026-08-13T00:00:00.000Z',
      outcomes: [],
    },
    {
      kind: 'project',
      name: 'dasha desk',
      repo: 'Uuriko/dasha-desk',
      itemUrl: null,
      amount: 50,
      currency: 'USD',
      outcomes: [{ login: 'bot', url: 'https://example.com/not-github', amount: 9999 }],
    },
    {
      kind: 'project',
      name: 'demigod',
      repo: 'Uuriko/demigod',
      itemUrl: null,
      amount: 10,
      currency: 'USD',
      createdAt: '2026-08-13T00:00:00.000Z',
      outcomes: [],
    },
    {},
    { kind: 'item', itemUrl: 'https://example.com/not-github' },
    { repo: 'not a repo' },
  ],
};

const demigodListings = B.listingsFromSeed(demigodFeed, 'demigod');
assert.deepEqual(
  demigodListings.map((row) => row.name),
  ['docs: add CONTRIBUTING screenshot of GitHub web edit flow', 'Demigod-only hunt', 'dasha desk', 'demigod'],
);
assert.ok(demigodListings.every((row) => row.origin === 'demigod'));
assert.deepEqual(
  demigodListings.find((row) => row.name === 'dasha desk').outcomes,
  [],
);
assert.ok(demigodListings.every((row) => row.outcomes.every((o) => B.parseGithubProof(o.url))));

const dashaOnly = B.listingsFromSeed(feed);
const fundedDasha = B.normalizeListing({
  itemUrl: 'https://github.com/Uuriko/dasha-desk/issues/8',
  amount: 25,
  payTo: PAYOUT,
}, { origin: 'seed' });
const merged = B.mergeListings(dashaOnly, demigodListings, [fundedDasha]);
assert.equal(merged.filter((row) => row.itemUrl === 'https://github.com/Uuriko/dasha-desk/issues/8').length, 1);
assert.equal(merged.length, 1);
assert.ok(!merged.some((row) => row.origin === 'demigod'));

const emptyRemote = B.mergeListings(dashaOnly, B.listingsFromSeed({ listings: [] }, 'demigod'));
assert.deepEqual(emptyRemote, []);

const mergedHunt = B.renderHunt(merged);
assert.match(mergedHunt, /issues\/8/);
assert.doesNotMatch(mergedHunt, /Demigod-only hunt/);
assert.doesNotMatch(mergedHunt, /hire|Studio work|10% fee|potter@/i);

const demigodCard = B.renderProjectCard(demigodListings.find((row) => row.name === 'demigod'));
assert.match(demigodCard, /data-origin="demigod"/);
assert.doesNotMatch(demigodCard, /hire/i);

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const EXTRA_FEED = 'https://example.test/demigod-feed.json';

function fakeBoardFetch(demigodBody, demigodStatus = 200) {
  return async (url) => {
    const u = String(url);
    if (u.includes('feed.json') && !u.includes('demigod-feed') && !u.includes('bounties-feed')) return jsonRes(feed);
    if (u.includes('api.github.com')) return jsonRes([]);
    if (u.includes('/oauth/github/status')) {
      return jsonRes({ configured: false, linked: false, github: null });
    }
    if (u.includes('/simp/me') || u.includes('/oauth/x/status')) {
      return jsonRes({ linked: false, enrolled: false, x: null, configured: true });
    }
    if (u.includes('demigod-feed.json') || u.includes('bounties-feed.json')) {
      if (demigodStatus >= 400) return { ok: false, status: demigodStatus, json: async () => ({}), text: async () => '' };
      return jsonRes(demigodBody);
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

const booted = await B.boot({
  fetchImpl: fakeBoardFetch(demigodFeed),
  seedUrl: './feed.json',
  extraSeedUrls: [EXTRA_FEED],
  storage: mem,
});
assert.deepEqual(booted.listings, [], 'unfunded remote, issue, and local rows must stay off the board');
assert.equal(B.canAct(booted.identity), false);
assert.equal(booted.githubConfigured, false);

const bootedGh = await B.boot({
  fetchImpl: fakeBoardFetch(demigodFeed),
  seedUrl: './feed.json',
  extraSeedUrls: [EXTRA_FEED],
  storage: mem,
  identity: { github: 'Uuriko' },
});
assert.equal(bootedGh.identity.github.login, 'Uuriko');
assert.equal(B.canAct(bootedGh.identity), true);

const fakeGhLive = async (url) => {
  const u = String(url);
  if (u.includes('/oauth/github/status')) return jsonRes({ configured: true, linked: false, github: null });
  return fakeBoardFetch(demigodFeed)(url);
};
const bootedGhLive = await B.boot({
  fetchImpl: fakeGhLive,
  seedUrl: './feed.json',
  extraSeedUrls: [EXTRA_FEED],
  storage: mem,
});
assert.equal(bootedGhLive.githubConfigured, true);
assert.equal(B.githubCtaLabel(bootedGhLive.githubConfigured), 'Connect GitHub');

const bootedEmpty = await B.boot({
  fetchImpl: fakeBoardFetch({ name: 'demigod bounties', listings: [] }),
  seedUrl: './feed.json',
  extraSeedUrls: [EXTRA_FEED],
  storage: mem,
});
assert.deepEqual(bootedEmpty.listings, []);

const bootedFail = await B.boot({
  fetchImpl: fakeBoardFetch(null, 500),
  seedUrl: './feed.json',
  extraSeedUrls: [EXTRA_FEED],
  storage: mem,
});
assert.deepEqual(bootedFail.listings, []);
assert.deepEqual(bootedFail.demigod, []);

const extraFailed = await B.listingsFromExtraUrls(
  async () => {
    throw new Error('network');
  },
  [EXTRA_FEED],
  'demigod',
);
assert.deepEqual(extraFailed, []);

const app = await buildBountiesEmbed();
assert.doesNotMatch(app, /<iframe/i);
assert.match(app, /We don't hold it\./);
assert.match(app, /--ink:#070608/);
assert.equal(read('bounties/app.html'), app, 'bounties/app.html is stale — run: node bounties/embed-build.mjs');

console.log('dasha-bounties: PASS');

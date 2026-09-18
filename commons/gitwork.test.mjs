import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isSolanaAddress,
  isCanonicalAmount,
  isIsoTime,
} from './schema.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

const docPath = join(root, 'docs/COMMONS-GITWORK.md');
const fixturePath = join(root, 'commons/fixtures/gitwork-funded.example.json');

// 1. Verify docs/COMMONS-GITWORK.md exists and adheres to trust boundary requirements
assert.ok(existsSync(docPath), 'docs/COMMONS-GITWORK.md must exist');
const doc = readFileSync(docPath, 'utf8');

assert.match(doc, /#164/, 'docs/COMMONS-GITWORK.md must reference issue #164');
assert.match(doc, /GitHub/i, 'docs/COMMONS-GITWORK.md must document GitHub trust boundary');
assert.match(doc, /GitWork/i, 'docs/COMMONS-GITWORK.md must document GitWork trust boundary');
assert.match(doc, /Solana/i, 'docs/COMMONS-GITWORK.md must document Solana trust boundary');
assert.match(doc, /EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/, 'docs/COMMONS-GITWORK.md must specify canonical Solana USDC mint');
assert.match(doc, /paid/i, 'docs/COMMONS-GITWORK.md must address paid event rules');
assert.match(doc, /cancel/i, 'docs/COMMONS-GITWORK.md must describe cancellation / refund rules');
assert.match(doc, /redact|privacy|private key/i, 'docs/COMMONS-GITWORK.md must mandate secret redaction');

// Ensure docs prohibit direct paid transition from GitWork state
assert.ok(
  /must (?:never|not) directly (?:become|trigger|emit|transition).*(?:paid)/i.test(doc),
  'docs/COMMONS-GITWORK.md must forbid automatic paid status from GitWork state',
);

// 2. Verify commons/fixtures/gitwork-funded.example.json exists and conforms to schema
assert.ok(existsSync(fixturePath), 'commons/fixtures/gitwork-funded.example.json must exist');
const fixtureRaw = readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureRaw);

assert.equal(fixture.provider, 'gitwork', 'fixture provider must be gitwork');
assert.equal(fixture.purpose, 'contributor_bounty', 'fixture purpose must be contributor_bounty');
assert.equal(
  fixture.githubIssue,
  'https://github.com/Uuriko/dasha-desk/issues/164',
  'fixture githubIssue must match issue #164 URL',
);
assert.ok(fixture.externalId && typeof fixture.externalId === 'string', 'fixture externalId must be present');
assert.equal(fixture.providerStatus, 'funded', 'fixture providerStatus must be funded');
assert.equal(fixture.chain, 'solana', 'fixture chain must be solana');
assert.equal(fixture.asset, 'USDC', 'fixture asset must be USDC');
assert.equal(
  fixture.mint,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'fixture mint must be canonical Solana USDC mint',
);
assert.ok(isSolanaAddress(fixture.mint), 'fixture mint must be a valid Solana address');
assert.ok(isCanonicalAmount(fixture.amount), 'fixture amount must be a valid canonical amount');
assert.ok(isIsoTime(fixture.observedAt), 'fixture observedAt must be a valid ISO 8601 timestamp');

// Validate funding signature is a valid Solana Base58 signature
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;
assert.ok(
  SIG_RE.test(fixture.fundingSignature),
  'fixture fundingSignature must be a valid Solana Base58 transaction signature',
);

// Verify no secrets or sensitive terms leaked into the fixture
const sensitivePatterns = [
  /private[_-]?key/i,
  /secret/i,
  /seed/i,
  /password/i,
  /token/i,
  /api[_-]?key/i,
  /bearer/i,
  /@gmail\.com/i,
];
for (const pat of sensitivePatterns) {
  assert.ok(!pat.test(fixtureRaw), `fixture must not contain sensitive token matching ${pat}`);
}

// 3. Verify trust boundary: GitWork providerStatus 'funded' must not equate to settlement 'paid'
assert.notEqual(
  fixture.providerStatus,
  'paid',
  'GitWork providerStatus must never be labeled paid before independent chain evidence',
);

console.log('commons-gitwork: PASS');

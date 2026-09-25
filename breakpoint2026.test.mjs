import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ticketGenerator = require('./src/ticketGenerator.js');

console.log('Testing breakpoint2026 ticket generation...');

const ticket = ticketGenerator.generateBreakpoint2026Ticket();

// Check structure
assert.strictEqual(typeof ticket.title, 'string', 'title should be a string');
assert.strictEqual(ticket.title, 'Breakpoint 2026', 'title should be Breakpoint 2026');

assert.strictEqual(typeof ticket.date, 'string', 'date should be a string');
assert.strictEqual(ticket.date, '2026-09-07', 'date should be 2026-09-07');

assert.strictEqual(typeof ticket.description, 'string', 'description should be a string');
assert.strictEqual(ticket.description, 'Ticket for Breakpoint 2026 bounty: machine-paid inference video', 'description mismatch');

assert.strictEqual(Array.isArray(ticket.requirements), true, 'requirements should be an array');
assert.strictEqual(ticket.requirements.length, 6, 'should have 6 requirements');
const expectedReqs = [
  "one original English X post expressing excitement for Breakpoint",
  "a clear Germany / Superteam Germany angle",
  "tag `@SolanaEvents` and `@SuperteamDE`",
  "quote-retweet the sponsor's announcement with a thoughtful comment",
  "submit both URLs through Superteam Earn",
  "video is favored"
];
for (let i = 0; i < expectedReqs.length; i++) {
  assert.strictEqual(ticket.requirements[i], expectedReqs[i], `requirement ${i} mismatch`);
}

assert.strictEqual(typeof ticket.reward, 'string', 'reward should be a string');
assert.strictEqual(ticket.reward, '$800 ticket code (not cash, no travel)', 'reward mismatch');

console.log('All tests passed!');

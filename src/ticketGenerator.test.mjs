#!/usr/bin/env node
/**
 * Test for ticketGenerator.js
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const ticketGenerator = './src/ticketGenerator.js';

const result = spawnSync('node', [ticketGenerator, '--event', 'breakpoint2026'], { encoding: 'utf8' });

if (result.error) {
  throw result.error;
}

assert.strictEqual(result.status, 0, `Expected exit code 0, got ${result.status}`);

const ticket = JSON.parse(result.stdout);

assert.strictEqual(ticket.title, 'Breakpoint 2026');
assert.strictEqual(ticket.date, '2026-09-07');
assert.strictEqual(ticket.description, 'Ticket for Breakpoint 2026 bounty: machine-paid inference video');
assert.deepStrictEqual(ticket.requirements, [
  "one original English X post expressing excitement for Breakpoint",
  "a clear Germany / Superteam Germany angle",
  "tag `@SolanaEvents` and `@SuperteamDE`",
  "quote-retweet the sponsor's announcement with a thoughtful comment",
  "submit both URLs through Superteam Earn",
  "video is favored"
]);
assert.strictEqual(ticket.reward, '$800 ticket code (not cash, no travel)');

console.log('ticketGenerator.test.mjs: PASS');
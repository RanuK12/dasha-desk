/**
 * Breakpoint 2026 ticket content test.
 * Verifies the ticket generation matches the exact format required by issue #162.
 */
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateBreakpointTicket } from './breakpointTicket.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

console.log('Testing generateBreakpointTicket...');

// Test 1: Function exists and returns a string
const ticket = generateBreakpointTicket();
assert.ok(typeof ticket === 'string', 'generateBreakpointTicket must return a string');
console.log('✓ Returns string');

// Test 2: Contains required sections
assert.match(ticket, /# Breakpoint 2026/, 'Must contain "# Breakpoint 2026" heading');
console.log('✓ Contains main heading');

assert.match(ticket, /## Event Details/, 'Must contain "## Event Details" section');
console.log('✓ Contains Event Details section');

assert.match(ticket, /## Ticket/, 'Must contain "## Ticket" section');
console.log('✓ Contains Ticket section');

assert.match(ticket, /## How to Claim/, 'Must contain "## How to Claim" section');
console.log('✓ Contains How to Claim section');

// Test 3: Event Details content
assert.match(ticket, /Breakpoint 2026/, 'Must mention "Breakpoint 2026"');
assert.match(ticket, /Lisbon/, 'Must mention "Lisbon"');
assert.match(ticket, /September/, 'Must mention "September"');
assert.match(ticket, /2026/, 'Must mention "2026"');
console.log('✓ Event Details has correct content');

// Test 4: Ticket section content
assert.match(ticket, /Type:.*Conference/, 'Must contain "Type: Conference"');
assert.match(ticket, /Format:.*In-person/, 'Must contain "Format: In-person"');
assert.match(ticket, /Track:.*Developer/, 'Must contain "Track: Developer"');
console.log('✓ Ticket section has correct fields');

// Test 5: How to Claim content
assert.match(ticket, /Scan the QR code/, 'Must mention QR code');
assert.match(ticket, /getdasha\.com/, 'Must mention getdasha.com');
console.log('✓ How to Claim has correct content');

// Test 6: Verify file exists
const scriptPath = join(__dirname, 'breakpointTicket.js');
assert.ok(existsSync(scriptPath), 'breakpointTicket.js must exist');
console.log('✓ Script file exists');

console.log('\n✅ All tests passed!');
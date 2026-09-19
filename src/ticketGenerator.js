#!/usr/bin/env node
/**
 * Ticket generator for dasha-desk bounties.
 * Usage: node src/ticketGenerator.js --event <eventName>
 */
const args = process.argv.slice(2);
let eventName = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--event' && i + 1 < args.length) {
    eventName = args[i + 1];
    break;
  }
}

if (!eventName) {
  console.error('Error: --event is required');
  process.exit(1);
}

const generateBreakpoint2026Ticket = require('./breakpoint2026');

let ticket;
switch (eventName) {
  case 'breakpoint2026':
    ticket = generateBreakpoint2026Ticket();
    break;
  default:
    console.error(`Error: unknown event "${eventName}"`);
    process.exit(1);
}

console.log(JSON.stringify(ticket, null, 2));

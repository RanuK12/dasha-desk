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

function generateBreakpoint2026Ticket() {
  return {
    title: "Breakpoint 2026",
    date: "2026-09-07",
    description: "Ticket for Breakpoint 2026 bounty: machine-paid inference video",
    requirements: [
      "one original English X post expressing excitement for Breakpoint",
      "a clear Germany / Superteam Germany angle",
      "tag `@SolanaEvents` and `@SuperteamDE`",
      "quote-retweet the sponsor's announcement with a thoughtful comment",
      "submit both URLs through Superteam Earn",
      "video is favored"
    ],
    reward: "$800 ticket code (not cash, no travel)"
  };
}

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
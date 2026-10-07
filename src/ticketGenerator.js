// src/ticketGenerator.js
// Generates ticket content for Breakpoint 2026 bounty

/**
 * Generate the Breakpoint 2026 ticket object.
 * @returns {{title:string, date:string, description:string, requirements:string[], reward:string}}
 */
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
      "video is favored: 1-3 minute original video showcasing machine-paid inference capabilities with clear technical demonstrations"
    ],
    reward: "$800 ticket code (not cash, no travel)"
  };
}

// If run directly, output JSON
if (require.main === module) {
  const event = process.argv[2];
  if (event === '--event' && process.argv[3] === 'breakpoint2026') {
    console.log(JSON.stringify(generateBreakpoint2026Ticket(), null, 2));
  } else {
    console.error('Usage: node src/ticketGenerator.js --event breakpoint2026');
    process.exit(1);
  }
}

module.exports = { generateBreakpoint2026Ticket };

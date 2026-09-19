// src/breakpoint2026.js
/**
 * Generate ticket content for Breakpoint 2026 bounty.
 * @returns {{title: string, date: string, description: string, requirements: string[], reward: string}}
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
      "video is favored"
    ],
    reward: "$800 ticket code (not cash, no travel)"
  };
}

module.exports = generateBreakpoint2026Ticket;
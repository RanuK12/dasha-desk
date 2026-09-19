/**
 * Generate Breakpoint 2026 ticket content.
 * @returns {string} The ticket content formatted as markdown for Breakpoint 2026 bounty.
 */
function generateBreakpointTicket() {
  return `# Breakpoint 2026

## Event Details
Breakpoint 2026 will take place in Lisbon, September 2026.
This is a premier Solana conference focusing on blockchain innovation.

## Ticket
Type: Conference
Format: In-person
Track: Developer

## How to Claim
Scan the QR code at getdasha.com to claim your ticket.
Follow the instructions on the Superteam Earn platform.

## Submission Materials
> What I'm excited to pressure-test at Breakpoint 2026: can Solana become the settlement layer for software agents buying variable-cost AI from independently operated hardware?
>
> I'm building the inference side with OCM. London is the chance to meet the x402, payments, local-AI and German builder communities working on the other half.
>
> \`@SolanaEvents\` \`@SuperteamDE\`

> Most people hear crypto and think another wallet or exchange. At Breakpoint, I'm excited about something stranger: software agents buying real services from machines.
>
> I'm building OCM, an open inference network that can route an OpenAI-compatible request to independently operated Macs running local models.
>
> Generating tokens is the easy part. The hard part is letting an agent authorize a spending cap, stream the work, and settle only what was actually delivered — without charging twice when a provider fails or a request is cancelled.
>
> I want to meet the Solana and German builder communities working on x402, stablecoin settlement, local AI, and machine-to-machine commerce. \`@SolanaEvents\` \`@SuperteamDE\` — London is where I want to pressure-test this with the people building the rails.

> The part I care about is not "AI + crypto" as a slogan. It is the ugly failure boundary: a variable-cost stream, provider failover, cancellation, and exactly one final charge. Looking forward to comparing notes with \`@SuperteamDE\` builders at Breakpoint.

> A founder/builder view of Breakpoint centered on one concrete Solana problem: settling actual delivered inference usage across independently operated compute. The video connects OCM's working Apple-Silicon inference path with the x402 and stablecoin builders I hope to meet in London, while explicitly including the Superteam Germany community angle.

- Record vertically, ideally 1080×1920, with clear audio and captions.
- Verify every terminal/browser frame is scrubbed.
- Publish the original X post with both required tags.
- Open the listing and use its linked sponsor announcement for the required QRT.
- Submit both public URLs through Superteam Earn before Sep 7 21:59 UTC.
- Keep both posts public until winner announcement on Sep 14.
- Record the submission URL/time here.

Winning provides a ticket code, not cash or travel reimbursement. Do not book nonrefundable travel based only on this bounty. Do not state that OCM payments or provider payouts are already live; the settlement model remains a conformance/design track until reproducibly demonstrated.
`;
}

module.exports = { generateBreakpointTicket };
# Commons GitWork Canary: Trust Boundaries & External Receipt

This document specifies the trust boundary, verification model, and external receipt fixture for GitWork-funded Dasha Commons bounties, piloted via issue [#164](https://github.com/Uuriko/dasha-desk/issues/164).

## Trust Boundaries

Commons separates evidence from GitHub, GitWork, and the Solana blockchain into distinct trust domains:

| Layer | Canonical Evidence | Trust Scope | Boundary / Prohibited Inferences |
| --- | --- | --- | --- |
| **GitHub** | Issues, PRs, commit history, merge commits | Issue lifecycle, task requirements, pull request review, merge status | GitHub merge is contributor acceptance evidence, but **not** payment execution proof |
| **GitWork** | GitHub App events, bot comments, GitWork UI / API | Bounty registration, declared amount, escrow wallet allocation, claim routing | GitWork UI or bot label is **not** canonical chain truth; a GitWork status must **never** directly trigger a Commons `paid` event |
| **Solana** | On-chain transactions, slot confirmations, token balances | Canonical proof of escrow deposit and contributor payout transfer | On-chain transfers prove balance movement, but **not** contributor task acceptance |

### Core Safety Rules

1. **No Automatic `paid` Events from Platform State**: A GitWork label (`gitwork:usdc:<amount>`), bot confirmation comment, or UI claim status must never directly transition a Commons bounty or settlement stage to `paid`. Transition to `paid` requires independent on-chain transaction observation (`commons.tx/v1`).
2. **Canonical USDC Mint Verification**: All USDC bounties must strictly use the canonical Solana USDC mint:
   `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
   The mint must be verified directly against the funded on-chain transaction; it must never be inferred from the `USDC` ticker symbol alone.
3. **Redaction & Privacy Protection**: No wallet private keys, mnemonic seed phrases, API tokens, contributor email addresses, IP addresses, or private GitWork request/response payloads may enter repository files, fixtures, or pull requests.
4. **Independent Payout Reconciliation**: Contributor payout must be confirmed by an independent Solana RPC observation verifying transaction signature, slot, commitment (`confirmed` or `finalized`), destination address, token mint, and exact integer base units before Commons emits a `paid` event.

## GitWork Canary Lifecycle (Alpha)

GitWork is currently in alpha. Its public Terms specify that a bounty can be cancelled by removing the bounty label prior to merge, triggering a refund of escrowed funds. Merging a resolving PR activates the contributor payout claim path. Document only behavior observed in this canary; do not generalize undocumented platform guarantees.

### 1. Bounty Declaration & Escrow Setup
- The maintainer installs and authorizes the GitWork GitHub App (`gitwork-io`) scoped strictly to the repository.
- The maintainer applies a bounty label to the GitHub issue (format: `gitwork:usdc:<amount>`, e.g., `gitwork:usdc:25`).
- The GitWork bot responds on GitHub with the designated Solana escrow wallet address for the bounty.
- In Commons, the bounty is `declared` / `funding_pending`, not `funded`.

### 2. Escrow Funding
- The maintainer executes a transfer of the exact declared USDC amount to the GitWork escrow wallet on Solana.
- The Solana transaction signature provides independent on-chain evidence of funding.
- GitWork monitors the escrow wallet and confirms deposit (`providerStatus: "funded"`).
- Commons records the funded state using a public sanitized receipt fixture (`commons/fixtures/gitwork-funded.example.json`).

### 3. Contribution & Review
- A contributor forks the repository, develops the fix on a dedicated branch, and opens a pull request referencing the bounty issue (`Fixes #164`).
- Automated continuous integration and repository test suites must pass completely before review.

### 4. Cancellation & Refund Policy
- Before a PR is merged, the maintainer may cancel the bounty by removing the `gitwork:` label.
- Funds deposited in escrow are refunded to the maintainer per GitWork terms.
- Commons treats cancellation as `refund_pending` until the on-chain refund transaction is verified on Solana.

### 5. Merge & Contributor Claim
- Maintainer reviews and merges the resolving pull request on GitHub.
- Merging serves as the repository's acceptance of the contribution.
- GitWork detects the merge webhook, closes the bounty for new solutions, and posts a contributor claim link.
- The contributor authenticates via GitHub OAuth on GitWork and provides their Solana receiving wallet address.
- GitWork executes the payout transfer on Solana from the escrow wallet.

### 6. Settlement Reconciliation (Commons Verification)
- Merging the PR does **not** call the payout complete.
- Maintainer or automated observer independently inspects the Solana payout transaction:
  - Validates transaction status: `confirmed` or `finalized` on Solana mainnet-beta.
  - Validates SPL token mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
  - Validates recipient: exactly matches the accepted contributor's Solana wallet address.
  - Validates amount: exact base units (e.g. `25000000` for 25 USDC).
- Only upon complete reconciliation against independent Solana chain evidence is the Commons settlement marked `paid`.

## Machine-Readable Receipt Fixture

Sanitized public canary identifiers are maintained at `commons/fixtures/gitwork-funded.example.json`.

Required fields:
- `schema`: `"commons.external-receipt/v1"`
- `provider`: `"gitwork"`
- `purpose`: `"contributor_bounty"`
- `githubIssue`: `"https://github.com/Uuriko/dasha-desk/issues/164"`
- `externalId`: GitWork bounty identifier (`"gitwork-5351093923"`)
- `providerStatus`: `"funded"`
- `chain`: `"solana"`
- `asset`: `"USDC"`
- `mint`: `"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"`
- `amount`: Canonical decimal amount string (e.g. `"25"`)
- `fundingSignature`: 64-128 character base58 Solana transaction signature
- `observedAt`: ISO 8601 timestamp string

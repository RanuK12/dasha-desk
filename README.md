# dasha

OSS Compute kit for `$dasha`. Live `/compute` cold start is **Start.** — **Ask** / **Provide**, quiet **Pay** / **Credits** (USDC or `$dasha`, no card). Gate **Sign in** / **You**. Provide: **Prefer MLX**. This repo is not the Worker.

## Use it live (no clone)

**[Start. ↗](https://www.getdasha.com/compute)** ·
[Host guide](https://www.getdasha.com/compute/ocm/provider) ·
[Marketplace](https://www.getdasha.com/compute/ocm) ·
[getdasha.com](https://www.getdasha.com)

**60 seconds:** open [Start.](https://www.getdasha.com/compute) → **Ask** or **Provide**. Gate **Sign in** / **You**. After Ask, Hosted **Run**. You do not need this repo.

Also on www: [How to buy](https://www.getdasha.com/how-to-buy) ·
[Lobby](https://www.getdasha.com/lobby) ·
[Simp](https://www.getdasha.com/simp) ·
[Bounties](https://www.getdasha.com/bounties) ·
[Privacy](https://www.getdasha.com/privacy)

## $DASHA token

[![CoinGecko](https://img.shields.io/badge/CoinGecko-dash__eats-8BC34A?logo=coingecko&logoColor=white)](https://www.coingecko.com/en/coins/dash_eats)

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/www-getdasha-com-compute-mcp-json)

`$dasha` / dash_eats on Solana. Mint `53uxQtB9pcjWvCHguz3JTTndvuKqGxhrD37EetnCpump`. [CoinGecko](https://www.coingecko.com/en/coins/dash_eats) · [Dexscreener](https://dexscreener.com/solana/9KkDpvUQRqXjiuyMFcy1CwqrxLwDcGGUR2Cap2Qt7bU7) · [GeckoTerminal](https://www.geckoterminal.com/solana/pools/9KkDpvUQRqXjiuyMFcy1CwqrxLwDcGGUR2Cap2Qt7bU7) · [Buy on Jupiter](https://jup.ag/tokens/53uxQtB9pcjWvCHguz3JTTndvuKqGxhrD37EetnCpump)

## Worker-first getdasha.com

This is **Worker-first getdasha.com**, the same product as the static desk files already here — one `$dasha` / dash_eats site, not a second coin.

Live [www.getdasha.com](https://www.getdasha.com/) is owned by Cloudflare Worker **dasha-lobby** (www + lobby routes). Source ships from the operator Worker tree. This repo is pastes, docs, Watch, and the community Compute kit. **Do not invent a Worker here. Do not wrangler-deploy from here. Do not Designer-publish.**

Route map: [`docs/ROUTES.md`](docs/ROUTES.md). Live www vs experimental kits in this tree: [`docs/STATUS.md`](docs/STATUS.md). Watch: `node watch.mjs` (production) or `node watch.mjs --fixture` (local).

`/dasha` and `/desk` 308 to `/how-to-buy`. `/studio` is retired (308 home). Do not restore Meme Studio on www.

## What lives here

Cold `/compute`: [`docs/COMPUTE.md`](docs/COMPUTE.md) (**Start.** Ask / Provide; USDC credits; Prefer MLX).

| Path | Job |
| --- | --- |
| [`compute/`](compute/) | Community **open-alpha kit** (lobby coordinator): local coordinator, outbound macOS/Ollama provider, console states, protocol tests, security policy, threat model. Browseable MIT source for the product at [getdasha.com/compute](https://www.getdasha.com/compute). |
| [`ocm/`](ocm/) | **Open Compute Marketplace** (Graham). On `main` (MIT). Landed through [PR #76](https://github.com/Uuriko/dasha-desk/pull/76) + [PR #131](https://github.com/Uuriko/dasha-desk/pull/131). Do not merge raw [#44](https://github.com/Uuriko/dasha-desk/pull/44); #44 was closed, not merged. Host docs live: [compute/ocm/provider](https://www.getdasha.com/compute/ocm/provider). Marketplace: [compute/ocm](https://www.getdasha.com/compute/ocm). |
| Cloudflare Worker | Live www + lobby + Compute **Start.** **Not cloned from this repo.** |

Compute is experimental. Provider operators can read prompts. Do not send secrets.

## Start contributing (open-source project)

This is **code and docs contribution** to the public MIT repo — not a payment, bag check, or paid program. Open a pull request and you are a project contributor. No invite. **Maintainer:** [@Uuriko](https://github.com/Uuriko).

**From getdasha.com:** the homepage **Contribute code ↗** button lands on [good first issues](https://github.com/Uuriko/dasha-desk/contribute).

**Fastest path (no clone):**

1. Open **[good first issues](https://github.com/Uuriko/dasha-desk/contribute)** (GitHub’s `/contribute` page). Prefer Compute + docs.
2. Or fix a typo in the browser: open a file → pencil → **Propose changes** → PR.
3. Full guide: [CONTRIBUTING.md](CONTRIBUTING.md) (we aim to first-reply within **7 days**).

Also: [Ideas welcome (#7)](https://github.com/Uuriko/dasha-desk/issues/7) · [Discussions](https://github.com/Uuriko/dasha-desk/discussions) · [open an idea or bug](https://github.com/Uuriko/dasha-desk/issues/new/choose) · [ROADMAP.md](docs/ROADMAP.md)

A prepared lane can recognize qualifying merged pull requests on the public
[Simp Board](https://www.getdasha.com/simp) once it is activated. It is inactive today, so no current
PR earns points. The maintainer will apply the PR's `impact:` label; contributors need no label
permissions. [How that works](CONTRIBUTING.md#prepared-simp-points-lane). Points are recognition on a
page, not payment or a token allocation. You never need points to open a PR.

CI runs the complete build, mint, share, docs, Watch-fixture, browser-resilience, and Compute protocol gates on every PR.

## Desk, bounties, Studio (not the on-ramp)

**the desk** (this directory) — check the mint against independent explorers, then one neutral
Jupiter route. Local / GitHub Pages copy. Not a live www pretty URL.

**[bounties/](bounties/)** — USDC bounties on Solana. GitHub connect is coming (lobby
`/oauth/github/status` is `configured: false` until worker secrets exist); listings still
open as GitHub issues. X is optional (same lobby session as Simp Board). Canonical feed:
[www.getdasha.com/bounties.json](https://www.getdasha.com/bounties.json)
([Pages](https://uuriko.github.io/dasha-desk/bounties.json),
[feed.json](https://uuriko.github.io/dasha-desk/bounties/feed.json),
[raw GitHub](https://raw.githubusercontent.com/Uuriko/dasha-desk/main/bounties/feed.json)).
We don't hold it.

**[studio/](studio/)** — local / Pages Meme Studio only. www `/studio` 308s home.
Original drawings are public domain. Uploaded or externally sourced images keep their own rights.

None of the static tools here connects a wallet or moves anything.

[GitHub Pages demo](https://uuriko.github.io/dasha-desk/) · [Website](https://www.getdasha.com)

![Dasha desk — mint, sources, buy rails](assets/desk-demo.gif)

## What the desk does

- keeps the associated mint visible and easy to copy
- checks pasted addresses against that mint
- remembers **last check on this device** (local only) and warns if the mint string changes
- shows public market data with clear offline fallbacks
- links explorers, chart, and one neutral Jupiter route
- ships as static HTML, CSS, and JavaScript (no wallet connect)

**Roadmap is community input** — open an issue and propose what to build next (infra, consumer, creative). Compute + docs are the OSS on-ramp. Adding a Studio look is still a self-contained *local* change ([studio/README.md](studio/README.md)); that does not put Studio back on www.

## Run it locally

```bash
git clone https://github.com/Uuriko/dasha-desk.git
cd dasha-desk
python3 -m http.server 8766
# → http://127.0.0.1:8766/           desk (GitHub Pages root)
# → http://127.0.0.1:8766/home/
# → http://127.0.0.1:8766/lobby/
# → http://127.0.0.1:8766/bounties/
# → http://127.0.0.1:8766/privacy/
# → http://127.0.0.1:8766/compute/   open-alpha kit
# → http://127.0.0.1:8766/studio/    local only
```

Production buy path is `/how-to-buy`. `/desk` and `/dasha` go to `/how-to-buy`.

After changing sources:

```bash
node build.mjs --write
npm ci
npm test
```

The site itself has no install step or runtime dependencies. Tests use one development-only package
and an installed Chrome/Chromium browser so the failure paths run in a real page.

Runtime sources: [`src/body.html`](src/body.html) · [`src/styles.css`](src/styles.css) · [`src/app.js`](src/app.js) · [`config/dasha.json`](config/dasha.json) · [`bounties/`](bounties/) · [`compute/`](compute/) · [`ocm/`](ocm/) · [`studio/`](studio/)

`src/app.html`, `index.html`, and `dist/index.html` are **generated** — do not edit by hand.

## Trust

No wallet, no custody, no price promises. Third-party data can fail; mint and source paths stay usable. Association with public culture is **not endorsement**.

[MIT](LICENSE) for code · [asset attribution](assets/ATTRIBUTION.md) for media · [Code of conduct](CODE_OF_CONDUCT.md)

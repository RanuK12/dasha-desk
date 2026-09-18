# Checked-in tarball & binary bloat inventory (task #32)

Research pass, 2026-09-17. Method: `git rev-list --objects --all | git cat-file
--batch-check` (all history) plus `git ls-tree -r -l HEAD` (current tree), cross-checked
against in-repo references (`git grep`) and the CI workflow that maintains the archive.

Baseline: `origin/main` @ `3a03cd0`. `.git` pack is 1.13 MiB total.

## Headline numbers

| Scope | Bytes |
|---|---|
| Offender set in the current tree (13 files ≥ 100 KB + 1 binary fixture) | 1,776,378 (~1.69 MiB) |
| Historical duplicates in the pack (6 tarball versions, see below) | 964,811 (~942 KB) |
| Combined tree + history footprint of these items | ~2.6 MiB |

## Offender table

| # | Path (at HEAD) | Bytes | Why it is checked in | Referenced by | Needed at runtime? | Remediation | Reclaimable now |
|---|---|---|---|---|---|---|---|
| 1 | `artifacts/dasha-compute/dasha-compute-open-alpha.tar.gz` | 198,182 | CI commits it back to main on every push touching `compute/` — it is the edge-Worker download + provenance archive | `.github/workflows/compute-release.yml`, `compute/PROVENANCE.md`, `compute/README.md`, `docs/COMPUTE.md`, `docs/DEPLOY.md`, `watch-compute-release.mjs` | Yes — served as the download artifact | Long-term: serve from GitHub Release assets (task #40, needs John's release tap), then stop CI-committing it to main | 0 (live-served) |
| 2 | `studio/embed-0913c69d316e.js`, `embed-2315460c555a.js`, `embed-67e8ee8a16e8.js`, `embed-d4828c259709.js`, `embed-ef1c8a399e5f.js` | 587,951 combined | Superseded fingerprinted publish snapshots of the studio embed; all unreferenced in-repo | Nothing references them (only `embed-f585862e4a23.js` is referenced) | Served live on GitHub Pages — external adopter pages may still embed old hashes | Adopt a fingerprint-retention policy (keep current + 1 previous); delete the 5 stale ones only after an adopter-reference audit | 574 KB *pending audit* |
| 3 | `studio/embed.js` + `studio/embed-f585862e4a23.js` | 129,431 each, byte-identical | Moving URL (copy-paste snippet target; `studio.test.mjs` reads it) vs fingerprinted SRI-pinned URL (README + `loader.html`) | `studio/README.md`, `studio/loader.html`, `studio/studio.test.mjs` | Yes — both URLs are live on Pages | Intentional duplication — keep both | 0 |
| 4 | `studio/index.html` (130,701) + `studio/embed.html` (129,835) | 260,536 | Canonical Studio source + generated fragment (`embed-build.mjs`; `studio.test.mjs` fails closed on hand edits) | `studio/embed-build.mjs`, `studio/studio.test.mjs` | Yes — source and generated artifact | Keep | 0 |
| 5 | `assets/github-web-edit.png` | 365,676 | README / CONTRIBUTING screenshot | `README.md`, `CONTRIBUTING.md`, `assets/ATTRIBUTION.md`, `dasha-oss-docs.test.mjs` | Yes — docs asset | Lossless recompress (`optipng`/`pngcrush`) or downscale; est. 30–50% saving | ~110–180 KB *after tooling pass* |
| 6 | `assets/desk-demo.gif` | 105,144 | README demo gif | `README.md` (+ATTRIBUTION) | Yes — docs asset | Convert to muted-loop MP4/WebM for README (~90% smaller); follow-up | ~90 KB *after conversion* |
| 7 | `fixtures/watch/compute-archive.bin` | 27 | Test fixture for the release-watch harness | `watch-compute-release.mjs`, `watch.test.mjs`, `fixtures/watch/compute-archive.sha256` | Yes — test runtime | Keep | 0 |

## History bloat (not removable without a rewrite)

Six versions of the release tarball live in the pack — 198,182 / 163,361 / 163,361 /
147,489 / 146,465 / 145,953 bytes = 964,811 bytes total. The pack itself is 1.13 MiB,
so **historical tarballs are ~83% of the entire `.git` pack**. This is the growth
vector: CI rewrites the archive on every `compute/` push, so each push adds ~200 KB of
uncompressible history. **Do not `filter-repo` this on a shared repo** — destructive,
invalidates every clone's history, payoff is < 1 MB. The fix is item 1 above (stop
checking the archive into main; serve it from Release assets).

## Remediation plan (priority order)

1. **Keep-in-repo, shrink:** lossless recompress `github-web-edit.png` (~110–180 KB
   est.), convert `desk-demo.gif` to video (~90 KB est.). No behavior change.
2. **Policy + audit:** keep current studio fingerprint + 1 previous; after an
   adopter-reference audit, delete the 5 stale fingerprints (~574 KB).
3. **Migrate the download artifact:** once task #40's GitHub Release exists (John's
   tap), point the edge Worker + docs at Release assets, have CI upload instead of
   committing, and untrack `artifacts/dasha-compute/` (~198 KB + ends ~200 KB/push
   history growth). `fixtures/watch/` keeps working via `release.json`/sha256 pointers.
4. **Explicitly not doing:** history rewrite (destructive, < 1 MB payoff).

## Deletion decision for this PR

**Nothing deleted.** The only stale-looking items (superseded studio fingerprints,
historical tarballs) are either live-served on GitHub Pages or require a history
rewrite — neither meets the bar of "provably regenerable or stale" without breaking
external consumers. Inventory + plan, per task preference.

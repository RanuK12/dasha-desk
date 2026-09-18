# Compute release provenance

Release tarballs are **no longer committed to git**. They are built
deterministically by `.github/workflows/compute-release.yml` on every main push
touching `compute/` and published as:

- **GitHub Release assets** — tag `compute-<short-sha>` on `Uuriko/dasha-desk`,
  e.g. `https://github.com/Uuriko/dasha-desk/releases/tag/compute-01e0625`
- **Workflow artifacts** — `dasha-compute-open-alpha-<sha>` (30-day retention)
- **SLSA provenance** — attached to the tarball via `actions/attest`

Verify a download: `sha256sum --check dasha-compute-open-alpha.tar.gz.sha256`.
Build inputs are pinned in `compute/dist/release.json` (an asset of the same
release). Full provenance narrative: `compute/PROVENANCE.md`.

> Edge-Worker note: this directory no longer hosts a tarball for the worker to
> download. The worker's download URL must move to the release-asset URL above.
> That config lives outside this repo — update it before relying on a fresh build.

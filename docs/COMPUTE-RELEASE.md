# Promote a Compute kit

The Compute release workflow tests and builds an archive, checks its checksum, and retains the candidate for 30 days. Main pushes also attest the archive. It does not push directly to protected main or deploy the public download.

1. Merge reviewed source changes and select the successful **main-branch** Compute release run for that exact commit. A pull-request artifact is a candidate, not a production release. Record the run URL and source commit in the promotion PR.
2. Download that run's artifact with `gh run download RUN_ID --repo Uuriko/dasha-desk --name dasha-compute-open-alpha-SOURCE_SHA --dir /tmp/dasha-kit-release`. Use an empty destination. Do not mix files from different runs.
3. In an isolated branch based on current main, copy only `dasha-compute-open-alpha.tar.gz`, `dasha-compute-open-alpha.tar.gz.sha256`, and `release.json` into `artifacts/dasha-compute/`.
4. Verify the archive SHA-256 against both the sidecar and manifest, and its byte count against the manifest. Inspect the archive contents and confirm the intended changes. Include the archive digest in the PR. Run `npm test` and obtain review and required checks before merging.
5. The release owner then promotes the verified archive through the existing dasha-lobby download route. The lobby sync helper can stage the three files, but uploading a partial assets directory would delete unrelated live assets. Preserve the entire current asset set or use a separately reviewed immutable download route. Update `/compute/kit.json` in the same release.
6. After deployment, download the public archive and verify its exact digest and byte count, the sidecar, `/compute/release.json`, and `/compute/kit.json`. Test the installed CLI from that downloaded archive before declaring the release live.

Public URL: https://www.getdasha.com/dasha-compute-open-alpha.tar.gz.

The GitHub Pages mirror is deployed separately. Changes to site paste files do not update the Worker-owned www site. See [DEPLOY.md](DEPLOY.md).

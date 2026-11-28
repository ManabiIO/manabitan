# Preserved VNDB path-projection component evidence

This bundle preserves the complete fixed component experiment that finished on 2026-11-28 at 04:32:13.502 UTC. It contains all 3,060 original group observations, the original prospective plan and source receipts, the independent audit, the exact loaded probe source, and small reproduction scripts. Packaging and saved-data verification perform no timing or import work.

The result is a projection-only component gain. The candidate saved a median 83.101 ms of process CPU per complete VNDB corpus versus unchanged arm A and 77.940 ms versus unchanged arm C. Median paired CPU changes were −25.47% and −24.46%; wall-interval changes were −30.92% and −32.06%. Both comparisons won all six blocks. Identical C/A controls changed +1.92% CPU and +2.28% wall, within the prospective 5% bound. Every original correctness, identity, relative, absolute and control gate passed. See `SUMMARY.md` for scope, counts, complete paired statistics, and separate incomplete follow-up attempts.

These are sums of helper-call intervals across 170 groups, each with eight repetitions. They are not elapsed import times. The original local runtime was Node 24.22.3. This evidence does not establish browser import, enclosing-copy, memory, or JMdict gains and does not qualify a PR on its own.

## Contents and identities

- `component-result.json.gz` decompresses to the exact original 708,980-byte report, SHA-256 `294fdad7cd4e052737597cc422f2d6ee0527cc48f5f067d58f5e56e2efe87c34`. Every observation and gate remains present.
- `frozen-inputs.json`, `benchmark-plan.md`, and `independent-audit.json` are byte-for-byte copies of the original files.
- `fixture-manifest.json.gz` preserves all 170 group identities, complete input/output digests and source counts. Its uncompressed SHA-256 is `810c067eabf70271a5440775751420ce065e3bfc1ce2a47bfd2cb61c4876a8a2`.
- `baseline-planner-census.json.gz` preserves the independently completed planner census used by the capture's group oracle. Its uncompressed SHA-256 is `1edb466e299e8e8532cf3991beab83383112e64df1288366f63fdfea9d4ea64b`.
- `loaded-probes.tar.gz` preserves the exact A/B/C projection probe modules and capture observer. The verifier checks every archived source against the frozen receipts without extracting or executing it.
- `reproduction/path-component.mjs` and `reproduction/capture-worker.mjs` are the original unchanged driver and transport/capture helper. `REPRODUCE.md` explains their inputs and fresh-directory requirements.
- `manifest.json` lists every bundled file's size and SHA-256, including compressed and uncompressed identities. It does not list itself.

The 7,077,646 bytes of raw compressed projection fixtures are deliberately omitted. Their per-group compressed/uncompressed hashes are retained in the fixture manifest; the locked source archive and original capture code can reproduce their semantic contents. New capture container bytes and native addresses are not presumed identical. The known archive is VNDB 291,705,969 bytes, SHA-256 `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`. No omitted raw fixture is required to recompute the published arithmetic or verify the bundled identities.

## Verify without rerunning the experiment

Run `python3 verify-evidence.py` from any directory, using this script's path. It checks all file hashes, exact decompressed identities, every original observation's unique group/block/arm position, all 54 aggregate timing metrics, paired comparisons, all four prospective gates, and the archived probe identities. It reads saved data only and prints one JSON receipt.

Absolute paths inside original receipts are historical source provenance. They are retained unmodified and are not followed by the saved-data verifier. No new observation replaces or augments the original cohort.

`SUMMARY.md` also records subsequent incomplete enclosing-copy attempts for context. Their separately retained raw partial receipts, helper archives and hosted correctness package are outside this projection-only evidence bundle; they are not presented as completed gates here.

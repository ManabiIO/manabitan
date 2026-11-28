# Recovered import investigation: 07:39 UTC snapshot

This directory contains the original evidence recovered after an executor outage. It is a research archive, with no product source changes and no claim that a candidate qualifies for promotion.

## Contents and boundaries

The seven numbered parts reconstruct `import-investigation-81585d-20261128T0739.tar.gz` (26,222,875 bytes, SHA-256 `b1801f36d21b233ae04dd7ea664b575658f5f3cd882d4ffc6d4ce11861df05e8`). The full per-file manifest covers 3,056 files and 154,129,300 uncompressed bytes. Both source bytes while packing and every archive member after packing were verified.

The snapshot time is **2026-11-28T07:39:35.095626Z**. It includes the original frozen checker, its freeze/tests, both package preflights, both corrected source-validation artifacts, all six lazy-signature browser cells, original component observations and failures, profiles, history receipts, and composition controls.

It excludes later early-release browser artifacts and the active test-only lazy successor. Python bytecode caches and symlinks are excluded. Historical status files retain their original acquisition-time contents; consult the parent handoff for the newer disposition. No benchmark was rerun to make this archive.

Archive namespaces:

- `experiments/`: the original `manabitan/builds/perf/20261127-81585d/` evidence, excluding the active successor directory.
- `qualification/`: provider ingestions, frozen aggregate checker, original profiles and diagnostic/history material.
- `lazy-signature-incomplete-cohort/`: the original interrupted component cohort, including the failure that prevents a valid aggregate.

## Reconstruct and verify

From this directory:

```sh
python reconstruct.py --output /tmp/import-investigation-81585d-20261128T0739.tar.gz
mkdir -p /tmp/import-investigation-81585d-20261128T0739
tar -xzf /tmp/import-investigation-81585d-20261128T0739.tar.gz -C /tmp/import-investigation-81585d-20261128T0739
```

The script verifies the manifest, every part, the complete archive, and all archive member names, sizes and SHA-256 values. It does not execute archived code or extract files.

The original aggregate checker can be run against a separate clean checkout of baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`:

```sh
python /tmp/import-investigation-81585d-20261128T0739/qualification/promotion-checker/check.py --baseline-root /path/to/exact-baseline --evidence-root /tmp/import-investigation-81585d-20261128T0739/qualification/stage2
```

Exit 2 and a negative promotion disposition are expected for this snapshot: lazy signatures fails its JMdict target and has source/observer failures; early-release timing cells are absent at this cutoff. Do not alter the frozen checker to admit a later source or replace a failed observation. Some original reproduction scripts intentionally record the original absolute workspace paths; inspect those before running unrelated diagnostics.


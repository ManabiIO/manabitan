# Resolved-reference origin across internal record splits

Source PR: https://github.com/ManabiIO/manabitan/pull/897

Baseline: `7d1643e6147a10cb2165e9744cf0e63b59e46632`

Published source: `475d351ff07c1b5cfc5651d7f59c624629e4fdc5`

The change preserves the existing factory-origin proof when the importer creates an exact internal slice. That lets the existing record-field encoder write offset and length columns directly into its output. Current reference identities and values are still rechecked after each awaited append. External, accessor-backed, shared, replaced, or unrelated views retain the generic validation path.

## Completed evidence

`record-split-jmdict-replay.json` contains the completed pinned JMdict replay. `executed-eager-archive.mjs` is the original executed runner, preserved byte-for-byte. Every configuration parses and verifies all 528,299 rows. Baseline and candidate checksummed record envelopes compare byte-for-byte.

| Worker policy | Planned groups | Segments | Rows in split groups | Offset/length staging bytes avoided |
| --- | ---: | ---: | ---: | ---: |
| 2 workers | 8 | 18 | 348,299 | 2,089,794 |
| 3 workers | 12 | 12 | 0 | 0 |
| 5 workers | 20 | 20 | 0 | 0 |

The claimed reduction is 6 temporary bytes allocated and copied per affected row, established from the source allocation path and actual typed-column copy counts. Common score-column copying remains in both arms. This is an allocation-work result for the lower-concurrency/split-group case; the 3- and 5-worker JMdict policies have zero activation in this receipt.

The replay uses the current byte-balanced lazy-planner grouping, sequential production parser calls, and actual record/envelope encoders. Resolved references are deterministic valid source-content spans. It does not execute compression, global content deduplication, browser OPFS, or UI work and measures neither elapsed time nor peak memory. It supports no end-to-end import speed claim.

## Portable reproduction

Requirements: Python 3; Node matching the repository engine (`^22.22.0 || >=24.8.0`); installed dependencies and `npm run build:libs` in both checkouts; the exact pinned JMdict archive in a cache directory. The archive name and SHA256 are taken from the baseline's `test/perf/dictionaries.lock.json` and verified by the runner.

Prepare separate baseline and candidate checkouts at the commits above. The candidate commit is obtainable through `git fetch origin pull/897/head` while that PR ref is available. `source-only.patch` also reproduces the source/test delta on the baseline. The wrapper verifies both record-store source hashes and the preserved runner hash before execution.

Run with paths appropriate to your machine:

```sh
python3 reproduce-jmdict.py \
  --baseline /path/to/baseline \
  --candidate /path/to/candidate \
  --cache /path/to/dictionary-cache \
  --output /path/to/replay-output
```

The default policies are `2,3,5`; `--workers 2` restricts the replay to one policy. `--node` can name a different Node executable. The wrapper writes a parameterized copy of the preserved runner into the output directory, then executes it. It does not edit either checkout or the preserved runner. This portable wrapper was added after the observation and was not used to produce the retained report; it changes only the three directory constants and fixture-cache path.

## Validation and unsuccessful attempts

Five focused files passed 78 tests with a single Vitest worker. The new tests cover index segments, offset splits, dictionary splits, output parity, external/proxy/shared/custom-view fallback, mutation callbacks, and revalidation after awaited appends. `hosted-ci.json` records seven successful workflows for the exact published commit, including all 15 applicable CI jobs: full unit tests, TypeScript checks, JavaScript lint, the build, and Chromium/Firefox extension E2E. Four conditional jobs were skipped as recorded. Earlier local broad checks were interrupted by resource pressure and are not represented as passes.

`record-split-vndb-eager-archive-failure.json` records the first VNDB attempt's observed exit code 137 and zero completed observations. The exact signal cause was not independently established.

`file-backed-archive.mjs` is a separate follow-up runner that streams archive hashing and reads via file-backed `BlobReader`. Its single VNDB attempt has no completed report. `record-split-vndb-file-backed-incomplete.json` preserves the available state: the execution response was truncated during context compaction, so its session ID and exit status are unknown. The empty retained log is included. This attempt was not restarted; no VNDB correctness or performance claim comes from either attempt.

`source-and-evidence-hashes.json` records source, test, original-runner, report, patch, and receipt SHA256 values and the local focused-test command. The local validated commit and published commit have the same source tree.

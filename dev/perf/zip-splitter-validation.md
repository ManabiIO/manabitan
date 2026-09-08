# ZIP splitter import experiment - September 8, 2026

## Decision: draft, not release-ready

The isolated splitter improves Jitendex whole-import timing on this Linux host, but JMnedict shows a small, repeatable regression concern. Do not promote this candidate to release defaults on the Jitendex result alone. The exact-tail follow-up did not resolve the concern and was reverted. No change to `main`, `develop`, the benchmark vendor pin, PR #20, parser code, storage format, worker-count defaults, or import flags is included.

Baseline: `394d8eb799dd1eb5e194cee11472a4beab915080`, the current PR #20 (`perf-render-overlap`) head, not release `main` or upstream Yomitan. The benchmark repository's `vendor/projects/manabitan` pin matches release main at `d3fc6795ccce4ba9b293c336898f3dcb32338128`; it is not the latest performance stack.

## Scope and motivation

A separate browser CPU trace identified recursive ZIP chunk splitting as a hotspot. The pinned zip.js 2.7.54 splitter repeatedly copies the shrinking remainder of a large input. The candidate iterates over bounded output chunks, retains one pending chunk, and gives each emitted chunk independent ownership so worker transfers do not detach the remaining data. A source-hash-checked esbuild adapter applies the helper to both the host ZIP and codec-worker bundles, preserves the upstream license, and fails closed if the dependency changes. No dependency files or generated binaries are committed.

This is a narrow re-evaluation, not a claim that the old combined experiment was successful. Rejected branch `perf-import-linear-zip` (`15864af62dd1ee1e51cd87f3f6894a8a5df81041`) also changed Zstd and block-store code. None of those changes is included here. Upstream zip.js [v2.8.28 release notes](https://github.com/gildas-lormeau/zip.js/releases/tag/v2.8.28) independently describe the iterative splitter fix; this patch does not attempt the wider codec/worker API upgrade.

## Method

Forty complete browser imports for the reviewed candidate: five adjacent pairs each for JMdict and Jitendex, and ten for JMnedict. The first five pairs per dictionary were the initial comparison; five additional JMnedict pairs were explicitly exploratory confirmation after mixed results. Odd pairs are AB, even pairs BA. Every run uses a fresh browser profile, pinned ZIP fixtures, production import defaults, and the identical corrected PR #20 schema-3 harness.

The authoritative boundary is the browser's monotonic file-input `change` event through the current session's post-UI import-complete event. It includes archive handoff, import, and UI completion; it is not a physical-paint measurement. Worker-RPC and automation-observed intervals are recorded separately. No tracing, screenshots, phase profiling, or process sampling is enabled in timed runs. Build/test work was separated from timed imports, including a pause only between completed dictionary pairs. There was no imported-artifact shortcut and no discarded failing timed run.

Host: Linux x64, AMD EPYC 9V74, four-core cgroup CPU quota, 4 GiB cgroup memory limit; benchmark process affinity `[0,1,2,3]`. Node 24.20.0, V8 13.6.233.17-node.53, Playwright 1.63.0, Chromium 153.0.8010.12. Package lock, dictionary lock, timing harness, parser WASM, and Zstd WASM were held fixed. Tests exercise the ZIP-worker route selected by production policy on this host; other hardware, Firefox, and the higher-memory compressed-input WASM route have not been performance-validated by this experiment.

## Whole-import results

Negative paired change means faster. Percentages are the median of `(candidate / baseline - 1) * 100` for adjacent pairs, **not** the ratio of the independently computed column medians. Small sample counts and a shared host do not establish universal device gains.

| Dictionary | Pairs | Baseline median ms | Candidate median ms | Median paired change | Faster pairs |
| ---------- | ----: | -----------------: | ------------------: | -------------------: | -----------: |
| JMdict     |     5 |             1859.5 |              1741.0 |               -1.92% |          4/5 |
| JMnedict   |    10 |             1486.7 |              1505.4 |               +3.93% |         3/10 |
| Jitendex   |     5 |             3871.9 |              3438.8 |               -9.27% |          5/5 |

Jitendex improved in all five pairs. JMdict improved in four of five, but its paired median is modest. JMnedict was slower in seven of ten; that is an unresolved sign-off issue, not evidence of a general win. Worker-RPC median paired changes were -2.19%, +3.68%, and -9.72% for JMdict, JMnedict, and Jitendex, respectively.

### All reviewed-candidate pairs

A is baseline; B is candidate. Milliseconds below are rounded only for presentation; original browser values are retained in the JSON evidence.

| Dictionary | Pair | Order |   A ms |   B ms |
| ---------- | ---: | ----- | -----: | -----: |
| JMdict     |    1 | AB    | 1866.0 | 1636.0 |
| JMdict     |    2 | BA    | 1914.8 | 1892.0 |
| JMdict     |    3 | AB    | 1713.8 | 1523.8 |
| JMdict     |    4 | BA    | 1859.5 | 1876.9 |
| JMdict     |    5 | AB    | 1775.0 | 1741.0 |
| JMnedict   |    1 | AB    | 1525.7 | 1598.8 |
| JMnedict   |    2 | BA    | 1440.4 | 1548.7 |
| JMnedict   |    3 | AB    | 1585.8 | 1518.8 |
| JMnedict   |    4 | BA    | 1735.3 | 1469.0 |
| JMnedict   |    5 | AB    | 1355.2 | 1421.1 |
| JMnedict   |    6 | BA    | 1373.3 | 1471.3 |
| JMnedict   |    7 | AB    | 1447.7 | 1492.1 |
| JMnedict   |    8 | BA    | 1551.9 | 1568.6 |
| JMnedict   |    9 | AB    | 1428.6 | 1597.2 |
| JMnedict   |   10 | BA    | 1567.3 | 1422.9 |
| Jitendex   |    1 | AB    | 3654.6 | 3438.8 |
| Jitendex   |    2 | BA    | 3975.3 | 3373.7 |
| Jitendex   |    3 | AB    | 3871.9 | 3512.8 |
| Jitendex   |    4 | BA    | 4178.0 | 3413.5 |
| Jitendex   |    5 | AB    | 3783.6 | 3607.6 |

## Rejected exact-tail follow-up

A second version tried reducing small-tail allocations and avoiding the final partial-buffer copy. Five new JMnedict pairs produced a +6.25% median paired change, with only one faster pair. It was dropped, not folded into the reviewed source. These ten runs are separate from the forty above; do not pool the different candidates or hide the rejected results.

| Pair | Order | Baseline ms | Rejected variant ms |
| ---- | ----- | ----------: | ------------------: |
| 1    | AB    |      1426.1 |              1535.2 |
| 2    | BA    |      1393.0 |              1459.9 |
| 3    | AB    |      1454.6 |              1545.5 |
| 4    | BA    |      1454.3 |              1561.2 |
| 5    | AB    |      1454.5 |              1433.0 |

## Correctness and integration

- All 50 timed imports (40 reviewed-candidate comparison runs plus 10 rejected-variant comparison runs) passed exact persisted title, revision, and term-row-count checks, with 12 readable-content probes after timing. Counts are 526,942 JMdict, 667,942 JMnedict, and 435,448 Jitendex. These are sampled persisted-content checks, not exhaustive database equality.
- Independently compared all 595 non-directory ZIP entries across the three fixtures: 759,119,664 decompressed bytes identical, with explicit CRC verification on both generated libraries. Both rejected deliberate CRC corruption and a truncated central directory. This verifier uses the main-thread codec; real worker integration is covered by browser imports and E2E. The verifier first had a Node Buffer-versus-Uint8Array fixture error; correcting the test input to a true Uint8Array resolved it without product changes.
- 21 new regression tests cover fragmented inputs, boundaries, empty streams, nonzero offsets, immediate transfer/detachment, an 8 MiB input, 100 deterministic fragmentation cases, invalid internal chunk sizes, both generated ZIP bundles, and the dependency hash guard.
- Full unit suite: 153 files, 5,410 passed, 46 skipped, including those 21 new tests. Separate options suite: 25 passed.
- All four TypeScript projects pass: main, dev, test, and bench. All-target build dry run passes. Focused new-file lint passes with `@stylistic/semi: [error, never]`; repository-wide lint is not claimed green.
- Strict full Chromium extension E2E passes all 83 phases without skips: import, concurrent lookup, interrupted-update recovery, updates, restart persistence, batch import, hover/search stress, and deletion. Firefox was not rerun; PR #20's existing Firefox and earlier parser-performance sign-off concerns remain separate and unresolved.

## Provenance

Exact five-file reviewed source tree, before this documentation: `68c698900943ab62e8f803bca8a0353b74938a0a`. The GitHub-created tree was required to equal the locally tested Git tree before publication. The experimental exact-tail version is absent from that tree.

Each arm used a single unchanged packaged extension across its 40-run comparison. SHA-256 values:

| Artifact                      | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| Baseline measured Chrome ZIP  | `be86a580e3a29dd46e3b0b4f8bc2ee2717604085c5c3287aac8e1af0ac1e6dd9` |
| Candidate measured Chrome ZIP | `f44ad0376cafaf08623e2a16eff3655919e6cc660f6c4589a839036be023d391` |
| Shared parser WASM            | `f734104d5933719059406387dd07de2148c8612a7ae02f2bd5bb92eef80cfc56` |
| Shared Zstd WASM              | `ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc` |
| Candidate ZIP library         | `677c046f58f6c9648b240e68df3a9fddaa2ba606ad44f007fc29bc6852504ec7` |
| Candidate ZIP worker          | `3a1fa9912be59b7ea81abd9b8ee62f91f9de6e8aadb08fa9f44dd68aa3f3fe5d` |

After reverting the rejected variant, rebuilding reproduced all 546 packaged file payloads byte-for-byte. The ZIP container hash changed solely because all entry timestamps changed; the measured package hashes above identify the actual timing inputs. Node dependencies were shared through a symlink between worktrees; source and package provenance, including dirty-state flags, are retained in every report.

Fixtures use the unmodified `test/perf/dictionaries.lock.json`: JMdict/JMnedict 2026-09-06 and Jitendex 2026.08.11.0, with exact SHA-256/size/title/revision/row-count verification. Full reports, logs, source-comparison driver, per-entry byte hashes, trace, and rejected experiment are retained in the accompanying evidence archive, excluding dictionaries, fonts, dependencies, and browser/runtime binaries.

## Reproduction

The current performance tasks live in Manabitan itself: `mise run perf:import`, `perf:import:trace`, `perf:import:ab`, and `perf:dictionaries`. The parent benchmark repository also has the older supported-knob task `manabitan-import-flags-ab`. Its flags A/B is not a substitute for comparing two different source builds.

Prepare independent worktrees at baseline and this candidate, install the locked dependencies, build their libraries and `chrome-dev` packages, and verify pinned dictionaries. Alternate the following command between those worktrees, selecting `jmdict`, `jmnedict`, or `jitendex` and a distinct output directory per run:

```sh
node dev/perf/import-benchmark.js jitendex --runs 1 --no-build --output /absolute/output/run
```

`mise` is optional: the tasks invoke these same Node entrypoints. Keep both builds' harness and fixture hashes equal, verify each report's schema/acceptance fields, and report per-dictionary paired ratios. Run traces separately. Before promotion, resolve the JMnedict regression and repeat on another representative runtime; do not revive the old withdrawn whole-import percentages.

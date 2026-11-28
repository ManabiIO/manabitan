## Status

**Draft / HOLD.** This implements a promising JMdict compression scheduling mechanism. A repeatable component gain justifies reviewing the mechanism; a whole-import speedup and browser-memory pass have **not** been established.

Current clean product: `54844293b8ea82350531b8da92336b325d5ab7ec`, based on develop `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16` with #972's current parser/WASM. [Exact-source qualification](https://github.com/ManabiIO/manabitan/actions/runs/46132124178) uses `c98110712296be803fcb30b9295bb11c7d0b44bc`. Its complete product and test subtrees match this PR. Promotion requires the unchanged gates below.

## Why and what changes

JMdict finishes the ordered content/record sink for one owned group before the next group can prepare its content. Reserved content offsets permit a narrower dependency: after the first group's metadata is published, the next immutable group can prepare deduplication/compression while the first finishes persistence.

- Admit at most two eligible append owners. Successor content preparation starts after predecessor metadata publication; successor metadata and record writes still wait for predecessor completion.
- Retain immutable parser ownership, source lead, byte accounting, progress, and metrics through full completion.
- Latch failure/cancellation, join every started operation, and unwind successor metadata before predecessor rollback. Finalization claims ownership before draining active appends.
- Continue physical worker assignment across adjacent shared-span compression batches to balance partial worker rounds.
- Use private, single-consumer completion tickets for internal overlap. Ordinary public callback results retain their previous awaited/ignored behavior, including incidental values returned by `Array.push`.
- Derive parser wall time using the union of overlapping sink intervals; retain per-consumer work sums.

Cross-group preparation requires complete immutable owned shared content, complete native dedup metadata, and the existing JMdict compression path. Borrowed, private, partial, unwitnessed, media, and otherwise ineligible chunks keep completion-ordered behavior. Codec settings, block geometry, worker counts, producer budgets, and stored formats stay fixed. The worker cursor applies to all shared-span batches, so Jitendex and VNDB must pass their nonregression gates.

The diff contains seven runtime files, eight test files, and the required copyright-header registration. Benchmark controls are on a separate qualification branch.

## Completed gain evidence and its scope

The corrected replay uses frozen baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`, exact native-parser/dedup spans for **528,299 JMdict rows**, 12 groups, 100,300,626 input bytes, and **103 blocks**. It runs the shipped codec and dictionary on four real Node workers. Twelve rounds balance all six A/B/C orders twice; all 36 observations are retained.

| Comparison | Paired median change | Equal-work change | Faster pairs |
| --- | ---: | ---: | ---: |
| Prototype B / serial A | **−13.0747 ms / −16.5153%** | −17.2931% | 12/12 |
| Prototype B / identical serial C | **−10.6451 ms / −12.9197%** | −15.2888% | 11/12 |
| Identical C / A | −1.0119 ms / −1.1922% | −2.3661% | 7/12 |

Elapsed arm medians are A 78.6873 ms, B 67.5730 ms, and C 78.0943 ms. Their difference is a different statistic from the paired median change.

**This is a scheduling prototype, not a timing run of this PR's runtime.** B rotates the baseline pool's worker array and permits two pending codec groups. The committed cursor uses the same successful physical-worker sequence, but production's metadata-publication gate can make its useful overlap window narrower. Parsing, dedup, records, OPFS, browser transport, and UI are excluded. All arms also drift downward during the cohort; balanced orders and the identical control reduce simple order bias but do not establish a stable production magnitude.

All 36 timed observations have identical per-block compressed hashes and output bytes. One separate verification-only run decodes all 103 blocks and matches every input block; this does not claim 36 separate decode passes.

A separate 100-observation five-arm ablation favors the combined mechanism, but its identical-control drift makes the magnitude inconclusive. Rotation alone is not established as a worthwhile optimization. The earlier 4 MiB/31-block screen is superseded and is not the basis for this draft.

Immutable evidence:

- [All 36 observations, paired arithmetic, exact source and fixture bindings](https://github.com/ManabiIO/manabitan/blob/a1f7c234db525d960b38a90f1930b7354f1cb18e/builds/perf/import-overlap-20261128-da6c4/corrected-codec-review-receipt.json).
- [Exact corrected replay source](https://github.com/ManabiIO/manabitan/blob/a1f7c234db525d960b38a90f1930b7354f1cb18e/builds/perf/import-overlap-20261128-da6c4/corrected-codec-replay.mjs). Its inherited warmup comment about an idle fourth worker applies to the superseded 4 MiB screen; all four are active at 1 MiB.
- [Raw evidence archive and member hashes](https://github.com/ManabiIO/manabitan/blob/a1f7c234db525d960b38a90f1930b7354f1cb18e/builds/perf/import-overlap-20261128-da6c4/components-v1-index.json), including complete timings, ablation, failed attempts, and DB/store parity receipts.
- [Full experiment handoff and later validation history](https://github.com/ManabiIO/manabitan/blob/bf26d0371a10edeaf19a31d9d246b1f5f83b411d/dev/perf/import-experiments-20260914.md).

## Correctness and verification

The initial full DB/store replay belongs to implementation `a20453bc`, not this repaired runtime. It covered all 528,299 rows, exact metadata/dedup results, 103 compressed blocks, persisted content/record hashes, and 36 reopened probes per arm. SQLite setup/journaling/COMMIT and the browser producer were outside that replay.

Earlier focused validation passed 225 affected tests, all 66 existing cleanup tests, test TypeScript, scoped lint, and the all-target build configuration dry run. Prior-base `c819bb92` also passed [static-web Chromium CI](https://github.com/ManabiIO/manabitan/actions/runs/46121741356). Those are historical checks, not a full pass for the current source.

The previous current-base [qualification](https://github.com/ManabiIO/manabitan/actions/runs/46125980377) passed JavaScript lint and main/test types, then failed three tests before any browser acquisition: two native parser settlement checks and one worker-pool startup case. 672 files and 15,174 tests passed. The failures are retained, not excluded.

The current repair addresses both causes:

- The completion check incorrectly treated every non-void callback result as an internal ticket. A private registry now recognizes only tickets created by the internal producer. Ordinary values and objects are ignored without reading their properties; authentic tickets transfer ownership once. Importer adapters rewrap genuine completions, and sequential adapters join them.
- The worker-pool test assumed consecutive shared batches used the same physical worker. It now targets the first logical batch's recorded jobs and joins cleanup/retry work. The runtime cursor and existing startup ownership assertions are unchanged.

New coverage includes ordinary values/thenables, throwing incidental getters, copied/proxied/inherited ticket shapes, repeated genuine tickets, publication failures, cancellation, pending storage ownership, and successor failures.

The next [static-web type gate](https://github.com/ManabiIO/manabitan/actions/runs/46129517279) passed main types but exposed four errors in the new callback assignability test. Commit `2e82d995` corrects the deferred/lazy/compressed callback parameter indexes and infers the numeric callback before assigning it to the legacy void type. Runtime bytes and every byte after that first test are unchanged. The [exact repaired static-web run](https://github.com/ManabiIO/manabitan/actions/runs/46130835581) then passed main/test/web types, 78 focused tests and all 24 browser acceptance checks, including real JMdict/Jitendex import, cancellation, rollback, abrupt-tab recovery, media, restart, offline lookup and deletion. These are functional results, not comparative timing or memory results.

The subsequent qualification at `53a00db6` stopped at twelve lint diagnostics in three new completion tests, before any import observations. Commit `54844293` changes only test formatting and equivalent JSDoc placement, with one explained next-line lint exception for an intentionally malformed thenable input. Every assertion remains; runtime and lint configuration are unchanged. The new complete qualification must pass before its browser cells run. The failed lint log and exact repair are retained in the research evidence.

On the same runtime bytes at predecessor `88add36`, hosted unit tests passed (674 files, 15,186 passed plus 47 skipped), pinned WASM reproduction and all seven actual extension packages built, and real Chromium extension E2E passed. Those individual successes are retained; other queued predecessor jobs were cancelled after the new head. They do not replace current-head gates.

Before the local executor became unavailable, the current-WASM native settlement commands exited zero in both default/reference modes. Their raw result files were not retrieved, so no archived current-native report is claimed. Current repaired local Vitest/lint attempts exited 137 before useful diagnostics; full hosted lint/types/units/build checks remain required. The repository's `test:build` command is a seven-target dry run; qualification separately emits and checks the Chrome release packages. Final source blobs were reconstructed from exact GitHub source and recorded changes, then independently tree-bound for hosted verification.

The clean and qualification checkouts have identical:

- `ext/`: `7c2db3acb0121fca3e639350c629d8afb561a9f7`
- `test/`: `114b9afcc621222f9e94fe6c20cd60fa503a8a08`
- ESLint configuration: `ecacd4bd0572e1df051d2f0167d11d09d3026cf8`

The qualification adds only its workflow, frozen source plan, and three Python identity/qualification helpers.

## Gates before promotion

The [frozen repaired-source plan](https://github.com/ManabiIO/manabitan/blob/c98110712296be803fcb30b9295bb11c7d0b44bc/builds/perf/import-overlap-20261128-da6c4/current-parser-qualification-plan.json) keeps the original numerical thresholds. Full source checks must pass before the six independent dictionary/order cells acquire measurements.

Each cell uses 12 timing pairs, four warmups, four interleaved identical-code controls, three parser workers, exhaustive media checks, and separate process-tree memory observations. VNDB must reproduce the existing 37-unit SAH allocation result; this is an expected output check, not a new product setting.

Both JMdict hosts must show at least **10 ms and 1% paired-median improvement**, at least 9/12 faster pairs, lower equal-work totals, negative upper bootstrap bounds, and identical-control drift below half the smaller measured saving. Each Jitendex/VNDB host must keep median and equal-work regression within 1%, upper bootstrap regression within 3%, and absolute control drift within 1%.

Memory retains the existing +5% paired-median and +10% per-pair PSS/private bounds and sampling-coverage requirements. Semantic, restart, persisted-output, source, and release-package identities must also pass. Results from different sources or hosts are not pooled, and traced timings are diagnostic only.

Retaining two owned source groups increases the live source window. Cancellation/finalization ordering and that memory cost are the main review risks. Component sampled RSS does not qualify browser peak memory.

This work is distinct from #874's within-one-private-batch experiment and #955's borrowed-source release work. Separate FIFO-dispatch and VNDB raw-alias experiments are excluded.

# Additional import screens — 2026-09-25

## Decision

No candidate from this round is promoted or merged. Keep the existing production defaults. The work tests four additional directions and records negative results rather than adding another unqualified product PR.

Whole-import baseline: `76362775484661b3cd8b9d2c84b228802c023a76`.
Research driver/workflow: `092d8571a083e053700377b339b1542d5b88433d`.
[Executed workflow](https://github.com/ManabiIO/manabitan/actions/runs/36172003251).

## 1. Native memory builtins: compiler no-op

Replaced the parser's explicit `memset` and `memcpy` byte loops with `__builtin_memset` and `__builtin_memcpy`, using the existing compiler and bulk-memory build flags.

Both resulting WASM modules are **42,324 bytes and byte-identical**, SHA-256 `1fabe63bd6cdf98ba987f9b5c6848e48a08bd526e44f3d0332868ee49d8b6ee5`. Only the packaged C source differs. There is no changed executable to benchmark.

The complete parser/index component checks passed for all 1,630,332 rows across JMdict, JMnedict and Jitendex. Any timing difference in these component runs is an unchanged-binary control, not an optimization result.

The job's overall status is failure because its expected-package-difference assertion required a changed WASM member. That assertion stopped the browser plan before any timing observation. Source checks, 7,348 unit tests, all four TypeScript projects and builds had already passed. Do not call the whole workflow green or count unexecuted browser imports.

Artifact `native-more-bulk-memory-763627`, ID `10881111940`, ZIP SHA-256 `9d5af524027c263d6e65324b19154c48bde95aa15560d608354af2fe9133848b`.

## 2. Two rather than four compression workers: no convincing win

Changed only `COMPRESSION_WORKER_COUNT` from four to two. Parser concurrency, compression level, block sizes, storage format and experiment flags remain unchanged. This is an exploratory fixed policy, not a proposed global default.

The complete plan finished **60/60 browser imports**: six alternating A/B pairs, three A/A control pairs and two excluded warmups for each corpus. Both packages were actually built from clean independent worktrees and differ in exactly the intended JavaScript member. Native binaries, fixture lock and harness hashes match.

Environment: Node 22.16.0, Chromium 153.0.8010.12, Linux x64, four logical processors, Intel Xeon Platinum 8370C. Fresh browser profiles, real OPFS-SAH-pool and locked full dictionaries. Timing is browser file-input change through post-UI completion. No profiling, tracing, screenshots, process sampling, retries or outlier removal.

| Corpus | Four-worker median ms | Two-worker median ms | Median paired change | Faster pairs | A/A paired change |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | 1367.40 | 1367.35 | -1.09% | 3/6 | -3.82% |
| JMnedict | 1182.05 | 1185.15 | -0.79% | 4/6 | +3.02% |
| Jitendex | 2489.75 | 2444.55 | -2.08% | 4/6 | -1.17% |

Negative means less elapsed time. Paired changes are medians of within-pair ratios, not ratios of the marginal medians. Equal-work total changes are +4.62%, +0.03% and -1.17%. A JMdict candidate pair is **29.29% slower**, retained in full. The small mixed results and controls do not justify changing concurrency policy.

Independent offline audit re-read all 60 reports, recomputed all statistics, checked 180 executed/effective parser/compression experiment snapshots, clean source/package/fixture identities, full title/revision/row counts, zero import errors and at least twelve readable persisted-content probes per observation. Source, encoded-content, deduplication and written content/record/index counters match between arms; parser heap maxima match. These are not whole-browser memory measurements or exhaustive persistent-store byte equality.

The experiment snapshots retain native segmented lookup and lookup-scratch reuse as true; other recorded experiments, including generic span compression, are false. An empty override object does not mean every experiment is disabled.

This job passed 7,348 unit tests (46 existing skips), all four TypeScript projects and all-target build plans. Its whole-import step and final job status are success. No additional full lifecycle or Firefox comparative performance run was performed for this rejected policy.

Artifact `native-more-compression-two-763627`, ID `10881437578`, ZIP SHA-256 `573b04361195f8bfc30b95d184a5f975a695cab62ee7484449762a6c601fd2b6`. Both Actions artifacts are retained through October 25, 2026.

## 3. Existing global exact-content reuse: mixed component results

Screened the existing `experimentalGlobalExactContentReuse` flag with the actual repository parser-plus-completed-lookup driver. This is not a newly implemented algorithm or a complete-import benchmark.

Local source capsule is from `a3925549826671bc1026035f43f0fde2e407077c`; all seven driver-tracked parser/lookup source hashes and the compiled WASM match the corresponding 763627 baseline used by Actions. Other repository files are not claimed to match. Two measured pairs per corpus, full-corpus output digests checked, excluded per-process warmups, no A/A control cohort.

| Corpus | Median paired component change | Faster pairs |
| --- | ---: | ---: |
| JMdict | -9.29% | 2/2 |
| JMnedict | +5.55% | 0/2 |
| Jitendex | +12.27% | 0/2 |

All row counts and full output digests match. This small screen raises regression concerns and does not support default promotion. No global-reuse browser timing was performed.

An initial Jitendex wrapper timed out after one complete pair (A 2236.26 ms, B 2916.01 ms). Its partial log is retained separately. The completed two-pair plan uses reversed starting order, is reported in full and is not spliced with the partial attempt.

## 4. Prepared compression dictionaries: no large-block mechanism win

Exploratory native libzstd 1.5.7 screen compares `ZSTD_compress_usingDict` with a reusable `ZSTD_CDict` at the existing JMdict level -1. Inputs are controlled-size compact JSON-row concatenations from the locked JMdict first bank, not production packed blocks. It uses the actual 16 KiB trained dictionary. This is system-native code, not the repository's WASM/browser codec.

Twenty-one alternating pairs per size, warmups excluded and complete decompression verified. Steady-state times exclude prepared-dictionary setup; no A/A cohort or aggregate memory measurement.

| Input size | Median paired change | Faster pairs | Frame bytes identical |
| --- | ---: | ---: | --- |
| 16 KiB | -43.23% | 21/21 | No |
| 128 KiB | -0.02% | 11/21 | Yes |
| 1 MiB | +0.63% | 9/21 | Yes |
| 4 MiB | +0.49% | 10/21 | Yes |

The small-input gain is not evidence of an import gain, and the 16 KiB frame bytes change even though decompression is exact. Larger blocks show no useful benefit. Do not add codec exports, native dictionary caches or a generated-WASM rebuild on the strength of this screen.

## Additional local tests and limits

Four new native memory-boundary tests pass on the unchanged executable: source alignments and tail lengths, repeated parser workspace reuse, multi-megabyte content growth and retained output ownership, and fractional-score/wide-sequence fallback followed by ordinary input. Their ESLint and configured test TypeScript project pass. They are retained in the conversation evidence, not a product PR.

An initial test run exceeded the tool timeout because deep equality expanded multi-megabyte typed arrays; complete SHA-256 comparisons replaced that test assertion implementation. A broad editor-project TypeScript invocation also traversed incompatible third-party selenium JavaScript; the repository's configured `test/jsconfig.typecheck.json` passes. These setup attempts are retained and are not product failures or benchmark observations.

Local component scripts, raw observations, the independent auditor, new boundary tests and downloaded Actions artifacts are preserved in the accompanying conversation evidence bundle. No release branch, vendor pointer, existing PR head or production default was changed by this round.

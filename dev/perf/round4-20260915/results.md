# Round four: import allocation and compaction — September 15, 2026

## Retained PRs

- [#42: direct record-field encoding](https://github.com/ManabiIO/manabitan/pull/42). Eliminate two temporary column backing stores and their final-buffer copies. Row-sized typed scratch is 8N → 2N bytes: 75% less, saving 6N bytes. This is not a total-process-memory percentage or a demonstrated whole-import speedup.
- [#43: adjacent string-span compaction](https://github.com/ManabiIO/manabitan/pull/43). Coalesce copying only where first-seen source spans are adjacent. Full-JMdict component accounting reduces source views/copy calls from 446,705 to 5,199 (98.836%), while both sides copy exactly 6,563,342 bytes over 21 compactions and have identical complete output digests. Jitendex's component route has no JavaScript compaction opportunity.

Both changes preserve the existing stored formats, source validation, row/key ordering and independently owned results. No new flags, caches, thresholds, vendor versions, larger batches, changed compression settings or worker counts are involved. The committed regression tests prove the allocation/copy differences by failing on the parent and passing on the candidate; the correctness oracles pass on both.

The retained benefits are deterministic allocation/copy-call reductions. **The whole-import timing evidence is mixed; neither PR is promoted as a proven general import-time reduction.** In particular, the favorable Jitendex confirmation for #43 is not assigned a causal speedup claim when route eligibility differs.

## All browser comparisons

Percentages are median adjacent `100 * (B / A - 1)` changes; negative means faster. Each initial cell has six alternating AB/BA pairs, three interleaved A/A pairs and two excluded complete warmups. Confirmation cells have twelve alternating pairs starting BA, six interleaved A/A pairs and two warmups. No observation is retried, removed or trimmed. Different hosts are not pooled.

| Candidate / cohort | JMdict | Jitendex | A/A: JMdict / Jitendex |
| --- | ---: | ---: | ---: |
| Direct record fields, initial | -0.689% | +0.232% | -1.655% / +0.190% |
| Direct record fields, independent confirmation | +0.699% | -0.716% | -0.678% / +2.161% |
| Coalesced string copies, initial | +3.380% | -0.169% | -0.222% / -0.223% |
| Coalesced string copies, independent confirmation | -0.229% | -2.448% | +1.104% / -0.018% |
| Scalar arguments instead of pending dedup descriptors | -4.474% | -0.794% | -6.359% / -1.809% |
| Run-based content-reference offsets | -0.576% | +0.386% | -2.224% / +0.113% |
| Reuse of validated content-reference headers | +1.243% | +0.259% | +0.975% / +8.404% |

The last three candidates are not included in either PR. Their additional argument/validation bookkeeping did not demonstrate a clear timing benefit. The larger favorable dedup-descriptor result is smaller than its same-binary control drift and is not reported as a win.

There are **352 complete browser imports across 14 cohorts**: 108 A/B pairs, 54 A/A pairs and 28 excluded warmup observations. Each retained candidate accounts for 116 observations.

All raw reports were audited against the complete plans, exact source/package identities, actual all-false worker receipts, dictionary metadata and row counts, twelve persisted lookup/content probes, real OPFS-SAH-pool mode, source-byte totals, group/worker accounting, deduplication counts and maximum individual-worker heaps. The latter are not total browser-tree memory measurements.

Fixtures: locked JMdict 2026-09-06, 526,942 rows, ZIP SHA-256 `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a`; Jitendex 2026.08.11.0, 435,448 rows, SHA-256 `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc`.

Timing: Chromium 153.0.8010.12, Node 24.20.0, Clang 18.1.3, Ubuntu 24.04 x64; warmed hosts with fresh browser profiles; file-input change through post-UI completion. Traces, profiling, screenshots and process sampling are disabled. Each controlled package changes only its intended JavaScript member, with unchanged WASM and all other member contents. These reconstructed ZIP sizes are not production package-size estimates.

## Component accounting and tests

The string-compaction component parses every locked row and completes lookup construction with fixed existing component grouping. Initial four-pair component changes were -4.696% JMdict and +0.786% Jitendex; all corresponding complete digests and index sizes agree. This excludes ZIP inflation, OPFS, worker scheduling and UI and is not a whole-import estimate.

The separate instrumented count traversal ran the production compactor for two warmups and one verified full pass per arm. JMdict totals were 1,340,115 versus 15,597 copies across the three passes, each with 19,690,026 copied bytes. Reported per-pass values divide by three only after checking exact divisibility. Complete digest: `430a59f035c1e6bb66352f50b3d722b8bf853b394d56d5816f0576594e1ebb57`. Jitendex has zero such calls in both arms and matching digest `b618d21aa8c89a3f2f21613fa15c9fa8689bdd9efb991c9475e78e8ac057e805`.

These counters are local component work accounting, not browser timing or peak memory. The local compiler/runtime differ from CI; WASM SHA-256 is recorded as `394977947304fdea3233f18484e4337da5e531fec2a5b6ee8dafaa10628318f5`. The uninstrumented source hashes match the independently browser-tested candidates. No instrumented source is in either PR.

| Exact-head qualification | #42 | #43 |
| --- | ---: | ---: |
| New regression tests | 29 passed | 20 passed |
| Expected parent failures | 1 allocation assertion; 28 correctness tests pass | 2 copy-count assertions; 18 correctness tests pass |
| Focused tests | 311 passed | 302 passed |
| Full unit tests | 6,442 passed, 46 existing skips | 6,433 passed, 46 existing skips |
| Options tests | 27 passed | 27 passed |
| Full strict Chromium | 85 phases, no skipped verification | 85 phases, no skipped verification |

Both also passed all four strict typecheck projects, changed-file ESLint without rewriting, all-target build plans and actual Chrome/Firefox development packages. The full browser runs cover real imports, persisted content, concurrent lookup during import/update, update crash recovery, restart persistence, multi-file imports, repeated hover/search and deletion. Firefox/Safari runtime, ARM performance and complete persistent-store equality are not claimed.

## Exact source and run provenance

Benchmark baseline: `30ffb604e0a87f0aa252bd4331bc54668062b1e1`, tree `c069f4ca92d8e6902a1a182281a06b2579610c05`.

#42 qualified head: `7bebff928f324c473db567488c0c752f8c700dc0`, tree `50de85a042e57f648e75d4ac1fb60882cb3f07d2`.
#43 qualified head: `51ec5f7eba758fb2dcd8ecc53a4915c9b49e7deb`, tree `c6059fab5aec65178da7988471e9a603e85734f8`.

- [Initial three storage candidates](https://github.com/ManabiIO/manabitan/actions/runs/35043834883)
- [Reference-header candidate](https://github.com/ManabiIO/manabitan/actions/runs/35043938031)
- [String-compaction screen and full-corpus byte comparison](https://github.com/ManabiIO/manabitan/actions/runs/35044413031)
- [Independent confirmation](https://github.com/ManabiIO/manabitan/actions/runs/35044667686)
- [Failure-first and full exact-source qualification](https://github.com/ManabiIO/manabitan/actions/runs/35045014652)
- [Read-only integration with updated develop](https://github.com/ManabiIO/manabitan/actions/runs/35045540500)

During qualification, #39 and #40 were merged independently into develop `b4094a423c20bb0ed424d944238f922c1b36559c`. Those changes do not overlap the two new production functions. Their integration check composes the two unchanged PR heads on that exact updated base in an ephemeral checkout, without publishing a branch or merging a PR. Original A/B observations remain attributed to their original baseline; they are not relabeled as measurements on the updated base.

Raw timing artifacts retain every executed driver, patch, plan, identity, report and completion marker for 30 days. The offline bundle additionally contains recomputed CSV/JSON, exact tests, component copy counters and the offline evidence audit. No merge was performed by this round.

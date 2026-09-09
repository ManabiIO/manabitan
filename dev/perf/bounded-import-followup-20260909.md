# Bounded compressed import follow-up — September 9, 2026

## Decision and source

**Material JMdict/Jitendex gains on the tested constrained Chromium runtimes; JMnedict is not signed off. Draft review only, not release approval.**

Baseline: PR #23 `b8d68458cde8788b5d5301ceaf36beae7a1363f9`, not upstream Yomitan or release main. This pass reuses the existing bounded implementation `29eb2f1e322847566b724934cbd7ac9a9b81ed2b` rather than maintaining a duplicate, adds 20 independent tests, and supplies new comparisons. Source/test commit: `000dbe4decb6159b8cae323312088a79dd10cd5a`; exact tested tree: `e6d11144e19efb196ffa17480eaa539e3596746b`. Later documentation does not change measured code.

Compressed payloads go directly to the existing WASM parser workers for inflation, validation and parsing, instead of first inflating in the ZIP layer and transferring expanded JSON. Low-memory plans retain the existing 64 MiB decoded-source budget and 80-file cap, independently cap compressed input at 64 MiB, and re-plan after releasing each batch. Ordinary fallback remains for unsupported metadata, oversized banks, fewer than four banks or unavailable raw reads. High/unknown-memory import-wide behavior remains unchanged.

These are source-batch limits, **not total process/RSS/WASM-heap limits**. Parser, ZIP, Zstd, database, preinterned-plan, compression level, persistent format, cache limits, global worker settings and UI behavior remain unchanged. The direct-fill ZIP adapter and earlier rejected experiments are excluded.

## Whole-import comparisons

Every row has four adjacent AB/BA pairs plus one separately retained warmup pair, fresh browser profiles, locked dictionaries and unchanged schema-3 browser file-input-change-to-post-UI-completion timing. Negative means faster. Percentages are medians of within-pair ratios, not ratios of the independent time medians. No outliers are removed or independent runners pooled. No profiling, screenshots or process sampling runs during timing.

| Environment | Dictionary | Baseline ms | Candidate ms | Paired change | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: |
| Local 4 GiB | JMdict | 3882.0 | 3080.6 | -20.78% | 3/4 |
| Local 4 GiB | JMnedict | 2492.8 | 2885.8 | -4.52% | 3/4 |
| Local 4 GiB | Jitendex | 8779.6 | 6132.4 | -30.19% | 4/4 |
| Constrained runner, first run | JMdict | 6739.8 | 5269.9 | -20.76% | 4/4 |
| Constrained runner, first run | JMnedict | 4490.1 | 4031.1 | -7.06% | 3/4 |
| Constrained runner, confirmation | Jitendex | 20566.4 | 11957.6 | -41.37% | 4/4 |

Local: Node 24.20.0, Chromium 153.0.8010.12, clang 17, four-core quota, 4 GiB cgroup limit, Xeon Platinum 8573C. Constrained GitHub runners: one logical CPU, clang 18.1.3, native page/worker `navigator.deviceMemory=4`; runtime, compiler, source and package fingerprints are retained. No browser memory value was overridden. Timing remains variable on shared hosts, and four pairs per cell are exploratory.

Unadjusted 20,000-resample percentile intervals for paired medians: local JMdict -40.59% to +13.16%; local JMnedict -9.77% to +78.19%; local Jitendex -40.07% to -2.67%; constrained JMdict -33.51% to -9.16%; constrained JMnedict -25.77% to +3.92%; constrained Jitendex -58.77% to -22.88%. These are not universal non-regression bounds.

**JMnedict caveat:** one local candidate pair is 78.19% slower. Although the paired median is lower, the candidate's independent median is higher and total time across four equal-work imports is **11.73% higher**. Retain that observation. No reliable JMnedict speedup or regression-free claim is established.

## Accounting and correctness

All 60 measured/warmup reports from the complete bounded comparisons pass exact title/revision/row-count checks, 12 persisted-content readability probes each, no import/settings errors or fallback storage, frozen package/source checks, complete source-bank accounting, and identical pending/persisted/unique-content deduplication totals. These are sampled persisted-content and accounting checks, not exhaustive database byte equality.

| Fixture | Banks | Baseline expanded bytes transferred | Candidate compressed bytes transferred | Candidate batches |
| --- | ---: | ---: | ---: | ---: |
| JMdict | 53 | 171092992 | 15574114 | 3 |
| JMnedict | 67 | 45421175 | 11419584 | 1 |
| Jitendex | 218 | 537538792 | 33696215 | 9 |

Every candidate batch stays within both source-byte limits and the file cap. Jitendex transfers approximately 93.7% fewer source bytes; that is not an equal elapsed-time or total-memory reduction.

Two independent full validations of the exact source/test tree pass **5,478 tests**, with 46 existing skips; options **25 passed**; all four strict TypeScript projects and all-target dry builds pass. Strict higher-memory Chromium integration controls pass **84 and 85 phases** without skipped verification. Historical constrained integration of the same runtime code, before test-only cleanup/additions, passed 89 phases; that evidence is retained as historical, not a new run.

The 20 new tests cover lazy byte budgets, adversarial compressed sizes, subsequent batches, file caps, invalid metadata, released reads, disposal and cancellation joined before fallback. The randomized test checks 100 uneven source plans over 20,000 synthetic metadata entries, not 20,000 parsed dictionary rows. Local focused validation passes 79 tests and new-file ESLint.

## Failures remain visible

[First verification 34319896500](https://github.com/ManabiIO/manabitan/actions/runs/34319896500) completed JMdict/JMnedict, but Jitendex stopped after one pair at a zero-phase settings-input startup timeout. The retry classifier expected `failed` instead of the actual `failure` report status and therefore retried nothing.

[Full-plan repeat 34321582663](https://github.com/ManabiIO/manabitan/actions/runs/34321582663) completed Jitendex with **zero retries**. JMnedict stopped after one baseline observation and two pre-import startup failures; JMdict reached the runner job limit after five measured observations. Those incomplete lanes receive no effect estimates, and observations are not spliced between runs. Neither complete workflow matrix is claimed green.

The corrected retry predicate is checked against the actual report and 11 rejecting mutations. At most one recorded retry is allowed only for the precise settings-selector timeout before any phase or import dispatch, never for import, acceptance or slow-timing failures. This does not fix product startup reliability.

A preliminary 4 GiB Docker container still reported browser device memory 16 and was rejected as a low-memory measurement. Dependency-path comment differences also caused a local preflight rejection; both arms were rebuilt from one shared dependency location and byte-checked before timing.

## Excluded ZIP candidate and trace

[Direct-fill verification 34317754128](https://github.com/ManabiIO/manabitan/actions/runs/34317754128) passed 5,470 tests, all types, options, focused lint, dry builds and 81 strict Chromium phases. Its 12-pair independent comparison gave -0.10% JMdict, **+2.16% JMnedict**, and -0.45% Jitendex; local results were highly variable. It is not a general win and is not included here.

A separate candidate-only browser trace completed after local timing. It is non-authoritative. Visible remaining work includes recent-content copies, compression and message transfer. SQLite's heavily sampled async-proxy `waitLoop` calls `Atomics.wait`; its samples are not equivalent active SQLite CPU work. No further cache/compression experiment was combined.

## Evidence and limits

Workflow artifacts retain all reports, patches and fingerprints. Key artifacts: first correctness 10091557162; first JMdict 10091961434; first JMnedict 10091746951; Jitendex confirmation 10092655856; repeated correctness 10092179979; direct-fill 10091040276. Their original ZIPs were downloaded, checked against GitHub SHA-256 digests and preserved, including incomplete lanes, in the delivered `manabitan-import-pass-20260909.zip` alongside full local reports, the separate trace and audit scripts. No fonts, dictionaries, dependencies or browser runtimes are included.

Apply `bounded-complete-source.patch` to PR #23, or only `bounded-test-followup.patch` to existing `29eb2f1`; do not apply both. Each reconstructs the exact tested tree. Rebuild with locked dependencies and verify native browser memory selection before repeating the source A/B.

JMnedict non-regression, startup reliability, larger samples, Firefox, ARM/Android and smaller-memory runtime checks remain open. Do not invent dictionary-specific exceptions from three fixtures. PR #23/PR #20's own limitations remain separate. No release branch, vendor pin or earlier PR was merged or updated.

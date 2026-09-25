# Native repeated-pass import results — September 25, 2026

## Decision

No new complete-import performance winner is established. Neither numeric revalidation removal nor quote-first dispatch is promoted. A wider escape scan was rejected during local screening. No new product PR, merge, production-default change or update to an existing product PR was performed in this round.

All six hosted jobs in [run 36190726399](https://github.com/ManabiIO/manabitan/actions/runs/36190726399) succeeded. The fixed plans completed **120/120 browser imports**. Independent audits re-read every raw report and checked **360 executed/effective parser and compression snapshots**. The results are small and mixed; no second browser confirmation or release promotion is justified by these screens.

Baseline: `76362775484661b3cd8b9d2c84b228802c023a76`.
Executed recipe: `78a3fea60dae18c21982c557101a0e92d9ccbe9c` on `verify/native-passes-20260925-763627`.
These candidates do not include PR #306 or any other unmerged optimization.

## Complete-import comparisons

Each candidate/corpus cell uses its own runner, six alternating A/B pairs, three interleaved A/A pairs and two excluded warmups. Arms run serially. Negative means less elapsed time. Changes are medians of individual matched-pair ratios, not ratios of marginal medians. No retries, outlier removal, A/A subtraction or pooling across hosts.

| Candidate | Dictionary | Baseline median ms | Candidate median ms | Paired change | Faster pairs | A/A change |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Numeric recheck removal | JMdict | 1311.40 | 1295.60 | -1.51% | 4/6 | -0.35% |
| Numeric recheck removal | JMnedict | 1168.15 | 1151.60 | -2.07% | 3/6 | -0.78% |
| Numeric recheck removal | Jitendex | 2126.20 | 2130.15 | -0.51% | 3/6 | -3.99% |
| Quote-first dispatch | JMdict | 1342.00 | 1337.20 | +0.88% | 3/6 | -1.77% |
| Quote-first dispatch | JMnedict | 1160.35 | 1163.05 | +0.62% | 2/6 | +2.25% |
| Quote-first dispatch | Jitendex | 2104.55 | 2106.40 | -1.00% | 5/6 | -0.60% |

Numeric Jitendex includes a **26.39% slower candidate pair** and a **25.32% slower A/A pair**. These are retained; neither proves a reliable regression magnitude. Numeric equal-work totals change -4.47%, -2.12%, +1.05%; quote-first totals change -3.58%, -2.12%, -3.38%. Slow baseline observations affect those totals, which are not substituted for the prespecified paired endpoint.

## Implementations

### Numeric revalidation removal

Row admission already validates score and non-null sequence JSON number grammar in `set_field`. Later materialization repeats grammar validation in `parse_scalar_span`. Replace only those two later calls with its existing bounded scanning helper, `scan_scalar_span`.

The initial admission, int32 bounds, fractional/exponent fallback, negative-zero score fallback, null sequence handling and logical bank limits remain unchanged. The source stays stable within one synchronous operation; no validation token crosses an await. No new state, allocation, format or flag is introduced.

Separate actual-WASM instrumentation on a 2,000-row integer fixture observes **8,000 to 4,000 number-grammar calls**. This is a controlled work count, not an instruction count or a 50% import-speedup claim. The hosted native parser-plus-completed-lookup screen is +1.07% JMdict, +0.43% JMnedict, +3.52% Jitendex (two pairs each), which does not support a mechanism timing win.

Source branch `verify/numeric-recheck-source-20260925-763627`: head `c577ef8d090c660cc0089490a45871c89645c7bb`, tree `80e73134efcae85747d1a1c84d1f41b00dbbc4ad`.
C SHA-256: `d4b4007188b8436d76ec82468a2262806a7f09d2a5bcabeb1290db043549fd55`.
Compiled WASM: 42,324 to 42,583 bytes (+259).

### Quote-first dispatch

Move the existing quoted-string branch ahead of whitespace classification in the composite JSON scanner. The predicates are disjoint; branch bodies, normalization hints, grammar validation and bounds are preserved. No buffer, cache, worker policy or storage change.

Source branch `verify/quote-first-source-20260925-763627`: head `a271b2677463f7113d1aa4d60b30e99ae784c51a`, tree `914ad5da5b8d53d2a8cadcdef97ca95435cf4511`.
C SHA-256: `a9fa9f485928b09c42ab3c9385f5a6d7a42e5ea3af248eceacb3df7cff86a228`.
Compiled WASM: 42,348 bytes (+24).

## Validation and measurement scope

Each final source independently passes **7,373 unit tests**, 46 existing skips, 264 files; **27 options tests**; all four TypeScript projects; changed-test ESLint; and all-target build plans. All hosted cells pass **349 focused tests**, including 25 new cases that also pass on the untouched parent. Existing score-grammar coverage includes 80,176 internal actual-WASM cases inside one Vitest test, not extra tests to add to the unit total.

Supplementary local differential testing matches **136 exact behavior/profile cases per source**, including wide/fractional sequences, null, negative zero, malformed values and explicit bank-span mode. Both candidates match the baseline, including all 62 rejected cases.

Node 22.16.0, Chromium 153.0.8010.12, Linux x64, fresh profiles and real OPFS-SAH-pool. Locked complete fixtures: JMdict 2026-09-06 (526,942 rows), JMnedict 2026-09-06 (667,942), Jitendex 2026.08.11.0 (435,448). The timer spans file-input change through post-UI import completion. Tracing, profiling, screenshots and process sampling are disabled.

Actual independently built packages differ only in the intended C source and parser WASM. Source trees are clean; Zstd, fixture lock and browser harness are identical. Empty overrides retain the production defaults: native segmented lookup and lookup-scratch reuse true, other recorded experiments false.

Every import passes expected title/revision/row counts, zero errors, non-fallback storage and at least twelve readable persisted-content probes. Source/content, deduplication, worker/heap and written content/record/index counters agree. Complete native parser-plus-finished-lookup digests match over **all 1,630,332 rows for each candidate**. This is full parser-boundary parity plus sampled persistent readback, not exhaustive stored-byte equality or total-browser peak memory.

The current round did not run another full Chromium/Firefox lifecycle suite or Firefox comparative timing. The browser lane is complete-import timing with persisted-content probes. Existing focused Node reopen/repair tests are not relabeled as browser restart qualification.

## Other local evidence

An eight-byte key-escape scan is not promoted: two-pair component changes were -2.97% JMdict, **+3.74% JMnedict**, **+11.88% Jitendex**, with complete output parity. Both Jitendex and both JMnedict pairs were slower. This is a rejection screen, not a precise general regression estimate.

A separate fixed **54-observation** local numeric repeat (six A/B and three A/A pairs per corpus) reports candidate/A/A changes of +0.98%/+2.80% JMdict, -2.77%/-2.69% JMnedict, -4.07%/+13.46% Jitendex. These noisy component results do not establish a complete-import gain. All raw observations and full output digests are retained.

Local capsules derive from a392554 with matching native/parser/lookup source identities, not complete current-develop trees. Local and hosted compiler binaries are kept separate. Local browser navigation was blocked by administrator policy; no policy was changed or local browser timing claimed.

## Failure history and evidence

Initial run 36190099941 failed before tests or timing because the recipe referenced a generated driver as if tracked at a historical path. The corrected recipe commits the actual driver and preserves setup evidence early; candidate sources and test assertions were unchanged. No failed attempt counts as a timing observation.

Artifacts from completed run 36190726399, retained by GitHub through October 25, 2026:

| Candidate / corpus | Artifact ID | ZIP SHA-256 |
| --- | ---: | --- |
| numeric / JMdict | 10888567035 | `c9102752865ec1475d06f2a7dc7e6a15d1e430f9773421e4026b888e84518804` |
| numeric / JMnedict | 10888826348 | `5ca0e25ea7e66d87cb511c1e578f77f426df4530cd15882553de6ccd7cc2c58e` |
| numeric / Jitendex | 10888596620 | `f03122908258712909fd0dccb05aba02d4cf672bbb113e70d00268c186a95b5c` |
| quote-first / JMdict | 10889020114 | `9e59188de83c88303715293afee59aca05a56579f67c3be9cd2c70aff682ed72` |
| quote-first / JMnedict | 10888291797 | `83d638b5e2453c6d444f52c31070944c0e8881b8132433e9b5a8660d3c710445` |
| quote-first / Jitendex | 10888099142 | `fc4f1142cf386a5c18451d4b8ed49b581eca25a6d1948fb2a59b2f9428ee5436` |

The conversation evidence bundle preserves downloaded ZIPs, extracted reports, exact drivers and patches, independent audits, local data, new tests, counter instrumentation and reproduction notes. No macOS/Safari/ARM/mobile, cold-OS, total-browser-memory or universal non-regression claim is made.

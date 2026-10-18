# Multi-batch compressed imports: measured gains on accepted develop

## Decision and source

The narrowed bounded-import candidate has repeatable local whole-import wins for JMdict and Jitendex. JMnedict has mixed small changes and no demonstrated improvement; no tight non-regression bound is claimed. Keep draft pending independent timing completion and final-head normal CI. Keep the unrelated rejected packing, parser and cache experiments out. This report qualifies the measured native 4 GiB Chromium configuration, not every device or dictionary. It is not a release merge or a universal non-regression guarantee.

Performance baseline: accepted `develop` **da8f7436d34e510441d30692c8d698806b70e13f**. Parent review source: [PR #31](https://github.com/ManabiIO/manabitan/pull/31) at `03478be25506176610b2133be658ee697d9bb3f1`.

Independently tested source/test commit: **`34839d51d9b2cda28806b4a3908cda88847de87d`**. Exact complete source/test tree: **`4035249c23197b72d8be9d4cca7ebd6476771ef1`**. The local reconstruction has a different commit identifier but exactly this Git tree. Documentation children do not change measured runtime code or tests.

## What changes

Use bounded compressed transport only when a low-memory import needs multiple ordinary source batches under the existing **64 MiB decoded-source / 80-file limits**. Imports fitting one ordinary batch keep the established decoded-source transport, including later planner calls after fallback. Small final batches of genuinely multi-batch imports remain eligible for compressed transport when the existing minimum bank count is met.

The admission check is structural: there are no dictionary names, special-case fixture IDs, or new size thresholds. High/unknown-memory import-wide transport remains as inherited from PR #31; the new admission restriction is low-memory only. Claims here concern the constrained configuration, not a claim that every fallback path is byte-for-byte identical to accepted develop.

The independent **64 MiB compressed-input bound**, integrity checks, cancellation/ownership rules, fallback paths and release-before-replan behavior remain. These are source-batch bounds, **not total process memory or WASM-heap bounds**. Parser/WASM, compression levels, cache capacities, worker defaults, storage formats, UI behavior and dependency locks are unchanged by this candidate. Packages built for the comparison differ in exactly two runtime JavaScript payloads: the dictionary importer and source pipeline. The parser and compression binaries are identical between arms within each environment.

## Completed whole-import comparisons

Negative change means less time. Each plan uses four fixed adjacent alternating A/B pairs per dictionary, one separately retained warmup pair, and baseline/candidate same-binary control pairs. The confirmation reverses initial ordering. Dictionary order rotates between pairs. Every observation uses a fresh browser profile and immutable, hash-checked fixtures. No retries, removed outliers, pooled environments or partial-plan effect estimates.

Timing is the unchanged schema-3 browser **file-input change to current-operation post-UI completion** interval. It is not parser-only time, physical paint time, or browser startup time. Tracing, phase profiling, screenshots and process sampling are disabled during the measurements. Ordinary phase counters may overlap and are not added together as CPU time.

| Plan                              | Dictionary | Baseline median ms | Candidate median ms | Median within-pair change | Equal-work total change | Faster pairs |
| --------------------------------- | ---------- | -----------------: | ------------------: | ------------------------: | ----------------------: | -----------: |
| Local fixed plan                  | jmnedict   |             1336.7 |              1309.8 |                    -1.83% |                  -1.83% |          3/4 |
| Local fixed plan                  | jmdict     |             1685.5 |              1344.4 |                   -18.21% |                 -18.83% |          4/4 |
| Local fixed plan                  | jitendex   |             3436.3 |              2696.9 |                   -20.78% |                 -20.89% |          4/4 |
| Local reversed-order confirmation | jmnedict   |             1308.5 |              1345.7 |                    +2.46% |                  +1.22% |          1/4 |
| Local reversed-order confirmation | jmdict     |             1697.7 |              1398.7 |                   -18.32% |                 -18.51% |          4/4 |
| Local reversed-order confirmation | jitendex   |             3492.9 |              2690.3 |                   -23.27% |                 -22.54% |          4/4 |

These are **84 successfully audited reports** across two separate local plans: 48 measured A/B imports, 12 excluded warmups, and 24 same-binary controls. The reports and full-precision values are retained separately. The final table was regenerated from every raw report and supersedes interim chat figures. JMnedict changes -1.83% and +2.46% by paired median, with -1.83% and +1.22% equal-work changes; its confidence intervals cross zero. Same-binary controls in these two plans range from -8.18% to +6.65%. Do not add these percentages to historical PR #24 gains: those used a different complete parser baseline.

Local environment: Node 24.20.0, Chromium 153.0.8010.12, clang 17, Linux x64, native page/worker `deviceMemory=4`, four-core cgroup quota and 4 GiB memory limit. The observed browser hardware-concurrency value is recorded in the raw policy report; it is not overridden. Four pairs per cell are small samples. The same-binary controls and exploratory paired-median intervals are retained in the machine-readable results; they are not tight device-wide equivalence bounds.

## Source accounting

| Fixture  | Banks | Baseline source bytes transferred | Candidate source bytes transferred | Candidate route                   |
| -------- | ----: | --------------------------------: | ---------------------------------: | --------------------------------- |
| JMdict   |    53 |                         171092992 |                           15574114 | Three bounded compressed batches  |
| JMnedict |    67 |                          45421175 |                           45421175 | Established ordinary single batch |
| Jitendex |   218 |                         537538792 |                           33696215 | Nine bounded compressed batches   |

Every report matches locked dictionary title, revision and row count; complete bank order/count and byte accounting; expected actual transport; identical pairwise deduplication totals; no import/settings errors or fallback storage; and at least twelve persisted-content readability probes. The probes are sampled, **not exhaustive database byte equivalence**. Fewer transferred source bytes are not a corresponding total-memory or elapsed-time reduction.

## Correctness qualification

Local and [independent source qualification](https://github.com/ManabiIO/manabitan/actions/runs/34423413945) passed **5,484 unit tests**, with 46 existing skips; **25 options tests**; all four strict TypeScript projects; repository JavaScript lint; library builds and all-target dry builds. Independent source publication occurred only after those checks and a clean-tree assertion. Its patch was downloaded and checked byte-for-byte against the locally tested patch.

Thirteen new tests cover low-memory tiers, exact byte/file boundaries, ordinary prefetch/read ownership, later fallback positions, small final batches, unavailable raw reads, invalid metadata, high/unknown memory, and 1,000 deterministic uneven metadata archives. Existing compressed-budget/cancellation tests retain their assertions, with fixtures adjusted to exercise multi-batch admission. Local focused validation passes 50 tests.

Local strict Chromium E2E passes **84 phases without skipped verification**, including interrupted-update recovery, restart persistence, concurrent lookups, batch imports, search/hover stress and deletion. [Independent exact-source browser qualification](https://github.com/ManabiIO/manabitan/actions/runs/34424007325) also passed: **85 Chromium phases and 65 Firefox phases**, both with `status=success` and `skippedVerification=false`. The downloaded artifacts identify the same source commit and tree. Firefox was Developer Edition 156.0b5; this is functional coverage, not a Firefox performance measurement. Parent PR CI does not establish final-head normal CI.

## Independent performance attempts and retained failures

The independent constrained matrix uses the same frozen source/test tree, unmodified timing harness, exact fixture lock and native memory policy. Only complete, inspected cohorts qualify for effect estimates. The JMnedict lane stopped at a zero-phase settings-selector timeout before a later import, after **eleven** successful audited observations. A 15,118.3 ms candidate same-binary control remains in that record. JMdict and Jitendex reached the runner job limit after **seven and nine** recorded successful observations respectively; neither completed its fourteen-observation plan. All three lanes have **no effect estimate** and are not spliced into another plan. The overall performance matrix failed; successful source and browser jobs do not turn it green. The archived successful observations include slow candidates as well as faster ones. A repeat was attempted but no started run was verified, so it provides no evidence.

An earlier verification helper used an incorrect expected patch digest. The downloaded patch matches the tested patch exactly; correcting the digest preserves the complete Git-tree and parent checks. This was not an importer failure. The runtime source did not change between the accepted local measurements and independent qualification.

The separate definition-content packing candidate was rejected after its completed six-pair plan showed Jitendex **+2.62% paired-median / +1.64% equal-work time**. It is absent from this source. Its negative observations remain in the delivered evidence rather than disappearing from the record.

## Review and limits

Keep the original PR #31 history and the tested source identity visible. Review this as the reconciled bounded-import implementation plus conservative admission, not a revival of the obsolete optimization stack. No `develop`, `main`, release branch or Reader vendor pointer was changed by this continuation.

Final-head normal CI and independently completed timing cohorts remain separate review gates; the independent Firefox functional result above is complete. ARM, Android, smaller-memory devices and other dictionaries are not performance-qualified here. Dependency-audit warnings inherited from the unchanged lockfile are not resolved by this performance work.

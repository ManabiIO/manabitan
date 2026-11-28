# Import optimization campaign results

**Decision: no performance PR.** Five approaches were investigated in eight separate benchmark cohorts. None established a repeatable complete-import gain worth review. All measured sources, controls, failed outcomes and raw observations remain distinct.

The frozen baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The final native candidate is `13e7a7e6c1568de0af563d0577385e9ba16892c1`, tree `cb45e5071784ec13fabe8d64494399c65480878c`.

## Final corrected native candidate

[Browser qualification run](https://github.com/ManabiIO/manabitan/actions/runs/46116689172) used twelve alternating pairs starting BA, two warmup pairs, four identical-code controls, separate full-media B/A imports and BAAB memory observations for each dictionary. Every artifact was checked with the prewritten frozen auditor and contract.

Positive changes mean slower imports; negative changes mean faster imports. Intervals below are descriptive bootstrap intervals.

| Dictionary | Paired median | Faster pairs | Descriptive 95% interval | Control median | Memory |
| --- | ---: | ---: | --- | ---: | --- |
| JMdict | +3.42% | 1/12 | +2.26% to +8.00% | +1.69% | Passed |
| Jitendex | +0.34% | 5/12 | -1.60% to +8.35% | +2.08% | Passed |
| VNDB | +2.59% | 1/12 | +0.93% to +4.26% | +0.48% | Coverage incomplete |

All 126 final-cohort semantic observations passed. Source, package delta, schedules, parser invariants and every expected native-plan admission passed. VNDB's baseline A1 memory observation had a 254.308019 ms covered sampling gap, exceeding the unchanged 250 ms limit. The other three observations qualified. Whole-cohort PSS/private-memory comparisons therefore remain unqualified; this was a coverage failure, not a measured memory-bound failure.

JMdict and VNDB were slower in this cohort. Jitendex was variable and near flat. These results do not support a performance PR. The original native v1 cohort is a different source revision and was not pooled with the corrected cohort.

## All completed cohorts

This table reports paired medians only. Full controls, intervals, equal-work totals, source identities and memory classifications are retained in [checkpoint.json](checkpoint.json) and the final data-only decision receipt.

| Cohort | JMdict | Jitendex | VNDB |
| --- | ---: | ---: | ---: |
| [Plain glossary fast path](https://github.com/ManabiIO/manabitan/actions/runs/46101522659) | +0.88% | +0.19% | +0.79% |
| [Adjacent expression witness](https://github.com/ManabiIO/manabitan/actions/runs/46102205395) | -0.47% | -0.60% | -0.17% |
| [Exact score cache: first screen](https://github.com/ManabiIO/manabitan/actions/runs/46102904843) | +0.39% | +0.46% | -1.39% |
| [Exact score cache: confirmation](https://github.com/ManabiIO/manabitan/actions/runs/46106625456) | -2.94% | +0.67% | +2.18% |
| [Indexed validation: original](https://github.com/ManabiIO/manabitan/actions/runs/46104264150) | -0.82% | -2.44% | -0.98% |
| [Indexed validation: second registration](https://github.com/ManabiIO/manabitan/actions/runs/46105386929) | -2.03% | -0.59% | +2.38% |
| [Native score transport: original](https://github.com/ManabiIO/manabitan/actions/runs/46109112015) | -1.73% | -0.38% | -0.09% |
| [Native score transport: corrected](https://github.com/ManabiIO/manabitan/actions/runs/46116689172) | +3.42% | +0.34% | +2.59% |

The exact-score cache's initial VNDB lead changed from −1.39% to +2.18% in confirmation. Its JMdict confirmation median was −2.94%, but total elapsed import time for equal work was +3.60%, with large opposing pair movements. The apparent Jitendex lead from indexed validation changed from −2.44% to −0.59% in the second cohort, while that cohort's identical-code control median was −1.00%. Every pair was retained; no control subtraction or cross-cohort timing pooling was used.

## What the native experiment established

Native score-plan transport avoided 1,043,222 cumulative owned transport bytes for JMdict, 868,106 for Jitendex and 13,294,580 for VNDB. These are cumulative copy/transport counters, not peak-memory savings.

A separate warmed JMdict field-encoder diagnostic reduced the sum of twelve group medians from 13.4557 ms to 9.2678 ms, approximately 31.1% or 4.19 ms in that component. It did not establish a cold-browser or complete-import speedup. Source-bound diagnostic traces retained visible canonical-plan and content-reference validation work. Samples were not converted to CPU milliseconds.

The full correctness replay covered 204 groups and 7,613,164 rows with exact record and lookup-byte parity. It used production parser/worker options, synthetic private content offsets and captured append I/O. Its scope does not prove browser persistence, full-media timing or peak memory. The original source commits and AST bridge are preserved for review.

## Validation and coverage

[Final product validation](https://github.com/ManabiIO/manabitan/actions/runs/46115635267) passed on the exact final product after a clean checkout and fresh dependency install:

- 674 unit-test files; 15,227 tests passed and 47 skipped.
- All 13 changed JavaScript files passed lint.
- Main, development, test and benchmark TypeScript projects passed.
- All seven dry-build targets passed.

The [benchmark workflow's actionlint](https://github.com/ManabiIO/manabitan/actions/runs/46116689156) also passed. A separate validation-workflow check reported SC1083 for an unquoted Git tree argument. Its one-line quoting fix was published on a lint-only branch. [That ancillary check](https://github.com/ManabiIO/manabitan/actions/runs/46122494974) remained queued at the final recorded check, 2026-11-28 08:27:11 UTC. The original failure is preserved; this report does not claim a universal CI pass.

Across all eight cohorts, independent audits verified 720 semantic browser observations, 180 candidate pairs, 60 identical-code control pairs and 8,463 memory scans. Fifteen dictionary/cohort memory cells passed; nine had incomplete coverage from fourteen scan-gap failures. There were no semantic failures or measured memory-bound failures. Incomplete coverage does not establish memory nonregression. The 78 observations from a separate external comparison and two native diagnostic traces are excluded from these timing cohorts.

## Reproducibility

[README.md](README.md) documents the exact preserved auditors, contracts, retainers, replay tools and historical Git bundle. The bundle preserves eighteen original local commits and seven branch tips beyond the baseline, including the source used for the historical correctness replay. Product source and benchmark definitions were not changed after their studies were registered.

The data-only evidence archive preserves the original snapshot, final raw observations and audit/validation reports. It excludes source code and packaged extensions. Original GitHub artifact ZIPs are required to repeat complete package-byte auditing while they remain available; a later rebuild is not assumed byte-identical to an expired artifact.

No performance PR was opened, and no further measurement run is planned for these candidates.

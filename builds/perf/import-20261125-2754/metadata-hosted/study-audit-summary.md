# JMdict native metadata preflight: independent audit

## Decision

The frozen candidate does not demonstrate a complete-import improvement for JMdict. Every one of its six paired observations is slower than both baseline arms. The non-target Jitendex and VNDB intervals include zero. Memory qualification also remains incomplete because all four observations in VNDB memory replication 2 fail the prospective sampling-coverage requirement. Preserve the candidate and evidence for review; do not describe the component speedup as an import improvement.

No product change, replacement acquisition, cancellation, omitted observation, or rerun was performed during this audit. All nine artifact ZIPs were retained and checked against the provider's byte size and SHA-256 digest.

## Frozen sources and acquisition

| Item | Identity |
| --- | --- |
| Baseline A and identical control C | `7d1643e6147a10cb2165e9744cf0e63b59e46632` |
| Baseline tree | `99d23f16e973c7ae9feba77ca3643d1c27dfb93d` |
| Candidate B | `b2e816c4714f42f87cbb6a1ebc7fe1a2d2fd863b` |
| Candidate tree | `be5b6a8d9c24915516d6edd8167a071e0449d793` |
| Timing workflow run | `45645363685` |
| Memory workflow run | `45645371602` |

The observations remain tied to the frozen preformat candidate above. A subsequent formatting-only publication head and its source CI are separate receipts. The timing screen uses release Chrome, Node 22.22.0, ordinary flags and no tracing. Each corpus has three excluded warmups, six three-arm timing blocks, and two separate exhaustive-media correctness observations: 23 observations per corpus, 69 total, of which 54 are timed. The memory study has two independent cells per corpus, four observations per cell, and 24 observations total.

## Complete-import timing

Negative changes are faster. Percentages are the median of six paired changes, with descriptive 95% bootstrap intervals. They are not calculated by dividing the two standalone medians. A and C are separately acquired copies of the same baseline product.

| Dictionary | A median ms | B median ms | C median ms | B/A paired change [95% interval] | B/C paired change [95% interval] | Faster pairs B/A; B/C |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| JMdict | 896.20 | 913.10 | 897.15 | +1.471% [+0.811%, +10.987%] | +1.724% [+0.570%, +4.450%] | 0/6; 0/6 |
| Jitendex | 1165.05 | 1160.85 | 1150.45 | −0.144% [−5.161%, +6.399%] | −0.679% [−3.532%, +4.731%] | 4/6; 4/6 |
| VNDB | 5511.05 | 5444.85 | 5545.25 | −1.217% [−3.550%, +2.273%] | −1.571% [−5.355%, +0.818%] | 5/6; 5/6 |

The separate control results and tail outcomes are retained; the control drift is not subtracted from the candidate result.

| Dictionary | C/A paired change [95% interval] | B/A equal-work change | B/C equal-work change | Worst B/A pair | Worst B/C pair |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | +0.111% [−1.591%, +7.897%] | +4.453% | +2.222% | +17.657% | +6.421% |
| Jitendex | +0.725% [−4.522%, +4.494%] | +0.261% | +0.109% | +6.680% | +8.352% |
| VNDB | +0.621% [−0.150%, +3.236%] | −0.876% | −2.083% | +5.080% | +1.962% |

The independent auditor reopened all 69 raw reports with the unchanged frozen `benchmark-support.js` validator and recomputed the timing boundary, paired changes, equal-work changes, wins, extremes, and 10,000-sample bootstrap intervals. It reconciled the original schedule, source commits and trees, package hashes, harness identities, runner and storage policy, runtime configuration, semantic receipts, lookup receipts, and storage results. A and C packages are identical. The only four packaged differences between A and B are the database publisher, canonical scanner wrapper, scanner C source, and scanner WASM binary.

All raw timing correctness and identity checks pass. Stable storage totals are 43,520,477 bytes for JMdict, 67,466,332 for Jitendex, and 609,553,611 for VNDB. Separate all-media checks cover zero media for JMdict, all 236 files / 4,992,155 bytes for Jitendex, and all 146,570 files / 188,131,284 bytes for VNDB. Exact media digests and every raw observation are retained in the JSON and CSV receipts.

These are one fixed six-block screen per corpus, with descriptive intervals and no multiple-comparison correction. There is no independent timing replication. No inference of overall speedup is warranted from the non-target point estimates.

## Process-tree memory

The unchanged independent memory auditor checked 2,486 raw scans, marker bytes, process identity and coverage, per-process sums, source and package identity, storage and lookup receipts, and restart correctness. All 24 correctness receipts pass. Twenty observations qualify for the process-tree memory metrics; four do not.

The prospective limit requires every observation in a cell to qualify, with the median paired increase no greater than 5% and the largest paired increase no greater than 10%, for both sampled PSS and sampled private memory. Cells and replications are not pooled.

| Dictionary | Replication | Qualified observations | PSS median / largest pair | Private median / largest pair | Cell memory gate |
| --- | ---: | ---: | ---: | ---: | --- |
| JMdict | 1 | 4/4 | −0.802% / +0.340% | −0.612% / +1.116% | Pass |
| JMdict | 2 | 4/4 | −0.693% / −0.258% | −0.518% / +0.551% | Pass |
| Jitendex | 1 | 4/4 | −0.325% / +0.478% | −0.328% / +0.985% | Pass |
| Jitendex | 2 | 4/4 | −2.115% / +1.125% | −2.595% / +1.235% | Pass |
| VNDB | 1 | 4/4 | +0.673% / +1.237% | +0.939% / +1.415% | Pass |
| VNDB | 2 | 0/4 | Unavailable | Unavailable | Fail: coverage |

Every VNDB replication-2 failure is `covered-import-scan-gap-over-250ms`:

| Observation, in acquisition order | Maximum covered gap ms | Pre-import bracket ms | Post-import bracket ms |
| --- | ---: | ---: | ---: |
| B1 | 318.904967 | 26.825576 | 63.079114 |
| A1 | 252.904922 | 114.578469 | 126.205181 |
| A2 | 276.914989 | 41.615487 | 123.064506 |
| B2 | 379.334888 | 80.348068 | 74.118991 |

The failed cell's PSS and private-memory metrics remain null. Its correctness pass does not repair its coverage failure, and the passing VNDB replication does not replace it. The independent audit status means the raw evidence and reported gate results reconcile; it does not mean the candidate passes the full memory gate. Even qualified maxima are sampled, non-atomic process-tree observations, not instantaneous peaks.

## Source review and component limits

The separate source review found no blocking correctness defect in the read-only native preflight, scratch ownership and reentry, 64-bit bounds checks, JS-owned authoritative publication, fallback, or rollback paths. Its review scope and exact source identity are recorded in `source-review.md`.

The component controls retain the existing contiguous bulk publisher and only disable the new native validator. The component improvement therefore compares native validation with the prior JavaScript validation, not with a forced scalar publication fallback. It is still a publication-only diagnostic. Component groups use fresh owners and immediate persistence; production retains an owner across byte-balanced groups and includes concurrent compression, storage, worker, and UI work.

A separate read-only admission audit found that normal production types, validated persistence metadata, count bounds, arena identity, and released scratch ownership are compatible with native admission. Existing reports do not count native-publication admissions, so an admission rate is not claimed. That audit did not establish a concrete structural fix. Phase timings may improve while the complete-import result remains slower; the complete-import result controls the decision.

## Evidence layout

Original provider metadata, all nine original ZIPs and their download receipts, and extracted artifacts are under `/workspace/scratch/2754d3e3fa09/evidence/metadata-hosted`. `artifact-metadata-final.json` is the final inventory. Each `publication-preflight-screen-<dictionary>-2754` directory contains an independent timing audit and its original `cohort` reports.

This audit directory contains:

- `study-audit-summary.json`: exact metrics, identities, correctness totals, limits, and failed coverage observations.
- `all-timing-observations.csv`: all 69 observations, including excluded warmups and separate correctness observations.
- `all-memory-observations.csv`: all 24 observations, including unqualified observations with null metrics and explicit failure reasons.
- `publication-preflight-memory-*-independent-audit.json` and `memory-audit-results.json`: all six independently recomputed memory results.
- `source-review.md`, exact timing and memory workflows, and audit logs.
- `queue-status.json`: an early historical API snapshot only; it is not the final job status and records no cancellation.

The timing auditor is the unchanged `/tmp/manabitan-2754-timing/audit_cohort.py`. Memory audits use the unchanged scripts under `studies/dev/perf/import-memory-20261124-3aac`, checked byte-for-byte against the copies retained inside the study artifacts. All receipts, harnesses, failed observations and original metadata are intended for the separate durable evidence branch.

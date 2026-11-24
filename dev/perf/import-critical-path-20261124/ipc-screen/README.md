# Shared-span compression IPC study — no import gain established

The frozen candidate passed correctness checks, but **none of the three dictionary cohorts establishes a complete-import improvement**. Keep the candidate frozen as experimental evidence. These results do not justify opening or promoting a performance PR for this implementation.

## Frozen sources and completed protocol

- Baseline A and identical control C: `bbccabd520972cc351a65d9f545bd5369b6e9747`.
- Candidate B: `7d4e4979f9ad0f3ed1d0e61840e6e06212ad63d8`.
- Candidate tree: `29ef86aa6a72b3c14c9429a725a811254a2db46e`.
- Study: `ce10e1782c6aa119d6bb19e5cf109d1fdfe8169d`.
- [Completed workflow run 45470393272](https://github.com/ManabiIO/manabitan/actions/runs/45470393272): all three jobs succeeded on their original attempt.
- Node `22.22.0`, Chromium `153.0.8010.12`, locked complete source archives, production defaults, untraced release builds.

Each dictionary has exactly 23 retained observations: three excluded warmups; six timed blocks in the fixed orders `ABC`, `CBA`, `BCA`, `ACB`, `CAB`, `BAC`; and two excluded exhaustive media diagnostics for A/B. The complete study contains **54 timed imports, nine warmups, and six exhaustive diagnostics**. No observation was replaced or excluded after timing.

The independent audit verifies the frozen source and runner, exact packaged-file scope, byte-identical A/C package members, archive identity, runtime, complete schedule, output/lookup/restart checks, storage bytes, media sample and exhaustive diagnostics, and arithmetic from every retained observation. The only candidate package changes are `js/dictionary/zstd-term-content.js` and `js/dictionary/zstd-term-content-compression-worker.js`. ZIP container bytes may differ because packaging metadata differs; the controls' complete member bytes match.

## Complete-import results

Positive percentages mean the candidate was slower. Paired values compare each B import with its A or C in the same block. Equal-work values compare the sums of all six complete-import durations. Medians are descriptive; these are single-runner exploratory screens, without cross-device qualification or a prespecified non-regression margin.

| Dictionary |        Median A / B / C, ms | Paired B/A | Paired B/C | Control C/A | Equal-work B/A | Equal-work B/C | B faster vs A / C |
| ---------- | --------------------------: | ---------: | ---------: | ----------: | -------------: | -------------: | ----------------: |
| JMdict     |    750.05 / 759.05 / 752.80 |    +1.498% |    +1.219% |     −0.252% |        +0.403% |        +0.836% |         2/6 / 3/6 |
| Jitendex   | 1554.55 / 1568.50 / 1558.45 |    +0.706% |    −0.700% |     +1.196% |        +1.425% |        +0.535% |         1/6 / 4/6 |
| VNDB       | 6416.40 / 6424.25 / 6409.90 |    +0.236% |    +0.404% |     +0.131% |        +1.278% |        +1.371% |         3/6 / 2/6 |

The JMdict block-4 candidate tail (+13.749% against A), Jitendex first-B tail (+5.245% against A, +9.912% against C), and VNDB block-4 candidate tail (+7.041% against A, +7.582% against C) are retained. The causes of individual tails are unproven. Mixed signs and control variation do not support asserting that tiny paired differences are stable regressions; they also provide no basis for an improvement claim. No cohorts are pooled and no cross-host absolute timing comparison is used.

## Output and storage parity

All 69 observations passed the unchanged semantic signature and sampled lexical checks. The separate exhaustive diagnostics compare every expected media file and byte. Storage totals remain identical across every arm and observation:

| Dictionary |  OPFS bytes | Exhaustive media files | Exhaustive media bytes |
| ---------- | ----------: | ---------------------: | ---------------------: |
| JMdict     |  43,520,477 |                      0 |                      0 |
| Jitendex   |  67,466,332 |                    236 |              4,992,155 |
| VNDB       | 609,553,611 |                146,570 |            188,131,284 |

Phase medians in `phase-medians.json` are diagnostic aggregates. They overlap and can include concurrent worker work; they must not be added as a wall-time budget. In particular, the sink's lookup-index encode metric includes prepared parser-worker encode time. These screens make no peak-memory claim.

## Durable evidence

`index.json` maps each deterministic `.tar.xz` archive to its original GitHub artifact, exact frozen sources, byte size and SHA-256. Each adjacent manifest records a SHA-256 and byte count for every retained member. Original ZIP digests were checked before extraction; archived members were compared byte-for-byte with the original ZIP and re-read after compression. Every observation result and raw JSON phase report is retained unchanged. Redundant HTML views, console output and progress snapshots remain in the original artifact ZIP.

`audit.json` contains the independent passing audit for all three archived cohorts. `workflow-run.json` and `workflow-jobs.json` retain completion receipts. The shared `audit_screens.py`, `bundle_evidence.py`, `extract_screen_phases.py`, and `frozen-studies.json` reproduce the audit and summaries from the retained material. Correctness validation receipts are separate from this timing evidence and do not convert a neutral timing result into a speedup.

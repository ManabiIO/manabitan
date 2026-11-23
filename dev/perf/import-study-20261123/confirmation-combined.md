# Combined source-CRC and index-I/O confirmation audit

## Decision

**The frozen combined candidate meets the predeclared confirmation requirements in both independent replications.** VNDB paired medians improve by 26.35%/27.41% against A/C in replication 1 and 6.26%/5.80% in replication 2. Each replication improves both equal-work totals and is faster in all six pairs against each control. No corpus or replication reaches the 5% paired-median regression screen. All provenance, integrity, activation, and queue checks pass.

The magnitude depends strongly on the runner cohort. The result supports the stated fixed-fixture qualification; it does not support advertising a universal 26% improvement. JMdict and Jitendex remain below the materiality threshold for a speedup. Their tails and small timing differences are retained below, including JMdict replication 1’s +3.49%/+1.91% equal-work cost.

The independently reviewed auditor emits `REVIEW_REQUIRED` after a numerical pass so that control spread, equal-work costs, and tails still receive review. This report records that review. Target control medians are +0.42% and +0.69%; both target replications improve against both identical-code controls without drift subtraction, pooling, tail removal, retries, or schedule extension.

## Frozen inputs and method

- Confirmation run: [45130250310](https://github.com/ManabiIO/manabitan/actions/runs/45130250310); API run metadata, all artifact names, and all cell plans identify attempt 1. Plan and all six jobs succeeded.
- Confirmation study: `8f4a5a5e25315369a0e8344c33f8fdee7c28fcf6`. Discovery study: `a492044455d200df593fe152638cc1383efa0dde`, run [45129037078](https://github.com/ManabiIO/manabitan/actions/runs/45129037078).
- Baseline A/C: `5e1f8c12f7ff798ba407323aff675cb23b22af02`. Combined candidate B: `958099525e6017c9faa3d912168da51575527b7d`, tree `ddf70903a004965361c9ab58a1f1e434c47edd01`.
- The candidate combines the large-raw-source I/O worker with source-CRC reuse. The runtime is unchanged between discovery and confirmation. Only `config.json` stage and discovery-reference fields changed in the study.
- Chromium `153.0.8010.12`, Node `22.22.0`, production Chrome packages, strict runtime settings, no experimental import flags or tracing.
- Audit guard commit: `d7adf824c51234e623df8c6579ef2352b6d54376`, committed before opening the first result. Auditor SHA-256: `23b55c5e739ed2fb5a7cdbc1f9d3e5a69b59ee48690f90209a0e5626552d5c60`. An independent reviewer checked the guards before retrieval.

The [predeclared method](README.md) uses three excluded warmups followed by six fixed triplets per cell. Replication 1 uses warmups ABC and measured orders ABC, CBA, BCA, ACB, CAB, BAC. Replication 2 uses warmups CBA and the reverse measured order: BAC, CAB, ACB, BCA, CBA, ABC. Each corpus has two independent jobs, giving 126 ordinary imports: 108 measured and 18 pre-excluded warmups.

The authoritative interval starts at browser file-input change and ends at completed import UI. Builds, downloads, source-reference derivation, readback, and restart are outside timing. A benefiting corpus must independently improve its paired median by at least 5% against A and C in each replication, improve both equal-work totals, and be faster in at least five of six pairs against each. Other corpora must retain no material regression. No replication is pooled to rescue a failing gate.

## Primary results

Negative changes mean the candidate completed sooner. Equal-work comparisons use sums within one replication. All percentage changes are independently recomputed from raw browser timestamps and match the frozen verifier; the [receipt](confirmation-combined.json) retains every observation and calculation.

| Corpus   | Replication | Median B/A | Median B/C | Equal-work B/A | Equal-work B/C | Faster B/A; B/C | Control median C/A |
| -------- | ----------: | ---------: | ---------: | -------------: | -------------: | --------------: | -----------------: |
| JMdict   |           1 |     +1.07% |     +0.42% |         +3.49% |         +1.91% |        2/6; 3/6 |             +1.27% |
| JMdict   |           2 |     -0.93% |     -0.78% |         -2.11% |         -0.16% |        4/6; 4/6 |             -1.22% |
| Jitendex |           1 |     -2.55% |     -1.46% |         -3.91% |         -1.17% |        4/6; 5/6 |             -0.28% |
| Jitendex |           2 |     -0.39% |     -3.04% |         -2.87% |         -1.60% |        3/6; 4/6 |             +1.76% |
| VNDB     |           1 |    -26.35% |    -27.41% |        -26.33% |        -26.22% |        6/6; 6/6 |             +0.42% |
| VNDB     |           2 |     -6.26% |     -5.80% |         -6.35% |         -6.82% |        6/6; 6/6 |             +0.69% |

## Controls and retained tails

| Corpus   | Replication | Control C/A minimum | Control C/A maximum | Control equal-work C/A |
| -------- | ----------: | ------------------: | ------------------: | ---------------------: |
| JMdict   |           1 |             -10.33% |             +16.84% |                 +1.55% |
| JMdict   |           2 |             -10.28% |              +4.48% |                 -1.95% |
| Jitendex |           1 |             -14.96% |              +2.28% |                 -2.77% |
| Jitendex |           2 |             -16.42% |              +7.53% |                 -1.30% |
| VNDB     |           1 |              -5.64% |              +4.63% |                 -0.15% |
| VNDB     |           2 |              -3.28% |              +3.46% |                 +0.50% |

JMdict replication 1 retains B1=1216.9 ms, alongside C2=1129.1 ms and A4=1057.4 ms. B1 spends 1120 ms in data processing and 29 ms in finalization; its record-close region is 8.4 ms. Its delay is not the record-close tail observed in the preceding gated-I/O discovery. Replication 2 retains A3=1069.8 ms. Neither the new I/O worker nor the new CRC-reuse counters activate for these smaller imports.

Jitendex retains A4=2165.8 ms in replication 1 and A5=2243.2 ms in replication 2; these baseline tails contribute to its more favorable equal-work changes. Replication 2 also retains B3=1947.3 ms. Those observations remain in every calculation. The small-corpus findings establish compliance with the predeclared regression screen, not exact performance equivalence or a material speedup.

## All 126 acquired durations

Values are milliseconds. Every warmup and measured observation is shown; acquisition order is retained for each triplet.

| Corpus   | Replication | Cohort    | Order |      A |      B |      C |
| -------- | ----------: | --------- | ----- | -----: | -----: | -----: |
| JMdict   |           1 | Warmup    | ABC   | 1124.4 |  956.0 |  963.4 |
| JMdict   |           1 | Triplet 1 | ABC   |  951.3 | 1216.9 |  951.8 |
| JMdict   |           1 | Triplet 2 | CBA   |  966.4 |  955.0 | 1129.1 |
| JMdict   |           1 | Triplet 3 | BCA   |  958.2 |  981.0 |  946.6 |
| JMdict   |           1 | Triplet 4 | ACB   | 1057.4 |  963.7 |  948.2 |
| JMdict   |           1 | Triplet 5 | CAB   |  941.3 |  958.1 |  965.7 |
| JMdict   |           1 | Triplet 6 | BAC   |  946.4 |  949.7 |  970.0 |
| JMdict   |           2 | Warmup    | CBA   |  941.4 |  934.8 | 1143.5 |
| JMdict   |           2 | Triplet 1 | BAC   |  976.9 |  961.4 |  945.7 |
| JMdict   |           2 | Triplet 2 | CAB   |  992.3 |  944.7 |  956.6 |
| JMdict   |           2 | Triplet 3 | ACB   | 1069.8 |  946.9 |  959.8 |
| JMdict   |           2 | Triplet 4 | BCA   |  953.4 |  950.8 |  960.6 |
| JMdict   |           2 | Triplet 5 | CBA   |  934.3 |  971.0 |  976.2 |
| JMdict   |           2 | Triplet 6 | ABC   |  954.3 |  981.9 |  967.2 |
| Jitendex |           1 | Warmup    | ABC   | 1892.2 | 1818.4 | 1854.2 |
| Jitendex |           1 | Triplet 1 | ABC   | 1845.3 | 1885.6 | 1851.6 |
| Jitendex |           1 | Triplet 2 | CBA   | 1900.0 | 1850.7 | 1903.5 |
| Jitendex |           1 | Triplet 3 | BCA   | 1874.7 | 1815.6 | 1860.8 |
| Jitendex |           1 | Triplet 4 | ACB   | 2165.8 | 1825.8 | 1841.9 |
| Jitendex |           1 | Triplet 5 | CAB   | 1878.8 | 1882.2 | 1921.7 |
| Jitendex |           1 | Triplet 6 | BAC   | 1904.8 | 1856.9 | 1868.9 |
| Jitendex |           2 | Warmup    | CBA   | 1868.3 | 1823.2 | 2152.7 |
| Jitendex |           2 | Triplet 1 | BAC   | 1869.7 | 1827.6 | 1892.7 |
| Jitendex |           2 | Triplet 2 | CAB   | 1858.7 | 1803.7 | 1907.2 |
| Jitendex |           2 | Triplet 3 | ACB   | 1836.4 | 1947.3 | 1809.1 |
| Jitendex |           2 | Triplet 4 | BCA   | 1792.0 | 1818.5 | 1926.9 |
| Jitendex |           2 | Triplet 5 | CBA   | 2243.2 | 1825.2 | 1874.8 |
| Jitendex |           2 | Triplet 6 | ABC   | 1809.4 | 1859.2 | 1850.7 |
| VNDB     |           1 | Warmup    | ABC   | 7843.1 | 5710.1 | 7411.8 |
| VNDB     |           1 | Triplet 1 | ABC   | 7266.4 | 5342.4 | 7387.5 |
| VNDB     |           1 | Triplet 2 | CBA   | 7696.4 | 5810.5 | 7262.2 |
| VNDB     |           1 | Triplet 3 | BCA   | 7002.1 | 5165.4 | 7089.8 |
| VNDB     |           1 | Triplet 4 | ACB   | 6963.0 | 5071.4 | 6830.2 |
| VNDB     |           1 | Triplet 5 | CAB   | 7034.6 | 4996.5 | 7005.1 |
| VNDB     |           1 | Triplet 6 | BAC   | 7021.8 | 5279.6 | 7347.0 |
| VNDB     |           2 | Warmup    | CBA   | 6201.9 | 5208.8 | 6063.8 |
| VNDB     |           2 | Triplet 1 | BAC   | 5531.1 | 5327.7 | 5722.2 |
| VNDB     |           2 | Triplet 2 | CAB   | 5640.5 | 5265.7 | 5587.8 |
| VNDB     |           2 | Triplet 3 | ACB   | 5812.5 | 5293.2 | 5621.6 |
| VNDB     |           2 | Triplet 4 | BCA   | 5664.9 | 5144.5 | 5822.4 |
| VNDB     |           2 | Triplet 5 | CBA   | 5502.1 | 5305.3 | 5629.7 |
| VNDB     |           2 | Triplet 6 | ABC   | 5360.6 | 5046.0 | 5295.7 |

## VNDB phase diagnosis within each replication

These are medians of six measured observations per arm, in milliseconds. Diagnostic regions can overlap. The source-CRC time is nested in parse-bank time and must not be added to it. The record-close region includes final pending writes, header work, flushing, and closing; it is not isolated kernel-close latency.

| Replication | Metric                      |       A |       B |       C |
| ----------: | --------------------------- | ------: | ------: | ------: |
|           1 | Completed import            | 7028.20 | 5222.50 | 7176.00 |
|           1 | Import data banks           | 4874.00 | 4962.00 | 4994.50 |
|           1 | Bulk finalization           | 1966.50 |   61.00 | 1970.50 |
|           1 | Record-close region         | 1948.45 |   41.20 | 1954.80 |
|           1 | Record queued-write await   |    2.60 |    1.20 |    0.80 |
|           1 | Index write await           |    0.20 |    1.05 |    0.15 |
|           1 | Source inflate region       | 2386.45 |  601.65 | 2424.30 |
|           1 | Parse-bank region           | 3724.50 | 5302.00 | 3690.50 |
|           1 | Source CRC, nested in parse |  absent | 1416.55 |  absent |
|           2 | Completed import            | 5585.80 | 5279.45 | 5625.65 |
|           2 | Import data banks           | 5228.50 | 5033.50 | 5301.00 |
|           2 | Bulk finalization           |  131.00 |   23.00 |  124.50 |
|           2 | Record-close region         |  118.45 |    9.35 |  113.00 |
|           2 | Record queued-write await   |    0.60 |    1.85 |    0.70 |
|           2 | Index write await           |    0.30 |    0.70 |    0.20 |
|           2 | Source inflate region       | 3880.60 |  870.80 | 3939.35 |
|           2 | Parse-bank region           | 4139.50 | 5492.00 | 4210.50 |
|           2 | Source CRC, nested in parse |  absent | 1137.95 |  absent |

Replication 1 has baseline record-close medians near 1.95 seconds, versus 41.2 ms for B. Replication 2 has baseline record-close medians near 113–118 ms, versus 9.35 ms for B. Both show complete-import gains. These observations are consistent with a larger opportunity to overlap persistence in replication 1, but the phase counters do not isolate every scheduling or persistence cause. One percentage cannot represent both cohorts, and prior component-study timings are not pooled into these results.

## Activation, byte coverage, and queue bounds

The source eligibility rule admits the I/O worker only for at least 1 GiB of selected raw term banks, with the existing 2 MiB initial queued-index boundary. Every candidate activation counter, including warmups, matches the frozen configuration. Below, the seven counter values are ordered warmup-B, B1, B2, B3, B4, B5, B6.

| Corpus   | Replication | All B worker-file counts | Largest reported index queue, bytes |
| -------- | ----------: | ------------------------ | ----------------------------------: |
| JMdict   |           1 | `[0, 0, 0, 0, 0, 0, 0]`  |                           6,284,044 |
| JMdict   |           2 | `[0, 0, 0, 0, 0, 0, 0]`  |                           6,284,044 |
| Jitendex |           1 | `[0, 0, 0, 0, 0, 0, 0]`  |                           5,175,076 |
| Jitendex |           2 | `[0, 0, 0, 0, 0, 0, 0]`  |                           5,175,076 |
| VNDB     |           1 | `[2, 2, 2, 2, 2, 2, 2]`  |                          24,469,016 |
| VNDB     |           2 | `[2, 2, 2, 2, 2, 2, 2]`  |                          18,276,088 |

All 14 VNDB candidate observations have the same raw-source verification counts: 568,284,368 scanned bytes plus 3,699,708,599 reused bytes cover all 4,267,992,967 bytes across 665 source banks. Each reports 6,490,145 verified raw-equality glossary witnesses. JMdict/Jitendex candidate counters remain zero, retaining the ordinary CRC path. Legacy baseline CRC/worker counters remain absent (`null`); the baseline package lacks the new modules, which is structural evidence rather than an invented measured zero.

| Corpus   | Raw-source bytes | Index write calls, every observation | Index chunk bytes, every observation |
| -------- | ---------------: | -----------------------------------: | -----------------------------------: |
| JMdict   |      171,092,992 |                                    5 |                           23,693,336 |
| Jitendex |      537,538,792 |                                    6 |                           23,526,384 |
| VNDB     |    4,267,992,967 |                                   83 |                          401,899,752 |

Those calls and byte totals are unchanged across all 42 observations of each corpus; chunk-byte counters exclude headers. The largest reported index queue is 24,469,016 bytes, below 24 MiB (25,165,824 bytes). The receipt retains every queue observation. This describes queued payload in these imports, not total memory or peak RSS.

## Correctness, provenance, and original artifacts

All 126 imports pass the frozen verifier, including 252 before/after-restart states, 3,024 complete sampled public lookup responses, and 20,244 image-byte probes. The image checks comprise all 236 referenced Jitendex images in every applicable state and five VNDB probes per state. Original Jitendex references are independently rederived from every term bank; 4,992,155 unique source image bytes are checked. The five VNDB source images total 4,550 bytes. Lookup readback remains sampled, and VNDB image readback is not exhaustive.

There are zero cross-arm physical layout differences. Complete semantic digests agree across both replications. Full A/B package-member maps agree across all six cells and contain exactly the frozen 11 product differences. Every source hash matches the frozen confirmation study. Measurement code, dependencies, and fixture locks also match discovery; the declared stage and discovery-reference changes are confined to configuration. Fixture bytes match their lock. All 1,068 files in the six original ZIPs match their safely extracted bytes. The completed API run receipt independently confirms the run/head and first attempt.

| Original archive                        | GitHub artifact |   Bytes | SHA-256                                                            |
| --------------------------------------- | --------------: | ------: | ------------------------------------------------------------------ |
| `import-study-jmdict-1-attempt-1.zip`   |     14796879930 | 1277336 | `ad114b23b3131ad144a266eeac45b26c3856301cda6f0c67720635caf6725174` |
| `import-study-jmdict-2-attempt-1.zip`   |     14797941343 | 1276839 | `490d20179ef13f4009e1e2d02008d41e38cecf5c472025e4c4ac0966a900d23b` |
| `import-study-jitendex-1-attempt-1.zip` |     14797427604 | 2958380 | `d2f3a3ff8b15e1ff34b64729f3a05a6d61fe59a51f20d6a4717a65b9842cc0a0` |
| `import-study-jitendex-2-attempt-1.zip` |     14797073469 | 2958863 | `c358ac04d342e948cbe2c993c7522a86c590ca91c806eaddb9572f8a422b5f57` |
| `import-study-vndb-1-attempt-1.zip`     |     14797728315 | 1410529 | `fface984a1512e878fc678b5c43ef439f1fe71a567de231e04cd3f87a1e9b59c` |
| `import-study-vndb-2-attempt-1.zip`     |     14797916520 | 1409171 | `9edbeb44571673ff051622dddadffa0a233af637f52899a655873bebe501c4f4` |

The [machine-readable receipt](confirmation-combined.json) retains every raw duration, paired statistic, phase value, CRC/worker counter, queue observation, source identity, and report/summary hash. Original ZIPs, extracted reports, GitHub run/job metadata, and the audit log remain in `bench-tools/round2-combined-confirmation`. No browser import was rerun, replaced, dropped, or added. Earlier rejected and held campaigns remain unchanged.

Reproduce the read-only audit into a new receipt path:

```sh
python3 dev/perf/import-study-20261123/audit_combined_confirmation.py ARTIFACT_DIRECTORY \
  --run 45130250310 \
  --harness 8f4a5a5e25315369a0e8344c33f8fdee7c28fcf6 \
  --node /path/to/node-22.22.0 --fixtures FIXTURE_DIRECTORY \
  --output NEW_RECEIPT.json
```

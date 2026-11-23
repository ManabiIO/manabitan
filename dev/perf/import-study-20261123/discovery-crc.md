# Source CRC reuse: discovery audit

## Decision

Advance this candidate to the two predeclared independent confirmation campaigns. VNDB meets the discovery threshold against both identical-code controls, with all three pairs faster against each. JMdict and Jitendex show no material regression in this screen.

This is a promising discovery result, not production qualification. The VNDB median against C is −5.02%, only just beyond the −5% threshold. Every warmup, measured observation, and control tail remains in the evidence. Confirmation must use the frozen candidate and both complete fixed schedules; the existing three pairs do not justify a precise general speedup claim.

## Frozen inputs and audit

- Workflow: [45122637633](https://github.com/ManabiIO/manabitan/actions/runs/45122637633), all three corpus jobs successful on their first attempt.
- Harness: `da8ebb76ebbdd6d19a1784631069ebe25aeb75cf`.
- Identical A/C baseline: `5e1f8c12f7ff798ba407323aff675cb23b22af02`.
- Candidate B: `0d5a05c40410fd97b0b85a2ad5e432dc5507bb33`.
- Chromium `153.0.8010.12`, Node `22.22.0`, production Chrome packages, strict runtime settings, no experimental import flags, no tracing.

The [predeclared method](README.md) uses warmups A, B, C followed by the fixed measured schedule ABC, BCA, CAB. The authoritative time runs from the browser file-input change through the completed import UI; readback and browser restart happen afterward. Discovery requires at least 5% median improvement against both controls, improving equal-work totals, and at least two faster pairs against each, with no unresolved material regression elsewhere.

The independent audit downloaded each original archive, verified its GitHub-reported SHA-256 and size, rejected unsafe or duplicate paths and symlink entries, and preserved the originals. All 345 extracted files match their ZIP members. The frozen verifier reproduced every original result exactly. Archived harness source hashes also match the pinned Git commit. Separate Python arithmetic reproduced each raw browser duration and every paired primary statistic. No import was rerun, removed, or replaced.

## Primary results

Negative changes mean B completed sooner. Equal-work changes compare the sums of the same three imports. Controls are reported separately and are never subtracted from the candidate measurements.

| Corpus   | Median B/A | Median B/C | Equal-work B/A | Equal-work B/C | Faster B/A; B/C | Median control C/A |
| -------- | ---------: | ---------: | -------------: | -------------: | --------------: | -----------------: |
| JMdict   |     −1.42% |     −0.02% |         −1.08% |         −0.71% |        2/3; 2/3 |             −1.56% |
| Jitendex |     +0.56% |     −0.34% |         −0.73% |         +0.58% |        1/3; 2/3 |             +1.48% |
| VNDB     |     −6.13% |     −5.02% |         −7.05% |         −5.85% |        3/3; 3/3 |             +0.70% |

VNDB's individual B/C changes are −5.02%, −4.48%, and −8.08%. Its A1 control is relatively slow; the paired C/A changes are −6.20%, +0.70%, and +2.12%. Jitendex also retains its third-pair C/A change of −6.76%. These observations remain part of the result and are a reason to require independent confirmation.

## All acquired durations

Values are milliseconds. Warmups are retained and were excluded from performance estimates before acquisition.

| Corpus   | Cohort    | Acquisition order |      A |      B |      C |
| -------- | --------- | ----------------- | -----: | -----: | -----: |
| JMdict   | Warmup    | ABC               | 1153.8 | 1185.7 |  952.7 |
| JMdict   | Triplet 1 | ABC               |  956.6 |  961.9 |  983.5 |
| JMdict   | Triplet 2 | BCA               |  952.9 |  939.4 |  938.0 |
| JMdict   | Triplet 3 | CAB               |  978.8 |  955.7 |  955.9 |
| Jitendex | Warmup    | ABC               | 1557.4 | 1341.2 | 1388.8 |
| Jitendex | Triplet 1 | ABC               | 1313.9 | 1331.7 | 1336.3 |
| Jitendex | Triplet 2 | BCA               | 1333.8 | 1341.3 | 1353.5 |
| Jitendex | Triplet 3 | CAB               | 1409.3 | 1354.3 | 1314.1 |
| VNDB     | Warmup    | ABC               | 7415.2 | 5302.1 | 5948.7 |
| VNDB     | Triplet 1 | ABC               | 6036.5 | 5377.8 | 5662.2 |
| VNDB     | Triplet 2 | BCA               | 5626.7 | 5412.6 | 5666.3 |
| VNDB     | Triplet 3 | CAB               | 5502.8 | 5165.5 | 5619.5 |

## Activation and mechanism

The deferred source-CRC reuse path runs in every VNDB candidate observation, including the warmup. Each reports exactly 568,284,368 scanned bytes and 3,699,708,599 reused bytes. Their sum equals all **4,267,992,967 original term-bank bytes** across 665 ZIP entries. The 6,490,145 raw-glossary witnesses and both byte counts are identical across the four candidate imports. Reused bytes account for 86.685% of the source. They still undergo the parser's raw-byte equality proof; this percentage is not a prediction of total import speedup.

JMdict and Jitendex candidate observations report zero deferred-CRC counters, as expected for their eligibility. They retain ordinary CRC verification. The baseline does not export these new counters; the audit records them as absent, not zero.

VNDB phase medians illustrate where the work changed. Parser timings accumulate work across parallel workers and must not be treated as serial components of elapsed import time. Source-CRC time is nested within parse-bank time.

| VNDB metric, milliseconds                             |      A |      B |      C |
| ----------------------------------------------------- | -----: | -----: | -----: |
| Source inflation, including ordinary CRC when enabled | 3874.7 |  893.3 | 3870.9 |
| Parse bank                                            | 4169.0 | 5458.0 | 4232.0 |
| Deferred source CRC, contained in parse bank          | Absent | 1151.9 | Absent |
| Parallel parser pipeline wall time                    | 5196.0 | 4945.9 | 5244.3 |
| Import data banks                                     | 5267.0 | 5022.0 | 5312.0 |
| Bulk finalization                                     |  133.0 |  126.0 |  127.0 |
| Record-close region, contained in finalization        |  119.5 |  116.2 |  112.4 |

The reduction in inflation work is partly replaced by the fused verifier's work inside parsing; the authoritative completed-import result is the performance measure. Absolute times must not be pooled with the earlier flushing discovery: even baseline VNDB record-close medians differ substantially between runner cohorts. This audit makes no peak-memory claim.

## Semantic and media verification

All 36 ordinary imports passed: 27 measured imports plus nine warmups, 72 before/after-restart states, and 864 complete public exact-lookup responses for 12 deterministic source terms per state. All cross-arm physical layout differences are zero. The verifier also checks source/package identities, complete sampled response equality, counts, readable physical spans, and restart persistence. This is complete response comparison for sampled terms, not exhaustive lookup of every term.

Jitendex passed byte length, MIME, and SHA-256 checks for all **236 referenced images** before and after restart in every observation. The independent audit traversed every original term bank to rederive the complete image-reference set and hashed the original 4,992,155 image bytes. Thirteen unreferenced SVG files are outside that imported image set. VNDB passed its five source-media probes totaling 4,550 bytes. Altogether, **5,784 persisted media byte probes** were checked: 5,664 Jitendex probes and 120 VNDB probes.

| Original archive                        | GitHub artifact |   Bytes | SHA-256                                                            |
| --------------------------------------- | --------------: | ------: | ------------------------------------------------------------------ |
| `import-study-jmdict-1-attempt-1.zip`   |     14794441685 |  831888 | `609c1798a38cee52e73cc0df712428d492884c1a94e191f4a72936334ed36d27` |
| `import-study-jitendex-1-attempt-1.zip` |     14794248099 | 1798543 | `38d950e5ddb62e4eed46e1bfdceef423e9ffa46fdae9c5b1578e17fc68ca86ec` |
| `import-study-vndb-1-attempt-1.zip`     |     14794033098 |  907791 | `a3ece35b31639f74632eaec01b1c64a46ffe83f55eefe58d9b9de3471c19f517` |

The [compact receipt](discovery-crc.json) retains all observations, source-CRC diagnostics, paired results, original archive identities, and raw report/summary hashes. To reproduce against the retained artifacts and locked source fixtures:

```sh
python3 dev/perf/import-study-20261123/audit_crc_discovery.py ARTIFACT_DIRECTORY \
  --node /path/to/node-22.22.0 --fixtures FIXTURE_DIRECTORY
```

The next gate consists of two independent confirmation campaigns, each retaining all three corpora, three warmups, and six fixed balanced triplets. Promotion requires both campaigns to satisfy the predeclared materiality and direction criteria without unresolved material regressions. This discovery does not replace either confirmation.

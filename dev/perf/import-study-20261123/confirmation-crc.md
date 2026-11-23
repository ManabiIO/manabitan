# Source CRC reuse: independent confirmation audit

## Decision: HOLD

The frozen source-CRC candidate does not meet the predeclared whole-import materiality gate. Both independent VNDB replications fall below the required 5% median improvement against both controls. Their direction criteria pass, all correctness checks pass, and neither JMdict nor Jitendex shows a 5% median-regression screen. Those findings do not replace the materiality requirement.

Retain this completed study as **HOLD**. Do not retry or extend the fixed campaign, remove tails, pool replications to rescue the gate, or present improvements in parser components as a qualified whole-import gain. The earlier promising discovery remains retained with its original decision; this confirmation supersedes its provisional promotion status.

## Frozen inputs and fixed method

- Confirmation workflow: [45123577232](https://github.com/ManabiIO/manabitan/actions/runs/45123577232). All six corpus/replication jobs and the plan job succeeded on attempt 1.
- Harness: `66920c41491347811cb917d41e4614339fd95dcc`.
- Candidate B: `0d5a05c40410fd97b0b85a2ad5e432dc5507bb33`.
- Identical A/C baseline: `5e1f8c12f7ff798ba407323aff675cb23b22af02`.
- Discovery being confirmed: [45122637633](https://github.com/ManabiIO/manabitan/actions/runs/45122637633).
- Chromium `153.0.8010.12`, Node `22.22.0`, production Chrome packages, strict runtime settings, no experimental import flags, no tracing.

The [predeclared method](README.md) uses separate jobs for each replication and corpus. Replication 1 excludes warmups ABC, then measures ABC, CBA, BCA, ACB, CAB, BAC. Replication 2 excludes warmups CBA, then measures BAC, CAB, ACB, BCA, CBA, ABC. Each job therefore retains 21 ordinary imports: three warmups and 18 measured imports. The two replications together retain **126 imports**, of which **108 are measured** and **18 are predeclared warmups**.

Each target replication must independently show at least 5% median paired improvement against both A and C, improving equal-work totals, and at least five of six faster pairs against each. Material regressions elsewhere prevent promotion. Authoritative duration runs from browser file-input change through completed import UI; semantic readback and browser restart occur afterward.

## Per-replication results

Negative changes mean B completed sooner. Equal-work comparisons use the sum of the same six complete imports. No control subtraction or cross-replication pooling is applied.

| Corpus   | Replication | Median B/A | Median B/C | Equal-work B/A | Equal-work B/C | Faster B/A; B/C | Median control C/A |
| -------- | ----------: | ---------: | ---------: | -------------: | -------------: | --------------: | -----------------: |
| JMdict   |           1 |     −0.93% |     −1.78% |         −0.03% |         −1.53% |        4/6; 5/6 |             +1.41% |
| JMdict   |           2 |     +0.24% |     +2.19% |         +0.19% |         +1.21% |        3/6; 1/6 |             −1.17% |
| Jitendex |           1 |     −0.96% |     +1.13% |         −1.45% |         −0.26% |        6/6; 1/6 |             −2.25% |
| Jitendex |           2 |     +0.96% |     +0.58% |         +0.36% |         +0.93% |        2/6; 3/6 |             −0.80% |
| VNDB     |           1 | **−4.28%** | **−3.69%** |         −3.59% |         −4.62% |        5/6; 5/6 |             +0.65% |
| VNDB     |           2 | **−4.83%** | **−1.14%** |         −5.03% |         −1.69% |        6/6; 5/6 |             −2.68% |

VNDB replication 2's −5.03% equal-work result against A does not rescue its paired median or its C comparison. Likewise, consistent direction does not establish the required size of improvement. The smaller corpora's medians remain below the material-regression threshold in both jobs; this limited sample is not a proof of universal non-regression.

### Target controls and tails

| VNDB replication | Minimum C/A | Median C/A | Maximum C/A | Equal-work C/A |
| ---------------- | ----------: | ---------: | ----------: | -------------: |
| 1                |      −3.69% |     +0.65% |      +6.07% |         +1.08% |
| 2                |      −9.17% |     −2.68% |      +0.40% |         −3.39% |

Replication 2's first A observation is 9907.2 ms while its matching C is 8999.0 ms. Both remain. Replication 1 also retains C5 at 9846.9 ms and all other control variation. The receipt preserves every individual paired change, including candidate-slower pairs. No observation is excluded because of its measured value.

## Activation and phase evidence

All **14 VNDB B observations**, including both warmups, report identical source-CRC counters: **568,284,368 scanned bytes**, **3,699,708,599 reused bytes**, and **6,490,145 raw-glossary witnesses**. Scanned plus reused bytes exactly equal all **4,267,992,967 original term-bank bytes** across 665 ZIP entries. The reuse path therefore ran throughout both confirmation jobs.

JMdict and Jitendex candidate counters remain zero for the deferred reuse path and retain ordinary CRC verification. Baseline binaries do not export the new counters; absent values remain null in the receipt. Raw-glossary CRC reuse is not inferred from canonical content equality.

VNDB phase medians below illustrate why component improvements are insufficient to claim the required completed-import gain. Parser metrics accumulate work across parallel workers; they cannot be summed as independent elapsed-time stages. Source-CRC time is already contained within parse-bank time.

| Replication | Metric, milliseconds                                  |      A |      B |      C |
| ----------- | ----------------------------------------------------- | -----: | -----: | -----: |
| 1           | Source inflation, including ordinary CRC when enabled | 5033.3 | 1416.3 | 4985.6 |
| 1           | Parse bank                                            | 6345.5 | 7655.0 | 6259.5 |
| 1           | Deferred source CRC, contained in parse bank          | Absent | 1298.3 | Absent |
| 1           | Import data banks                                     | 7215.0 | 6784.5 | 7273.5 |
| 1           | Bulk finalization                                     | 1737.0 | 1946.5 | 1843.0 |
| 1           | Completed import                                      | 9349.1 | 9066.0 | 9452.1 |
| 2           | Source inflation, including ordinary CRC when enabled | 4959.8 | 1252.4 | 4939.4 |
| 2           | Parse bank                                            | 7368.0 | 9522.5 | 6979.0 |
| 2           | Deferred source CRC, contained in parse bank          | Absent | 2075.8 | Absent |
| 2           | Import data banks                                     | 8182.0 | 7769.5 | 7957.0 |
| 2           | Bulk finalization                                     |  703.5 |  703.0 |  712.0 |
| 2           | Completed import                                      | 9182.7 | 8780.9 | 8970.8 |

These are diagnostics within each replication. Absolute timings are not pooled across jobs or with discovery. The study makes no peak-memory claim.

## Independent correctness and provenance audit

All six original ZIPs match GitHub's reported SHA-256 and byte sizes. Extraction rejects unsafe paths, duplicate names, and symlink entries. All **1,068 original archive members** match their extracted copies exactly. Source and timing-harness hashes match the pinned Git commit; source dictionary archives match their locked identities. The frozen verifier reproduces every original receipt exactly, and separate Python arithmetic recomputes raw browser durations, all six-pair comparisons, control ranges, and the unchanged qualification gate.

All **252 before/after-restart states** and **3,024 complete sampled public lookup responses** pass. Semantic digests agree across both replications for each corpus, and all cross-arm physical layout differences are zero. This is complete response comparison for 12 deterministic source terms per state, not exhaustive lookup of every imported term.

The audit independently rederived Jitendex's full set of **236 referenced images** from every original term bank and hashed all **4,992,155 source image bytes**. The five VNDB source-media references total **4,550 bytes**. Each is checked before and after restart in every applicable observation: **19,824 Jitendex media probes** and **420 VNDB probes**, totaling **20,244 byte probes**.

| Corpus   | Replication | GitHub artifact | ZIP bytes | SHA-256                                                            |
| -------- | ----------: | --------------: | --------: | ------------------------------------------------------------------ |
| JMdict   |           1 |     14794194974 |   1276250 | `bd7e3ab6ef57b84e2313b341fb3d3266bbbd673aca65117f4ddab26c5e7f39ac` |
| JMdict   |           2 |     14795205481 |   1276194 | `a6e52c20eabcfa6ba5b14b7dc85e92b21f23f92132d46272e96102ac46eb069d` |
| Jitendex |           1 |     14795595538 |   2956356 | `c2d6973e0fa39f070b6c7108d8a9245090564a57c1020882e3c5163ce6dc7a16` |
| Jitendex |           2 |     14794674192 |   2958207 | `19daf97d12cd8d605daa528d945b5024313379f16ccbc9422fd34a3787bd966f` |
| VNDB     |           1 |     14795211959 |   1411132 | `2bcb913a8aa03b3f7f86a2562511a7590e058505418cee59e1b0197e9794a45f` |
| VNDB     |           2 |     14794918728 |   1411508 | `b3ce765ddf73da428475ff1364905e83a9a93fa9da934d506920273d793acf8e` |

## All acquired durations

Values are milliseconds, rounded only for display. Exact raw timestamp differences, source diagnostics, and report/summary hashes remain in [confirmation-crc.json](confirmation-crc.json).

| Corpus   | Replication | Cohort    | Order |       A |      B |       C |
| -------- | ----------: | --------- | ----- | ------: | -----: | ------: |
| JMdict   |           1 | Warmup    | ABC   |   952.5 | 1165.2 |   982.4 |
| JMdict   |           1 | Triplet 1 | ABC   |   957.3 |  965.9 |   978.3 |
| JMdict   |           1 | Triplet 2 | CBA   |   962.4 |  954.0 |   999.3 |
| JMdict   |           1 | Triplet 3 | BCA   |  1005.8 |  995.9 |  1019.2 |
| JMdict   |           1 | Triplet 4 | ACB   |   970.5 |  951.8 |   981.1 |
| JMdict   |           1 | Triplet 5 | CAB   |   953.9 |  992.4 |   968.1 |
| JMdict   |           1 | Triplet 6 | BAC   |   958.4 |  946.3 |   950.3 |
| JMdict   |           2 | Warmup    | CBA   |  1314.6 |  805.1 |   796.2 |
| JMdict   |           2 | Triplet 1 | BAC   |   811.5 |  816.4 |   844.1 |
| JMdict   |           2 | Triplet 2 | CAB   |   809.5 |  804.1 |   778.2 |
| JMdict   |           2 | Triplet 3 | ACB   |   787.5 |  787.0 |   770.9 |
| JMdict   |           2 | Triplet 4 | BCA   |   759.5 |  763.6 |   757.7 |
| JMdict   |           2 | Triplet 5 | CBA   |   792.0 |  779.3 |   760.6 |
| JMdict   |           2 | Triplet 6 | ABC   |   776.0 |  794.5 |   776.7 |
| Jitendex |           1 | Warmup    | ABC   |  1847.4 | 1898.5 |  1586.3 |
| Jitendex |           1 | Triplet 1 | ABC   |  1601.5 | 1597.1 |  1581.8 |
| Jitendex |           1 | Triplet 2 | CBA   |  1660.0 | 1600.1 |  1733.6 |
| Jitendex |           1 | Triplet 3 | BCA   |  1594.0 | 1574.6 |  1554.6 |
| Jitendex |           1 | Triplet 4 | ACB   |  1585.1 | 1581.7 |  1552.8 |
| Jitendex |           1 | Triplet 5 | CAB   |  1604.4 | 1593.1 |  1562.3 |
| Jitendex |           1 | Triplet 6 | BAC   |  1613.9 | 1572.7 |  1558.9 |
| Jitendex |           2 | Warmup    | CBA   |  1894.4 | 1881.9 |  1967.8 |
| Jitendex |           2 | Triplet 1 | BAC   |  1902.4 | 1943.8 |  1875.3 |
| Jitendex |           2 | Triplet 2 | CAB   |  1933.6 | 1884.9 |  1930.3 |
| Jitendex |           2 | Triplet 3 | ACB   |  1927.8 | 1870.7 |  1842.6 |
| Jitendex |           2 | Triplet 4 | BCA   |  1901.9 | 1911.9 |  1943.5 |
| Jitendex |           2 | Triplet 5 | CBA   |  1937.2 | 1964.1 |  1870.6 |
| Jitendex |           2 | Triplet 6 | ABC   |  1873.2 | 1942.2 |  1949.3 |
| VNDB     |           1 | Warmup    | ABC   | 12915.2 | 9233.5 |  9522.5 |
| VNDB     |           1 | Triplet 1 | ABC   |  9550.4 | 9135.7 |  9717.3 |
| VNDB     |           1 | Triplet 2 | CBA   |  9136.7 | 9209.5 |  9554.4 |
| VNDB     |           1 | Triplet 3 | BCA   |  9391.6 | 8996.3 |  9349.7 |
| VNDB     |           1 | Triplet 4 | ACB   |  9365.3 | 9256.2 |  9207.2 |
| VNDB     |           1 | Triplet 5 | CAB   |  9283.3 | 8669.8 |  9846.9 |
| VNDB     |           1 | Triplet 6 | BAC   |  9332.8 | 8778.4 |  8988.8 |
| VNDB     |           2 | Warmup    | CBA   |  9610.8 | 9566.0 | 11361.9 |
| VNDB     |           2 | Triplet 1 | BAC   |  9907.2 | 8933.9 |  8999.0 |
| VNDB     |           2 | Triplet 2 | CAB   |  9256.7 | 8803.6 |  9145.8 |
| VNDB     |           2 | Triplet 3 | ACB   |  8941.2 | 8625.8 |  8977.2 |
| VNDB     |           2 | Triplet 4 | BCA   |  9196.4 | 8758.1 |  8723.8 |
| VNDB     |           2 | Triplet 5 | CBA   |  9010.2 | 8918.7 |  8964.3 |
| VNDB     |           2 | Triplet 6 | ABC   |  9168.9 | 8651.4 |  8787.6 |

To reproduce the read-only audit against the retained artifacts and locked fixtures:

```sh
python3 dev/perf/import-study-20261123/audit_crc_confirmation.py ARTIFACT_DIRECTORY \
  --node /path/to/node-22.22.0 --fixtures FIXTURE_DIRECTORY
```

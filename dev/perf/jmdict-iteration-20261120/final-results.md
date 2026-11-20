# Final combined-product import qualification

**All 144 planned observations passed** the exact archived verifier: 36 each for Chromium JMdict, Firefox JMdict, Chromium JMnedict and Chromium Jitendex. The original artifact ZIPs, GitHub metadata and raw observations are preserved. Every archive SHA-256/size and every one of the eight qualifier file SHA-256/Git blob identities matched the publication receipt before replay.

Run [44827149924](https://github.com/ManabiIO/manabitan/actions/runs/44827149924); qualifier `a85079bae287ff799fbdebc169cd08e16edd9943`; product `a0f8e8e00d30823b8451248b3e6bab20b4640eb8`; baseline `d733d0efe53398bfc2b45985aa709ade54f5710a`. The final product has six packaged source differences, with the benchmark correction kept outside the product.

## Elapsed results

Negative change means B or D was faster. B is the combined product; A/C/D use one identical prebuilt baseline package. No warmup, slow observation, or unfavorable pair was excluded. These are descriptive paired results; no significance claim or control-adjusted effect estimate is made.

| Cell              | A mean ms | B mean ms | B/A paired median | B/A equal work | Mean saving ms | B faster | D/C median | D/C equal work |
| ----------------- | --------: | --------: | ----------------: | -------------: | -------------: | -------: | ---------: | -------------: |
| Chromium JMdict   |  1031.175 |   973.800 |           -6.017% |        -5.564% |        +57.375 |    11/12 |    +0.064% |        -0.043% |
| Firefox JMdict    |  1104.750 |  1068.833 |           -4.149% |        -3.251% |        +35.917 |    10/12 |    -0.859% |        -1.157% |
| Chromium JMnedict |   956.225 |   977.775 |           +1.627% |        +2.254% |        -21.550 |     1/12 |    +3.039% |        +3.928% |
| Chromium Jitendex |  1641.617 |  1624.300 |           -0.605% |        -1.055% |        +17.317 |     8/12 |    +1.204% |        +1.677% |

JMdict improves in both measured browsers. Chromium has eleven faster candidate pairs out of twelve, a −6.017% median and −5.564% equal-work change, while same-code aggregate drift is −0.043%. Firefox has ten faster candidate pairs, a −4.149% median and −3.251% aggregate; its same-code control also improves by −1.157% aggregate.

JMnedict is slower in the raw candidate comparison: +2.254% aggregate, with only one faster candidate pair. Its same-code control is slower by a larger +3.928% aggregate, also with one faster pair. This does not establish a cross-dictionary speedup or isolate a causal regression. Jitendex is close to its control variation: −1.055% candidate aggregate and +1.677% control aggregate; the retained first two candidate pairs vary by +25.476% and −18.458%.

## All paired changes

| AB pair | Chromium JMdict | Firefox JMdict | Chromium JMnedict | Chromium Jitendex |
| ------- | --------------: | -------------: | ----------------: | ----------------: |
| 1       |        -20.362% |        -6.508% |           +1.880% |          +25.476% |
| 2       |         -8.197% |        -4.860% |           -2.423% |          -18.458% |
| 3       |         -7.797% |        +2.574% |           +1.374% |           -3.382% |
| 4       |        +14.395% |        -4.821% |           +0.010% |           -0.207% |
| 5       |         -5.432% |        -4.281% |           +1.093% |           -0.837% |
| 6       |         -6.919% |        -3.815% |           +5.057% |           -4.369% |
| 7       |         -4.240% |        -3.070% |           +5.829% |           +0.282% |
| 8       |         -1.804% |        +2.432% |           +0.731% |           -2.975% |
| 9       |         -6.602% |        -4.018% |           +6.054% |           -0.374% |
| 10      |         -8.400% |        -6.376% |           +4.458% |           +0.645% |
| 11      |         -4.173% |        -4.753% |           +0.639% |           +0.735% |
| 12      |         -3.948% |        -1.107% |           +2.628% |           -4.536% |

| CD control pair | Chromium JMdict | Firefox JMdict | Chromium JMnedict | Chromium Jitendex |
| --------------- | --------------: | -------------: | ----------------: | ----------------: |
| 1               |         +2.760% |        -1.441% |           +3.042% |           +7.407% |
| 2               |         +0.933% |        -6.563% |           +2.152% |           +0.883% |
| 3               |         -4.836% |        -3.609% |           -0.463% |           +1.526% |
| 4               |         -1.271% |        +3.253% |           +3.035% |           -1.034% |
| 5               |         +3.279% |        +2.192% |           +5.282% |           +3.139% |
| 6               |         -0.805% |        -0.278% |          +10.703% |           -1.617% |

## All observations in the frozen order

Each row is one fresh-profile observation per independent cell. Values are the browser monotonic file-input-to-UI-completion milliseconds.

| Position | Label | Chromium JMdict | Firefox JMdict | Chromium JMnedict | Chromium Jitendex |
| -------: | ----- | --------------: | -------------: | ----------------: | ----------------: |
|        1 | B1    |         963.700 |       1020.000 |           980.700 |          1963.200 |
|        2 | A1    |        1210.100 |       1091.000 |           962.600 |          1564.600 |
|        3 | D1    |        1023.700 |       1094.000 |           972.100 |          1677.800 |
|        4 | C1    |         996.200 |       1110.000 |           943.400 |          1562.100 |
|        5 | A2    |        1023.600 |       1111.000 |           982.100 |          1937.900 |
|        6 | B2    |         939.700 |       1057.000 |           958.300 |          1580.200 |
|        7 | B3    |         944.800 |       1116.000 |           981.400 |          1611.200 |
|        8 | A3    |        1024.700 |       1088.000 |           968.100 |          1667.600 |
|        9 | C2    |        1018.100 |       1158.000 |           934.200 |          1574.200 |
|       10 | D2    |        1027.600 |       1082.000 |           954.300 |          1588.100 |
|       11 | A4    |        1003.100 |       1120.000 |           959.700 |          1596.200 |
|       12 | B4    |        1147.500 |       1066.000 |           959.800 |          1592.900 |
|       13 | B5    |         945.400 |       1051.000 |           961.900 |          1682.600 |
|       14 | A5    |         999.700 |       1098.000 |           951.500 |          1696.800 |
|       15 | D3    |        1001.700 |       1095.000 |           946.900 |          1623.800 |
|       16 | C3    |        1052.600 |       1136.000 |           951.300 |          1599.400 |
|       17 | A6    |        1027.600 |       1101.000 |           937.400 |          1659.300 |
|       18 | B6    |         956.500 |       1059.000 |           984.800 |          1586.800 |
|       19 | B7    |         955.400 |       1105.000 |           994.900 |          1600.100 |
|       20 | A7    |         997.700 |       1140.000 |           940.100 |          1595.600 |
|       21 | C4    |        1022.500 |       1076.000 |           922.600 |          1634.000 |
|       22 | D4    |        1009.500 |       1111.000 |           950.600 |          1617.100 |
|       23 | A8    |        1003.500 |       1069.000 |           943.700 |          1619.900 |
|       24 | B8    |         985.400 |       1095.000 |           950.600 |          1571.700 |
|       25 | B9    |         947.800 |       1051.000 |          1007.300 |          1571.800 |
|       26 | A9    |        1014.800 |       1095.000 |           949.800 |          1577.700 |
|       27 | D5    |        1023.700 |       1119.000 |           968.700 |          1586.900 |
|       28 | C5    |         991.200 |       1095.000 |           920.100 |          1538.600 |
|       29 | A10   |        1042.800 |       1145.000 |           957.900 |          1565.000 |
|       30 | B10   |         955.200 |       1072.000 |          1000.600 |          1575.100 |
|       31 | B11   |         978.300 |       1062.000 |           976.600 |          1590.100 |
|       32 | A11   |        1020.900 |       1115.000 |           970.400 |          1578.500 |
|       33 | C6    |        1018.500 |       1081.000 |           922.200 |          1601.800 |
|       34 | D6    |        1010.300 |       1078.000 |          1020.900 |          1575.900 |
|       35 | A12   |        1005.600 |       1084.000 |           951.400 |          1640.300 |
|       36 | B12   |         965.900 |       1072.000 |           976.400 |          1565.900 |

## Mechanism receipts

These are means over all twelve A or B observations. Parser counters aggregate concurrent worker work and waiting, so they must not be added together as independent wall-time components.

| Counter                       | Chromium JMdict A → B | Firefox JMdict A → B | Chromium JMnedict A → B | Chromium Jitendex A → B |
| ----------------------------- | --------------------: | -------------------: | ----------------------: | ----------------------: |
| parserLookupIndexPrepareMs    |      38.31 → 45.34 ms |    166.67 → 42.33 ms |      130.40 → 158.61 ms |        38.57 → 37.89 ms |
| parserResultCopyMs            |     21.34 → 115.41 ms |    21.08 → 118.25 ms |        29.08 → 53.02 ms |      350.71 → 365.83 ms |
| parserParallelWorkerWallMs    |    886.89 → 782.33 ms |   930.75 → 762.92 ms |      779.72 → 568.14 ms |    1185.98 → 1199.83 ms |
| parserOrderedSinkWaitMs       |   293.47 → 1465.83 ms |  209.17 → 1588.33 ms |     325.73 → 2317.62 ms |    5079.22 → 5001.22 ms |
| dedupRecentSourceCacheMs      |     129.03 → 62.82 ms |    107.50 → 55.00 ms |        46.99 → 32.75 ms |          0.52 → 0.67 ms |
| contentCompressMs             |    377.04 → 354.51 ms |   390.08 → 398.50 ms |      152.51 → 159.13 ms |      456.10 → 455.65 ms |
| contentMetadataIndexPublishMs |    160.87 → 104.37 ms |   151.50 → 117.25 ms |        68.58 → 57.94 ms |        23.62 → 23.22 ms |
| workerImportElapsedMs         |    998.95 → 939.96 ms | 1072.25 → 1034.08 ms |      924.36 → 946.06 ms |    1614.62 → 1597.88 ms |

Firefox lookup-index preparation falls from 166.67 to 42.33 ms. In JMdict, recent-source cache work falls from 129.03 to 62.82 ms on Chromium and 107.50 to 55.00 ms on Firefox. Candidate receipts record 100,725,122 bytes of owned parser output and 82,637,043 adopted source bytes per JMdict import; borrowed-result count changes from twelve to zero. The baseline does not expose the newly added owned/adopted counters, so its absent values are not represented as zero.

The ownership change adds parser-side copy work and permits results to wait in the ordered queue while workers advance. The recorded result-copy and queued-wait counters rise, while parser worker-wall time falls. These overlapping counters explain the transfer of work and additional in-flight storage; they are not independent elapsed savings. The same parser-wall reduction does not guarantee a faster entire import, as the JMnedict totals demonstrate.

| Cell              | B owned bytes per import | B adopted bytes per import | B mean peak queued owned MiB |
| ----------------- | -----------------------: | -------------------------: | ---------------------------: |
| Chromium JMdict   |              100,725,122 |                 82,637,043 |                       45.230 |
| Firefox JMdict    |              100,725,122 |                 82,637,043 |                       42.255 |
| Chromium JMnedict |               22,788,646 |                 12,668,218 |                       16.142 |
| Chromium Jitendex |              388,336,969 |                          0 |                      134.158 |

Queue occupancy is a diagnostic of received queued results. It excludes active workers before result arrival, retained cache and WASM heaps; it is not a total-memory measurement.

## Separate memory diagnostics

One additional A trace and one B trace were collected for each valid Chromium cell after its entire timing cohort. All samples were retained, and the archived memory analyzer was replayed to reproduce the stored result exactly. Only samples fully inside the browser-recorded worker-import epoch window enter these peaks; preparation and restart peaks are excluded. There were zero sample errors in every reported window.

| Chromium workload | A peak PSS MiB | B peak PSS MiB | Difference MiB | A/B window samples | A peak RSS MiB | B peak RSS MiB |
| ----------------- | -------------: | -------------: | -------------: | -----------------: | -------------: | -------------: |
| Chromium JMdict   |       1248.053 |       1283.516 |        +35.463 |              21/18 |       2084.750 |       2133.668 |
| Chromium JMnedict |       1129.134 |       1182.349 |        +53.215 |              22/22 |       1966.441 |       2030.449 |
| Chromium Jitendex |       1585.763 |       1598.431 |        +12.668 |              37/36 |       2433.602 |       2447.508 |

These are sampled diagnostic lower bounds under tracing, not replicated estimates of uninstrumented peak memory. They include the wrapper and its descendant process tree. RSS sums can count shared pages more than once. The modest higher sampled PSS is the measured memory tradeoff; no profiled elapsed time was included in the performance results. Firefox has no corresponding process-tree memory trace in this protocol.

## Source work, settings and persistence

| Cell              | Banks |    Rows | Compressed/transferred term bytes | Uncompressed term bytes | Effective escaped keys | Requested/compression escaped keys |
| ----------------- | ----: | ------: | --------------------------------: | ----------------------: | ---------------------- | ---------------------------------- |
| Chromium JMdict   |    53 | 526,942 |                        15,574,114 |             171,092,992 | false (36/36)          | false (36/36 each)                 |
| Firefox JMdict    |    53 | 526,942 |                        15,574,114 |             171,092,992 | false (36/36)          | false (36/36 each)                 |
| Chromium JMnedict |    67 | 667,942 |                        11,419,584 |              45,421,175 | false (36/36)          | false (36/36 each)                 |
| Chromium Jitendex |   218 | 435,448 |                        33,696,215 |             537,538,792 | true (36/36)           | false (36/36 each)                 |

Every final observation passes exact fixture/source/package/browser identity, current-operation timing, actual OPFS SAH pool, zero fused/native fallback, clean publication, expected source-work totals, row counts and sampled content validation. Each cell has one consistent content digest across all 36 observations. Chromium verifies restart readback; Firefox verifies AddonManager reload and a changed background realm, not a process restart. Neither is an exhaustive stored-byte comparison.

Jitendex has 537,538,792 uncompressed term bytes, just above the existing 512 MiB production threshold. Its image/native-parallel receipts therefore require effective escaped keys=true. Requested and compression flags remain false, and every other flag is checked exactly. The wrapper correction is applied identically to Chromium A and B as a declared, hashed tooling overlay. Firefox uses the unchanged observer and original product worktree tooling. Earlier Jitendex wrapper failures remain invalid, preserved evidence; this is a new complete cohort.

## Reproduction and files

Original ZIPs are under `artifacts/`; corresponding GitHub artifact metadata and local ZIP/entry hash receipts are retained alongside them. Extracted immutable cells are under `cells/`. Exact archived verifier outputs and command receipts are under `analysis/`. `final-analysis.json` contains every observation, pair, phase counter, source-policy receipt and memory result.

```sh
python3 cells/chromium-jmdict/qualifier-inputs/dev/perf/jmdict-final-20261120.py analyze --evidence "$PWD/cells/chromium-jmdict"
```

Run the corresponding archived script for each cell. `analyze-artifacts.py` additionally binds all eight archived inputs to the publication SHA-256/Git blob receipt and reproduces separate trace memory summaries. No original checkout or browser installation is required for the archived analyzer.

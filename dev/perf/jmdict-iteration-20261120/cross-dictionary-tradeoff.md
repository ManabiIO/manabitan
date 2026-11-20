# JMnedict versus JMdict: owned-content tradeoff

**Recommendation: defer any narrower admission rule or new queue budget.** The existing evidence supports a plausible explanation for JMnedict's weaker result, but it does not identify a validated replacement policy. Keep the qualified source unchanged and record the memory tradeoff. A lower size threshold chosen to separate these two fixtures would require new validation.

This is a read-only analysis of final run **44827149924**, comparing baseline `d733d0efe53398bfc2b45985aa709ade54f5710a` with combined product `a0f8e8e00d30823b8451248b3e6bab20b4640eb8`. No source changes or new browser, parser, or benchmark runs were made. The [derived data receipt](cross-dictionary-tradeoff.json) retains input hashes, all arm summaries, exact group derivation, and memory diagnostics.

## What the elapsed results establish

| Chromium cell | B/A median paired change | B/A equal-work change | Faster B/A pairs | Same-code D/C median | Same-code D/C equal work |
| ------------- | -----------------------: | --------------------: | ---------------: | -------------------: | -----------------------: |
| JMdict        |                  −6.017% |               −5.564% |            11/12 |              +0.064% |                  −0.043% |
| JMnedict      |                  +1.627% |               +2.254% |             1/12 |              +3.039% |                  +3.928% |

JMnedict's candidate comparison is adverse, but its same-code control drift is larger. These observations do **not** establish that the implementation caused a 1.627% slowdown. Subtracting D/C from B/A would not establish an adjusted win either. All 36 observations in each cell remain included. Sources: [JMdict analysis](final-results.json), [JMnedict analysis](final-results.json).

## JMnedict offers less copy elimination and more work per content byte

The following byte counts are invariant across all twelve candidate observations in each cell. Counts are cumulative over the import, not simultaneous resident memory.

| Measurement                           |            JMdict |         JMnedict |
| ------------------------------------- | ----------------: | ---------------: |
| Imported rows                         |           526,942 |          667,942 |
| Owned content produced                | 100,725,122 bytes | 22,788,646 bytes |
| Recent-source cache bytes retained    |       100,724,405 |       22,788,302 |
| Cache bytes adopted                   |        82,637,043 |       12,668,218 |
| Adoption share of retained bytes      |            82.04% |           55.59% |
| Remaining sink content copy           |        18,087,362 |       10,120,084 |
| Worker copy plus remaining cache copy |       118,812,484 |       32,908,730 |
| Exact recent-source dedup hits        |             4,010 |           87,909 |
| Native dedup calls                    |                12 |               30 |

Baseline copies every retained span; that is source-derived from its cache implementation, since baseline has no adoption counter. Candidate still makes the first worker copy. Consequently, these two content-copy sites move **18,088,079 additional bytes for JMdict** and **10,120,428 additional bytes for JMnedict** overall, while removing 82.64 MB and 12.67 MB respectively from the sink. This optimization changes where copying occurs and permits overlap; it does not eliminate all copying.

Adoption requires an exact full-buffer retained span after publication. If global deduplication leaves a partial retained span, the cache makes the existing bounded copy. Worker admission can see local group eligibility, but it cannot prove the later global publication span. JMnedict's smaller adoption fraction limits the benefit. Its many exact comparisons, more rows and larger lookup work remain in the sink. Source: [`shouldOwnTermContentBytes`](https://github.com/ManabiIO/manabitan/blob/a0f8e8e00d30823b8451248b3e6bab20b4640eb8/ext/js/dictionary/term-content-ownership.js), [worker ownership construction](https://github.com/ManabiIO/manabitan/blob/a0f8e8e00d30823b8451248b3e6bab20b4640eb8/ext/js/dictionary/term-bank-wasm-parser-worker.js), and [`_cacheRecentPublishedTermContentSources`](https://github.com/ManabiIO/manabitan/blob/a0f8e8e00d30823b8451248b3e6bab20b4640eb8/ext/js/dictionary/dictionary-database.js).

## Phase evidence: parser completion advances beyond useful overlap

These are **A → B arm medians in milliseconds**, each over twelve observations. Several counters sum worker activity or overlapping waits; they must not be added together as elapsed costs. The [data receipt](cross-dictionary-tradeoff.json) derives them from every raw observation.

| Phase or counter                    |            JMdict |          JMnedict |
| ----------------------------------- | ----------------: | ----------------: |
| Recent-source cache work            |    126.90 → 62.70 |     47.55 → 31.25 |
| Worker result copying               |    20.75 → 113.10 |     27.80 → 53.00 |
| Parser worker wall                  |   875.75 → 771.20 |   775.70 → 562.05 |
| Ordered sink work                   |   563.50 → 586.50 |   653.00 → 671.00 |
| Term-file phase elapsed             |   903.50 → 834.50 |   848.50 → 861.50 |
| Summed result wait for ordered sink | 294.65 → 1,449.55 | 331.45 → 2,306.60 |
| Summed native parse work            | 958.00 → 1,066.50 |   578.00 → 710.50 |
| Lookup preparation                  |     38.00 → 42.90 |   128.40 → 163.75 |
| Content compression                 |   372.90 → 348.05 |   153.70 → 157.75 |

JMnedict saves only 16.30 ms of median cache work, compared with JMdict's 64.20 ms. Its parser completion advances by 213.65 ms, yet the sink remains busy and the term-file phase does not shorten. The much larger summed result wait is consistent with completed groups accumulating ahead of the sink. Earlier concurrency and contention among parsing, lookup preparation and storage are plausible contributors; the data do not isolate them causally. JMnedict's same-code sink median also rises **624.5 → 661.0 ms**, and its term-file phase rises **816.5 → 851.5 ms**, reinforcing the timing-drift limitation.

## Groups, queue occupancy and process memory

Both cells use **three workers, four lead groups per worker, twelve groups**, with all twelve results moving from borrowed content to owned content. Reapplying the exact source partition arithmetic to SHA-verified archive directory sizes gives:

| Group characteristic                                |                       JMdict |                     JMnedict |
| --------------------------------------------------- | ---------------------------: | ---------------------------: |
| Source banks                                        |                           53 |                           67 |
| Banks per group                                     |                          4–5 |                          4–7 |
| Uncompressed source bytes per group                 |        13,229,016–15,952,182 |          3,550,011–4,200,376 |
| Mean owned content per group                        |              8,393,760 bytes |              1,899,054 bytes |
| Largest arrived-content queue peak in timed cohort  | 56,229,498 bytes / 53.62 MiB | 17,737,865 bytes / 16.92 MiB |
| Arrived-content queue peak in separate memory trace | 52,076,219 bytes / 49.66 MiB | 19,508,768 bytes / 18.61 MiB |

The current sink group counts against the twelve-group lead until its callback finishes. For this three-worker plain-content path, twelve groups each admitted at no more than 48 MiB give a **576 MiB theoretical bound on compact-owned content in that lead window**. It is not a process-memory bound, does not cover the preexisting large projected-content path, and does not describe these much smaller fixtures. The queue counter covers arrived content waiting for or inside its sink; it excludes in-flight worker results, copied row/key columns, retained cache, WASM heaps and other browser allocations. Source: [`ParallelTermBankPipelineRun`, `partitionSourceBanks`, and `copyWasmBackedColumnChunk`](https://github.com/ManabiIO/manabitan/blob/a0f8e8e00d30823b8451248b3e6bab20b4640eb8/ext/js/dictionary/term-bank-wasm-parser.js).

The separate, untimed memory pair reports:

| Sampled process memory |                         JMdict A → B |                       JMnedict A → B |
| ---------------------- | -----------------------------------: | -----------------------------------: |
| Peak PSS               | 1,248.05 → 1,283.52 MiB (**+35.46**) | 1,129.13 → 1,182.35 MiB (**+53.21**) |
| Peak RSS               |     2,084.75 → 2,133.67 MiB (+48.92) |     1,966.44 → 2,030.45 MiB (+64.01) |
| Median PSS             |     1,115.46 → 1,130.35 MiB (+14.88) |     1,073.29 → 1,093.55 MiB (+20.25) |

These are wrapper-plus-descendant measurements from one diagnostic pair per cell, with 21/18 complete import-window samples for JMdict and 22/22 for JMnedict, and no sample errors. Sampled peaks are lower bounds. JMnedict's **+53.21 MiB PSS exceeds its entire 21.73 MiB of owned content**, so attributing the increase solely to the content arena would be wrong. Earlier overlapping lifetimes of complete row/key outputs and other allocations are plausible; the ownership metric does not measure those allocations. Maximum reported WASM heap size is unchanged within each cell. The diagnostic provides no process-memory nonregression guarantee. Sources: [JMdict trace status](final-results.json), [JMnedict trace status](final-results.json).

## Why another policy should wait

- **No measured alternative admission rule exists.** A minimum group-byte or bytes-per-row cutoff could separate these fixtures after seeing their results, but would be fitted to them. The existing 512-byte average ceiling expresses cache eligibility; adding a lower cutoff needs broader evidence. An upper cap that remains well above the actual group sizes would not address this case.
- **Adoption cannot simply be predicted from the local parser result.** It depends on the final published span after global deduplication. Relaxing exact-span adoption would change retained coverage or budget charging, which was deliberately kept identical.
- **A content-only queue budget misses the main uncertainty.** JMnedict already has a small content queue. A generic budget for complete output arrays and in-flight reservations is a reasonable future direction, but its value and progress/cancellation behavior have not been qualified.
- **Changing `pipelineGroupsPerWorker` is not an isolated queue change.** It controls both the requested partition count and maximum lead. Reducing it would also change group sizes, local deduplication and adoption opportunities. A future experiment should separate lead control from partitioning and preserve required head-of-line progress.

There is enough evidence to describe the tradeoff and choose the next hypothesis. There is **not enough evidence to implement and promote a new threshold or queue budget now**. Any such change would require a new fixed-source qualification, including JMdict, JMnedict and the larger structured dictionary, plus bounded-sink and cancellation validation.

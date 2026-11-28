# Manabitan import optimization study: final decision

**No optimization PR qualifies from this study.** The VNDB image-path candidate delivered a repeatable component improvement—about **25% less projection CPU, or 80 ms per complete VNDB projection workload**—but failed the frozen browser publication requirements. All six hosts are now independently audited. Three hosts failed mandatory memory-sampling coverage; the available evidence does not establish a memory increase or decrease for those cohorts.

The work used subagents extensively and did not use Work mode. Optimization candidates, failed experiments and measurement evidence remain separate. No optimization PR was opened and nothing was merged by this study.

## The measured improvement

The strongest candidate batches native-projected, unescaped ASCII image paths into owned decoding buffers of at most 64 KiB, reducing repeated small snapshots and `TextDecoder` calls. Other paths retain the existing fallback. Its index arrays scale with media-row count; the 64 KiB bound applies to the decoding buffer, not all temporary memory.

The fixed component screen covered **146,725 media rows in 170 production planner groups**. Median CPU savings were **25.47% against baseline A** and **24.46% against identical control C**, or **83.10 ms and 77.94 ms** per full projection workload. All six comparisons were faster. These are projection-component measurements, not whole-import improvements. The [frozen policy and component evidence](https://github.com/ManabiIO/manabitan/tree/d36ee85feb1513af31f769175affa33b3696a307/dev/perf/path-qualification-7c02) preserve that scope.

The [complete-copy oracle](https://github.com/ManabiIO/manabitan/tree/61506e8b8b5da634f36efcaa8cd82b8006f8e1e4/dev/perf/parser-path-hosted-copy-7c02) passed all **6,648,310 VNDB rows**, including result columns, routes, media and relevant aliases. Clean [hosted Node 22.22.0 validation](https://github.com/ManabiIO/manabitan/tree/9ae4c4d09ec4b9ae1755f55032f9de6dd2abd207/dev/perf/parser-path-hosted-validation-7c02) passed scoped lint, main/test types, **15,159 tests across 669 files**, 47 inherited skips, all seven dry-build targets and the pinned native artifact check. Earlier local setup failures remain separate historical evidence.

## Six-host browser outcome

The [original campaign](https://github.com/ManabiIO/manabitan/actions/runs/46113567719) completed with three successful and three failed measurement jobs. Each host retained twelve candidate pairs, four identical-control pairs, excluded warmups, exhaustive media checks and four separate memory observations. All **252 import receipts** passed the independent source, schedule, semantic, restart, storage and media checks. Negative latency changes mean faster imports.

| Dictionary/order | Median B/A | Equal-work B/A | Faster pairs | Mandatory host result |
| --- | ---: | ---: | ---: | --- |
| JMdict AB | −1.080% | −0.755% | 8/12 | Pass |
| JMdict BA | +0.024% | +1.805% | 6/12 | Pass |
| Jitendex AB | −0.886% | −0.057% | 7/12 | Pass |
| Jitendex BA | +1.838% | +2.893% | 3/12 | Memory coverage fails |
| VNDB BA | −1.182% | −1.248% | 8/12 | Memory coverage fails |
| VNDB AB | −1.818% | −1.567% | 9/12 | Memory coverage fails |

The passing [JMdict BA evidence](https://github.com/ManabiIO/manabitan/tree/4d1feb8cef029825a03d0e3a7c9e49f300b6a33a/dev/perf/parser-path-browser-jmdict-BA-7c02) and [JMdict AB/Jitendex AB evidence](https://github.com/ManabiIO/manabitan/commit/aaf36ede3cfe2e0cc56a29708649370427ba002b) include retained observations and independent audits. Failed-cell evidence is preserved separately: [Jitendex BA](https://github.com/ManabiIO/manabitan/blob/81f63fbf8f619836ef003145f7138354564d2810/dev/perf/parser-path-browser-jitendex-BA-7c02/RESULT.md), [VNDB BA](https://github.com/ManabiIO/manabitan/blob/81f63fbf8f619836ef003145f7138354564d2810/dev/perf/parser-path-browser-vndb-BA-7c02/RESULT.md), and [VNDB AB](https://github.com/ManabiIO/manabitan/blob/81f63fbf8f619836ef003145f7138354564d2810/dev/perf/parser-path-browser-vndb-AB-7c02/RESULT.md).

The independent raw-memory audits confirmed these covered-scan gaps above the registered **250 ms** limit:

| Host | Invalid slots and exact covered gaps |
| --- | --- |
| Jitendex BA | Baseline A1: **369.393278 ms** |
| VNDB BA | B1: **257.913014 ms**; A1: **281.955552 ms**; B2: **322.487852 ms** |
| VNDB AB | B1: **285.118080 ms** |

Both aggregate PSS and private-byte comparisons correctly remain null for each failed cohort. Valid slots do not substitute for invalid ones. These failures concern measurement coverage, not demonstrated memory growth. The minimum sample count, coverage bounds and memory-change limits were not relaxed.

VNDB AB's complete latency result was median **−1.818272%**, equal-work **−1.566584%**, descriptive bootstrap interval **[−3.931178%, −0.079223%]**, control median drift **−0.950672%**, and B's median versus C **−0.681364%**. Its negative interval does not satisfy the stronger whole-import requirement: at least 5% improvement against both comparisons and at least ten faster pairs. VNDB BA likewise misses that gate. No host was pooled, filtered, replaced or adjusted by subtracting control drift.

## Why JMdict remained difficult

The baseline profile distributes work across inflation, parsing, compression and storage, with overlapping phases. Summed worker durations are not CPU time or exposed latency; sampled trace weights are not removable milliseconds. Two unchanged baseline browser observations moved from **959.9 ms to 861.2 ms**, roughly 10%, illustrating variation rather than establishing a general noise estimate.

Several attractive local differences failed their registered pair-win or unchanged-control requirements. The more stable corrected compression screen found only a few milliseconds of savings. The inference is that useful progress needs a larger demonstrated reduction in work or a reproducible pipeline improvement, rather than selecting favorable small observations. The [published profile, original trace and findings](https://github.com/ManabiIO/manabitan/tree/6acf4f53fe947e5d25829a56361bffebaa885269/dev/perf/jmdict-baseline-profile-7c02) preserve the underlying evidence.

## Eighteen avenues and dispositions

The [earlier ledger](https://github.com/ManabiIO/manabitan/tree/165c6a97b2a09004cdea460055747811569ff382/dev/perf/import-study-20261128-7c02) retains detailed scopes, failures and raw-loss caveats.

| Avenue | Decisive result | Disposition |
| --- | --- | --- |
| Composite inlining | About 13% slower | Rejected; early raw files lost |
| SIMD string scanning | About 6% slower | Rejected; early raw files lost |
| Literal schema-key identity | Inconsistent pair wins | Held |
| Scanner mask factoring | Identical generated code | No optimization |
| Four distinct recent definitions | Only 433 additional logical hits | Rejected before implementation |
| Whole-row-tail reuse | Zero adjacent matching tails in JMdict/Jitendex | Rejected |
| Compression-context template | Control drift invalidated apparent gain; 4 MiB component scope | Rejected |
| Expression-to-reading proof | Only four of six pairs faster | Held |
| Type-hint deferral | Material slowdown | Rejected |
| Strict local hints, version 1 | Material JMdict slowdown | Rejected |
| Strict local hints, version 2 | Neither dictionary passed its gate | Rejected |
| Paired score validation | Small enclosing benefit; constructor control failed | Rejected |
| Word-based checksum reader | Approximately doubled checksum CPU | Rejected |
| Batched image-path decoding | Qualified component gain; browser gates failed | No PR |
| Reserved contiguous envelopes | Unresolved ownership/future-read contract | Rejected before timing |
| Zstd match-counter width | Build/parity evidence; concurrent overlapping work | No separate optimization PR |
| Checked 64-bit sequence writer | Completed corrected screen missed thresholds | Rejected |
| Capacity-dispatch sequence writer | Correctness/code generation passed; 0/32 observations recorded | Held, inconclusive |

## Workload correction and preservation

Before sequence-writer timing, the **31-block, 4 MiB** corpus was found to differ from production packing. A source-verified **103-block, 1 MiB** corpus preserved group boundaries, global deduplication, record order, context assignment and logical destination capacities. The incorrect sequence timing plan remained unexecuted.

The corrected checked-writer screen completed all 32 observations and failed its gate; its [immutable negative evidence](https://github.com/ManabiIO/manabitan/tree/aefc3ef11c00f4a87911b97757a7001fe75b2645/dev/perf/zstd-sequence64-rejected-7c02) is preserved. The distinct capacity-dispatch candidate passed correctness and emitted-code checks, but its one process exited 137 with **zero of 32 observations recorded**. Exact phase and cause are unknown; no speed or memory conclusion follows. Its [correctness and incomplete-run archive](https://github.com/ManabiIO/manabitan/tree/9ae4c4d09ec4b9ae1755f55032f9de6dd2abd207/dev/perf/zstd-sequence64-capacity-dispatch-7c02) remains separate.

The final executor outage temporarily blocked VNDB AB's raw audit and left an earlier compact-verifier completion unknown. After recovery, byte-preservation verification and the final raw audit completed without reacquiring any observation. All failed browser slots remain in the archives. Earlier unrecovered experimental raw files are explicitly identified; no reconstruction is presented as original measurement data.

## Base compatibility and final decision

All browser qualification measurements compare frozen baseline **9e10d3b** with candidate **e90c4c0**. Develop later advanced to **dcfc02a** through PR #972. The [read-only comparison](https://github.com/ManabiIO/manabitan/compare/dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16...e90c4c04172b691985858609094887f9541541dd) has disjoint changed files; source review found unchanged native projection ABI, row metadata layout and source-lifetime contracts. No combined-tree execution occurred, and historical measurements are not results on current develop.

The final decision is **no optimization PR**. The useful projection result, failed publication gates, negative experiments and incomplete candidates remain available for review without overstating what they establish.

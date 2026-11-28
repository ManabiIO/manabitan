# Manabitan import optimization study

**Only the VNDB worker image-path projection has a qualified measured component gain. Its browser publication gates remain pending, and no optimization PR has been opened.** JMdict was the priority throughout; its completed experiments did not establish a gain meeting their prospective gates. The newer capacity-dispatched sequence writer passed correctness and code-generation checks, but its performance acquisition is incomplete.

This overview covers the 18 avenues in the [frozen investigation ledger](https://github.com/ManabiIO/manabitan/blob/9ae4c4d09ec4b9ae1755f55032f9de6dd2abd207/dev/perf/zstd-sequence64-capacity-dispatch-7c02/investigation-ledger-snapshot.json), against baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`, plus the subsequently completed hosted validation. Work used separate prototypes, independent reviews and frozen comparisons; no Work mode or merges were used.

## Current review candidate: VNDB image-path projection

Product commit [e90c4c0](https://github.com/ManabiIO/manabitan/commit/e90c4c04172b691985858609094887f9541541dd) changes two runtime files and one test file. The worker groups native-validated, unescaped ASCII image paths into private decoding windows of at most 64 KiB. Unicode, escapes and other cases retain the existing fallbacks. The public copy helper preserves its per-row behavior.

The fixed component cohort covered all **170 VNDB groups and 146,725 projected media rows**. Median process CPU changes were **−25.47% versus A and −24.46% versus identical C**, saving **83.10 ms and 77.94 ms** per complete projection corpus; both comparisons won all six blocks. Identical controls differed by +1.92% CPU and +2.28% wall. These are sums of projection-helper intervals, not elapsed import, enclosing-copy or peak-memory results. [Component evidence](https://github.com/ManabiIO/manabitan/blob/d36ee85feb1513af31f769175affa33b3696a307/dev/perf/path-qualification-7c02/component-evidence/README.md).

Complete untimed copy oracles passed **6,648,310 rows, 170 groups and 170 prepared lookup routes**, [locally under Node 24](https://github.com/ManabiIO/manabitan/blob/d36ee85feb1513af31f769175affa33b3696a307/dev/perf/path-qualification-7c02/complete-copy-evidence/RESULT.md) and [independently under hosted Node 22](https://github.com/ManabiIO/manabitan/blob/61506e8b8b5da634f36efcaa8cd82b8006f8e1e4/dev/perf/parser-path-hosted-copy-7c02/README.md). They checked values, bytes, aliases, live source/heap integrity and original group/path identities.

**Clean hosted Node 22.22.0 validation also passed:** scoped ESLint, main/test TypeScript, 669 unit files with 15,159 passing tests and 47 skips in one invocation, all seven dry-build targets, and the pinned native WASM rebuild. [Hosted validation archive](https://github.com/ManabiIO/manabitan/blob/9ae4c4d09ec4b9ae1755f55032f9de6dd2abd207/dev/perf/parser-path-hosted-validation-7c02/README.md). Historical [local compiler/output-directory repairs](https://github.com/ManabiIO/manabitan/blob/d36ee85feb1513af31f769175affa33b3696a307/dev/perf/path-qualification-7c02/validation-evidence/README.md) remain separate.

## All 18 avenues

Percentages below apply only to the named component or parser screen.

| # | Avenue | Disposition and decisive evidence |
| --- | --- | --- |
| 1 | Composite-parser inlining | Rejected: JMdict wall +12.99%, only 2/4 wins. Raw receipt lost in temporary reset. |
| 2 | SIMD16 string scanner | Rejected: JMdict wall +5.83%, only 1/4 wins. Raw receipt lost in temporary reset. |
| 3 | Literal schema-key classification | Held: JMdict wall −4.495%, only 2/4 wins and substantial variance. |
| 4 | SWAR mask factoring | No effective code change: compiler already emitted equivalent instructions. |
| 5 | Four distinct recent definitions | Not implemented: census found only 433 extra hits among 528,299 JMdict rows. |
| 6 | Adjacent complete row-tail reuse | Not pursued: zero adjacent complete-tail matches in JMdict and Jitendex. |
| 7 | Raw compression-context template | Rejected: apparent gain failed the identical control; control drift 6.39%. Earlier 31-block/4 MiB geometry limits apply. |
| 8 | Reading/expression equality proof | Held: JMdict wall −4.924%, only 4/6 wins; consistency gate failed. |
| 9 | Deferred type/text hint | Rejected: JMdict wall +15.159%, CPU +17.512%. |
| 10 | Strict parser locals, v1 | Rejected: JMdict wall +17.503%. Jitendex acquisition was incomplete after a killed baseline. |
| 11 | Strict parser locals, v2 | Rejected after restoring helper inlining: JMdict wall +3.230%, CPU +4.083%; Jitendex wall +1.521%. |
| 12 | Paired compact-score validation | Not worth a PR: only about 0.4 ms beyond the existing indexed-loop comparator; enclosing control gate failed. |
| 13 | Aligned-word checksum reader | Rejected: actual JMdict checksum CPU +105% versus A; enclosing constructor also regressed. |
| 14 | Worker ASCII image-path batching | **Qualified projection-only gain; browser correctness, memory and non-regression gates pending.** |
| 15 | Reserved contiguous lookup envelope | Rejected on ownership contract despite 42 passing cases: later aliases/future reads could observe detached buffers. No timing. |
| 16 | Zstd U64 match counting | Build and 31-frame parity passed; no timings. A separate concurrent implementation already existed, so no duplicate optimization PR. |
| 17 | Zstd checked64 sequence writer | Rejected: all 32 observations completed; CPU savings only about 1.5–2.8% / 2.7–4.8 ms, below fixed gain, consistency and absolute-saving gates. |
| 18 | Zstd capacity-dispatched sequence writer | Held: correctness/codegen passed; process exited 137 with **0/32 recorded observations**. No performance verdict. |

The early avenues are summarized from the frozen ledger, which is not a complete raw-data archive for those avenues. The two lost raw receipts support only limited historical rejection notes. Other incomplete acquisitions remain separate; no completed result was assembled from partial runs.

## Decisive workload correction before sequence64 timing

The prepared sequence64 screen had recorded **zero observations** when source review found that its 31-block corpus used the standalone store's **4 MiB default**, while the actual dictionary database overrides this to **1 MiB**. That sequence64 timing screen was never run; the separate earlier context-template experiment retains its narrower 4 MiB scope.

The same ordered canonical stream—362,032 records / 100,300,626 bytes—was repacked with the actual whole-entry planner and per-append flush boundaries, producing **103 blocks across 12 groups**. The replay also adopted group-local block index modulo four and the per-context destination-capacity high-water map. Exact planner, deduplication, frame and envelope checks passed. Earlier 4 MiB correctness evidence retains its original scope. [Corrected workload and fixed-screen record](https://github.com/ManabiIO/manabitan/blob/aefc3ef11c00f4a87911b97757a7001fe75b2645/dev/perf/zstd-sequence64-rejected-7c02/RESULT.md).

The checked64 writer then failed its sole fixed corrected-corpus screen. The distinct capacity-dispatch mechanism subsequently passed its feasibility census, correctness and emitted-code reviews, but its authorized process was killed before any observation was saved. **The exact termination phase and cause are unknown.** Missing saved oracle fields do not establish which setup/warmup steps finished. This establishes neither a speed gain nor a regression, including memory regression. [Design B result and archived independent audits](https://github.com/ManabiIO/manabitan/blob/9ae4c4d09ec4b9ae1755f55032f9de6dd2abd207/dev/perf/zstd-sequence64-capacity-dispatch-7c02/RESULT.md).

## Publication decision still pending

[Browser campaign 46113567719](https://github.com/ManabiIO/manabitan/actions/runs/46113567719) retains two independent hosts per dictionary. Every host must pass complete identity/semantic/media checks, the separate memory protocol (median increase ≤5%, every paired increase ≤10%), identical-control drift ≤5%, and non-regression (paired median/equal-work changes ≤+3%; bootstrap upper endpoint ≤+5%). Hosts are not pooled.

A whole-import speedup claim additionally requires both VNDB hosts to pass every stronger latency gate, including ≥5% improvement versus A and C and ≥10/12 faster pairs. If only the mandatory gates pass, any PR decision must judge the scoped projection CPU saving and code complexity explicitly. [Frozen publication policy](https://github.com/ManabiIO/manabitan/blob/d36ee85feb1513af31f769175affa33b3696a307/dev/perf/path-qualification-7c02/README.md).

Immutable research evidence:

- [Checked64 rejection — `aefc3ef`](https://github.com/ManabiIO/manabitan/commit/aefc3ef11c00f4a87911b97757a7001fe75b2645).
- [Hosted full-copy evidence — `61506e8`](https://github.com/ManabiIO/manabitan/commit/61506e8b8b5da634f36efcaa8cd82b8006f8e1e4).
- [B1 and clean hosted-validation archives — `9ae4c4d`](https://github.com/ManabiIO/manabitan/commit/9ae4c4d09ec4b9ae1755f55032f9de6dd2abd207).

Browser outcomes and the PR decision remain pending. The separate PR draft is not a published optimization proposal.

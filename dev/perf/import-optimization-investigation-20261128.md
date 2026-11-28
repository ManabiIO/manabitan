# Manabitan import optimization investigation — 2026-11-28

**Closed without a product PR.** None of the completed screens established a reliable, worthwhile complete-import speed improvement. JMdict received the most profiling and experimentation; its apparently favorable component results did not survive realistic cold sequences or complete imports. A VNDB catalog change produced a real **14.223 MiB retained-worker reduction**, but its original promotion criterion and required process-memory coverage screens failed. No additional observations are planned.

All experiments used frozen baseline **`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`**. During final reporting, develop advanced to [dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16](https://github.com/ManabiIO/manabitan/commit/dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16), including [#972, compact structured glossary lists](https://github.com/ManabiIO/manabitan/pull/972). These results make **no performance claim against that newer baseline**. The archive branch contains reports only.

## Complete-import comparisons

Each cell gives the median paired B/A change and faster candidate pairs out of six. Negative percentages mean faster. Each frozen cohort retains four warmups, six alternating A/B pairs and two identical-code A/C control pairs; separate exhaustive-media and process-memory checks follow. No outlier was removed or replaced. Links identify the exact run and candidate source.

| Experiment: run / source                                                                                                                                                                                |       JMdict |     Jitendex |         VNDB |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------: | -----------: | -----------: |
| [Index-worker admission](https://github.com/ManabiIO/manabitan/actions/runs/46101293804) / [70f0707d](https://github.com/ManabiIO/manabitan/commit/70f0707d0e785b0f277107e97e91314531559bf6)            | +5.64% (0/6) | −3.54% (4/6) | +0.31% (3/6) |
| [Initial source window](https://github.com/ManabiIO/manabitan/actions/runs/46102941020) / [38527265](https://github.com/ManabiIO/manabitan/commit/385272655436cf3ebabec7a9ab3ba14daf528a52)             | +1.03% (2/6) | −0.57% (4/6) | −0.82% (4/6) |
| [Cached native tag reader](https://github.com/ManabiIO/manabitan/actions/runs/46105248799) / [9e670b65](https://github.com/ManabiIO/manabitan/commit/9e670b6587618c66091455356e8695a7db679cec)          | +0.94% (1/6) | −0.02% (3/6) | −0.32% (3/6) |
| [Publication/cache envelope fusion](https://github.com/ManabiIO/manabitan/actions/runs/46104654270) / [b17bbe06](https://github.com/ManabiIO/manabitan/commit/b17bbe06596d3dab8c39a353ed29265a8aa5f115) | +2.19% (1/6) | +1.05% (3/6) | −0.81% (4/6) |
| [Prepared score metadata](https://github.com/ManabiIO/manabitan/actions/runs/46104836788) / [2b4dd13a](https://github.com/ManabiIO/manabitan/commit/2b4dd13afd9639378d9ebceafe02fdf2f4a87dfc)           | +0.78% (1/6) | +0.89% (2/6) | +1.42% (2/6) |
| [Compact media catalog](https://github.com/ManabiIO/manabitan/actions/runs/46108057559) / [931eff9f](https://github.com/ManabiIO/manabitan/commit/931eff9fb194df34b67cb4f5f952f437aa8c084b)             | −0.78% (3/6) | +0.03% (3/6) | −1.07% (5/6) |

Admission slowed every JMdict pair. Its favorable Jitendex median was smaller than identical-code control drift (−4.91%). Source-window Jitendex had a favorable median but **+1.31% equal-work** change; envelope VNDB similarly had **+0.29% equal-work** change. Prepared-score worker transfer and database acceptance were verified; its browser result cannot be dismissed as a known inactive path. Envelope fusion moves work between publication and caching, so isolated cache counters cannot establish its gain.

Timing observations do not imply every workflow passed. Admission VNDB, source-window Jitendex, cached-tag JMdict/VNDB and prepared-score VNDB had sampling-coverage failures; their raw outcomes remain retained. A coverage failure does not establish a memory regression. The complete envelope screens passed memory qualification but supplied no worthwhile speed gain.

## Native Jitendex rehash

[Run 46115970275](https://github.com/ManabiIO/manabitan/actions/runs/46115970275), source `cea622d9b99d269787a0cbbd4d5d74aadc79e356`, saved approximately **6 ms** in an isolated replacement-arena resize, with exact output parity. Complete Jitendex imports were **+0.9865% median**, **+1.0706% equal-work**, only **2/6 faster**, versus **+0.7825%** control drift. Correctness, memory and quality gates passed; the component gain did not justify a PR. Baseline JMdict preallocation performs no populated resize. Existing #975 changes slot encoding and was not combined with this experiment.

## Real media retention saving; promotion withheld

The [primary extension-worker run](https://github.com/ManabiIO/manabitan/actions/runs/46109767804) retained nine observations across ABC/BCA/CAB blocks and seven checkpoints: **63 raw records**. At `catalogReady`, median heap plus reported backing storage fell from **27,772,432 to 12,858,490 bytes**, saving **14,913,942 bytes (14.223 MiB, 53.7005%)**. Measured packing checkpoints retained over 14 MiB savings. Hydration is bounded to the current batch; decoded names and the byte arena remain. This is not a total-allocation, continuous peak-process, permanent-dictionary-memory or speed claim.

The original **16 MiB floor failed**, so the registered overall rule failed. Ordinary VNDB process-memory coverage also failed: B1/A2 gaps were **399.792045/308.60082 ms**, above 250 ms. The [single predefined ABBA follow-up](https://github.com/ManabiIO/manabitan/actions/runs/46124641451) again failed: A1's gap was **330.034337 ms**. Three observations and one pair qualified; aggregate PSS/private changes remain null. All four semantic checks passed and all 487 scans were audited. No cross-pairing or further retry was permitted.

Media Jitendex retains its **+21.6486%** individual pair and **+3.2208% equal-work** result. VNDB's −1.07% candidate median was smaller than −1.96% favorable control drift. See the [full evidence narrative](media-catalog-retention-20261128.md) and [exact observation packet](media-catalog-retention-20261128.json), including all failed and inconclusive outcomes.

## Mechanism screens that should not be repeated blindly

- **Canonical column spacing:** separating typed-column page offsets added 65,536 bytes. The [18-process hosted cold screen](https://github.com/ManabiIO/manabitan/actions/runs/46107175060) replayed all 12 actual JMdict groups; wrapper medians were A39.358/B39.355/C39.183 ms. The earlier local native-only improvement did not replicate.
- **Shared output copies:** recent-source caching already adopted nearly all 101 MB of owned JMdict slabs. Width-view `.set`, slicing and optional two-memory WASM copying supplied no qualifying replacement. Warm fixed-source unrolled assignments looked promising; 108 fresh-process actual-group observations closed both BigUint64 and Uint32 alternatives. Cold/general-argument costs supersede that microbenchmark.
- **CRC:** JMdict uses immediate CRC, so deferred-gap improvements do not apply. Equivalent 32-bit word kernels passed boundary/unaligned parity but lacked consistent gains. The [VNDB gap-tail screen](https://github.com/ManabiIO/manabitan/actions/runs/46101700938) improved isolated CRC while whole-parser equal-work change was approximately −0.02%; no complete-import claim followed.
- **Prepared Zstd state:** representative source-token probes passed decompression parity, but template reset savings were only 7–11 microseconds per large call, with 549,912 extra context bytes per worker and a deprecated copying API. Advanced-CDict effects were mixed. These native probes did not reproduce production WASM block boundaries.
- **Inactive compact canonical staging:** the proposed unique-metadata path was absent from baseline JMdict. Profiling activation prevented promoting synthetic gains. Native arena leasing was deferred because ownership complexity lacked sufficient measured payoff.

## Reproduction and quality scope

Frozen workflows preserve source revisions, locked fixture hashes, package/member hashes, production-default flags, scheduling and raw reports. VNDB's expected SAH allocation range remained 37/37. The media packet pins Node **22.22.0**, full Chromium **153.0.8010.12**, executable SHA-256 `8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e`, unchanged sampler/overlay and 250 ms limits. Failed scans, local resource-limit exits and sensitivity-only HTTP/headless observations remain separate.

Media's quality job in run 46108057559 passed scoped lint, all four TypeScript projects, **669 unit files / 15,154 passed tests / 47 skips**, and all seven dry builds. Its overall workflow failed the VNDB coverage gate. Earlier pipeline-status masking was corrected in separate quality workflows; green job status alone was not treated as a receipt. Native rehash additionally passed pinned LLVM **21.1.8** source-to-WASM reproduction. None of these scoped passes changes the final **CLOSE_WITHOUT_PR** decision.

# Import optimization follow-up — 2026-11-23

This record preserves completed follow-up experiments against develop `467067650653c37c1f7d6b05d6737d070e1259cd`. None of these experiments established an additional browser import speedup. Original observations, failed hypotheses and protocol corrections remain available for review.

| Experiment                                       | Result                                                                                                                             | Record                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Native glossary copy/hash fusion, PR #840        | Complete byte parity and passing correctness checks; the independent browser assessment does not reproduce the Node component gain | [Browser studies and native validation](hash-copy/README.md)                               |
| Reuse packed compression buffers                 | Fewer allocations; corrected component timings are inconsistent and do not establish a speedup                                     | [Storage experiment report](storage-experiments/README.md)                                 |
| Cache exact-parameter prepared Zstd dictionaries | All frames decode correctly, but all 382 compressed frames differ; the byte-preserving hypothesis fails before timing              | [Native codec proof](storage-experiments/README.md#2-rejected-exact-parameter-cdict-reuse) |

The native copy/hash studies retain 90 timed browser imports and eight separate exhaustive diagnostics across the full locked JMdict, Jitendex and VNDB sources. The six-block screens and independent twelve-block Jitendex assessment remain separate. No slow observation was excluded.

The storage archive distinguishes the initial generic-codec diagnostics, the corrected production-codec timing cohort, and allocation-only observations. Allocation reductions are not presented as elapsed-time or peak-memory improvements.

The earlier runtime optimizations remain in their own PRs: [owned slab cache reuse (#824)](https://github.com/ManabiIO/manabitan/pull/824) and [compact repeated metadata (#825)](https://github.com/ManabiIO/manabitan/pull/825). Their performance claims refer to the frozen revisions documented in those PRs; this follow-up does not transfer old timing results to newly integrated source trees.

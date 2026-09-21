# Raw-v2 empty metadata encoding candidate

## Decision

Draft candidate, not release-qualified. No whole-import speedup is claimed. No import flag, storage layout, migration, or lookup algorithm changes are included.

The shortcut in `encodeRawTermContentBinary` avoids three empty `TextEncoder.encode` calls and their temporary arrays when rules, definition tags, and term tags are all empty. The output remains a separately owned buffer with the same raw-v2 bytes. Nonempty combinations use the original implementation. Native/precomputed/raw-token content paths can bypass this function.

## Baseline and source identity

- Develop commit: `0cbf216a69d66518759cc53d3810d70ca1b18501`.
- Baseline production blob: `b2c71185cb7ee72b186dabdd2fefafe545e38a7c`.
- Candidate production blob: `4bfeaa2aca436562d6741b8f908d91e3900e557b`.
- Baseline SHA-256: `2adadb4bcdeb3c5db36d5ed6386b6a40fa16c864f9c6aaac49f109235fc66d87`.
- Candidate SHA-256: `de373ebce40a1569d846f6e6725a1fd4548bc58f86163bdcab6936fa54a4b920`.

## Measurements before publication

Node v22.16.0, V8 12.4.254.21-node.26, Linux x64, AMD EPYC 9V74, four available CPUs. Each workload has 24,000 rows. Six paired warmups precede nine alternating ABBA/BAAB blocks. Explicit garbage collection is outside timing. Full byte equality is checked outside timing, and output checksums are consumed inside timing.

The timed boundary is the complete raw-v2 encoder, including output allocation and copying. Glossary JSON and its source UTF-8 bytes are prepared outside timing. This excludes ZIP parsing, native conversion, compression, SQLite, OPFS, UI, and peak-memory measurement.

Changes below are the arithmetic median of each block's paired percentage change, not a ratio of independently selected median times. Negative means less time.

| Synthetic workload | Run 1 | Independent repeat |
| --- | ---: | ---: |
| All metadata empty, small glossary | -67.56% | -68.50% |
| All metadata empty, medium glossary | -47.16% | -44.62% |
| 75% of rows have all three fields empty | -47.46% | -48.22% |
| Nonempty metadata control | +4.48% | +1.28% |
| Escaped metadata control | -3.18% | -19.85% |

Both empty workloads and the mixed workload improved in all 18 paired blocks across these two runs. Small and medium refer to 64- and 1,024-character glossary filler strings plus the surrounding JSON and row-specific text, not total payload sizes.

The nonempty control regressed in both runs. A separate nine-block A/A control using identical production source measured -4.17% on that workload and up to -5.07% across the controls, demonstrating material noise; that does not establish that the candidate's regression is harmless. Do not promote until browser and real-corpus measurements resolve the nonempty cost. Do not claim the noisy escaped-control result as an intended speedup.

Two earlier six/eight-block prototype runs also improved the empty case, but are not substituted for the exact-source runs above. A separate equal-key compaction shortcut was rejected because its repeat results were inconsistent.

## Reproduction

Use two worktrees, with the baseline pinned to the commit above. Run from the candidate worktree:

```sh
node --expose-gc dev/perf/bench-raw-term-content-20260921.mjs \
  --baseline=/tmp/manabitan-base/ext/js/dictionary/raw-term-content.js \
  --output=/tmp/raw-content-encoding.json --rounds=9
node --test test/util/raw-term-content-encoding-cases.js
```

The benchmark writes environment metadata, source hashes, complete individual timings, paired blocks, output hashes, and summaries. Repeat with the same candidate and baseline, then use two copies of the baseline for an A/A control. `--candidate` can override the default candidate module; `--operation=references` separately measures reference-write validation cost.

The measured harness SHA-256 was `a07ae14469868bd1c46983855b02600391ba55862e984d13ae2e0c30ad8142ea`. The published harness adds strict types, resolves dynamic imports through URL strings, and names/guards the garbage collector outside timing. The measured harness and original raw JSON are retained in the accompanying review bundle; its smoke run after those harness-only edits is not used as qualification evidence.

## Correctness and remaining qualification

65 native tests pass against the complete candidate module and its real JSON dependency. Coverage includes all empty-field masks, an independent canonical binary oracle, Japanese and supplementary Unicode, BOMs, NULs, lone surrogates, glossary subviews and length boundaries, independent ownership, counted encoder calls, and 4,000 seeded mixed rows. The baseline passes 64 cases and fails the allocation-skip assertion. A Vitest wrapper runs these cases in repository CI.

Node syntax and focused strict TypeScript checks pass locally. Full repository CI is tracked on the PR. Real JMdict/Jitendex and larger-archive imports, browser timing, SQLite/OPFS end-to-end performance, peak memory, and format-path frequency remain unmeasured. This candidate is separate from the raw-reference correctness repair in PR #125.

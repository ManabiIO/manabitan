# WASM inflater validation — September 8, 2026

## Decision and source

**Draft: a repeatable component improvement, but only a modest whole-import signal.** Jitendex's paired median is about 1.15% lower on both runners; the second interval includes zero. JMdict's first improvement did not repeat. Do not advertise the component result as an equal import speedup or a general cross-device win.

Baseline: PR #20 `394d8eb799dd1eb5e194cee11472a4beab915080`, not release main or upstream Yomitan. Tested source: `1a48eb3ef7da950a1ab55716c2ac2f725741b9ba`, tree `0bd78b4f115919a4e984c929faff2af67f3881e1`. Later documentation commits do not change executable code.

The two miniz changes select its existing 64-bit bit buffer for WebAssembly and use overlap-safe bulk copying for history matches of at least nine bytes whose length is no greater than distance. Existing bounds checks precede copying. Short-distance self-repeating matches retain forward expansion. A new test file adds 33 tests, including 1,792 controlled fixed-Huffman distance/length/alignment cases.

No API, JSON rules, storage format, compression level, cache limit, deduplication policy, worker default, progress event, or UI changes. CRC, exact-size, and trailing-input checks remain enabled. No older ZIP, scanner, dense-rehash, cache-copy, or descriptor/string-copy experiment is included.

## Whole imports

Each comparison uses 12 adjacent AB/BA pairs per dictionary: 72 measured fresh-profile imports plus six excluded warmup imports. Dictionary order rotates. Dependencies, pinned fixtures, corrected PR #20 schema-3 harness, and production defaults match. No traces/screenshots/process sampling during timing, no outlier removal, no optional stopping, and no pooling runners.

Boundary: browser file-input change to current-operation post-UI completion, not physical paint. Worker-RPC and automation-observed intervals remain separate. Percentages are medians of within-pair ratios, not ratios of the two time medians. Negative means faster. Intervals are exploratory, unadjusted 20,000-resample percentile bootstrap intervals for paired medians.

Both runners use four logical CPUs, approximately 16 GiB RAM, Ubuntu 24.04, Node 24.20.0, Playwright 1.63.0, Chromium 153.0.8010.12, and clang 18.1.3. First runner: AMD EPYC 7763. Confirmation: Intel Xeon Platinum 8573C. Confirmation uses immutable source commits; its corresponding WASM binaries match the first run byte-for-byte.

| Run          | Dictionary | Baseline ms | Candidate ms | Paired change | Faster |     95% interval |
| ------------ | ---------- | ----------: | -----------: | ------------: | -----: | ---------------: |
| First        | JMdict     |      1554.9 |       1532.7 |        -0.83% |  10/12 | -3.19% to -0.42% |
| First        | JMnedict   |      1393.6 |       1389.8 |        +0.29% |   6/12 | -1.47% to +2.80% |
| First        | Jitendex   |      2777.7 |       2737.2 |        -1.15% |  11/12 | -2.38% to -0.26% |
| Confirmation | JMdict     |      1446.7 |       1450.4 |        -0.03% |   6/12 | -2.55% to +3.20% |
| Confirmation | JMnedict   |      1308.8 |       1299.6 |        -1.46% |   7/12 | -3.96% to +1.75% |
| Confirmation | Jitendex   |      2526.3 |       2502.8 |        -1.14% |   7/12 | -3.45% to +0.26% |

All 156 measured/warmup reports pass exact title/revision/row counts, 12 readable-content probes, and no errors/fallback/skipped verification. Every run's harness/lock/package hashes are audited. Equal compressed-input counters prove both sides exercised the modified inflater. These are sampled persisted-content checks, not exhaustive database equality.

## Component evidence and correctness

Preloaded single-WASM inflation, CRC, and wrapper compaction on a local Xeon Platinum 8370C, one-CPU affinity, four-core quota, 4 GiB limit, Node 24.20.0, clang 17: twelve confirmation pairs each gave JMdict **-10.31%**, JMnedict **-12.98%**, Jitendex **-8.96%**, all 12/12 faster. Initial isolated four-pair experiments are retained separately. This excludes startup, storage, and UI.

An exploratory Chromium component check using actual CI-built binaries gave **-11.91% / -13.66% / -6.14%**, with 5/6, 6/6, and 5/6 faster pairs. A missing optional headless-shell executable caused a pre-timing launch failure; the completed run used the pinned full Chromium executable.

- Local and CI full suites: **5,422 passed, 46 existing skips, 152 files**; options **25 passed**. All four TypeScript projects, focused new-test lint, and all-target build dry run pass. Repository-wide lint/CI is not claimed green.
- First verification's strict full Chromium E2E: **82 phases pass without skips**, including concurrent lookup, interrupted updates, restart persistence, batch import, hover/search, and deletion. Confirmation repeats boundary tests and timing, not full E2E.
- All **338 term banks / 754,052,959 raw decompressed bytes** match independent ZIP decompression and both implementations. Repeated on local clang-17 and actual CI clang-18 modules.
- **1,280 valid generated plus 11,520 modified/truncated/trailing-input cases**: zero status/byte/guard differences, repeated on CI binaries. Some modified inputs may remain valid.
- A separate test-only streaming wrapper passes **384 cases per arm**, covering fragmented input, wrapping/nonwrapping output, raw/zlib streams, repeated 32 KiB history, four levels, and guards. It is not part of the committed 33-test suite.
- The saved three-file product patch reconstructs the tested tree exactly. No generated bundle or verification workflow is in the product diff.

## Evidence and limits

[First completed run 34280922194](https://github.com/ManabiIO/manabitan/actions/runs/34280922194): artifact `inflate-core-verification` (10078040841), SHA-256 `6185e4a1ac95529b53ee379cf7db6e2aa3bc09201fbd62e93b2ff8894d737a8f`.

[Completed confirmation 34282494230](https://github.com/ManabiIO/manabitan/actions/runs/34282494230): artifact `inflate-core-confirmation` (10078474070), SHA-256 `918fb52951fdb853e2d6304e99182857ddbbf8c4210c9fb48ef4bdac5cf4a5ca`.

Both archives were downloaded and audited. They retain every pair/report, source/build fingerprints, and measured WASM binaries; the first also retains full validation logs. Actions retention is 14 days. The delivered `manabitan-inflater-source-and-evidence.zip` preserves those archives, all paired values, local validation, and rejected experiments without fonts, dictionaries, dependencies, or browser binaries.

Actual CI WASM SHA-256: baseline `3f9e47b17109cdcada5c9c4c6bcd584bab9d8263a3add46e6bf8c772b0cd1f56`; candidate `da170cae914093e14d27b74944b68ac041f041342bf26368934a7d090b25fdd4`. Local clang-17 candidate: `e2fa243a8754b45729997550f885de180708d6226e0ef7b74ee6c068ed105ebd`.

Firefox, ARM, and 32-bit hosts are unvalidated. Lower-memory configurations selecting ZIP-worker inflation do not use this modified decoder; no benefit is claimed there. PR #20's earlier Firefox/parser sign-off concerns remain separate. No release branch or previous PR was merged.

Recovered scanner/dense results remain mixed. The new owned-cache-copy experiment had -1.09% / -1.19% / +0.32% paired changes and was not promoted or combined. A local cache-copy browser run was interrupted after severe memory pressure; its partial evidence and stop reason are retained, with no effect estimate used. Failed preflights and diagnostic traces are excluded from authoritative timing.

Reproduce with independent source worktrees, locked fixtures, and the corrected `dev/perf/import-benchmark.js` / `mise run perf:import` entrypoint. Run traces separately. [RFC 1951](https://www.rfc-editor.org/rfc/rfc1951.html) and [WebAssembly memory.copy](https://webassembly.github.io/spec/core/exec/instructions.html#exec-memory-copy) establish semantic constraints, not performance expectations.

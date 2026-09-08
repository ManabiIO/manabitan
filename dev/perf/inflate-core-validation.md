# WASM inflater validation — September 8, 2026

## Decision

**Draft: a repeatable component improvement, but only a modest whole-import signal.** Jitendex's median paired improvement is approximately 1.15% on both independent runners. The second run is noisier and its interval includes zero. The first JMdict improvement did not repeat. Do not advertise the component's double-digit improvement as an equivalent import speedup or merge this as a general cross-device win.

Baseline: PR #20 commit `394d8eb799dd1eb5e194cee11472a4beab915080`, not release main or upstream Yomitan.

Exact tested source commit: `1a48eb3ef7da950a1ab55716c2ac2f725741b9ba`.

Exact tested source/test tree: `0bd78b4f115919a4e984c929faff2af67f3881e1`. This documentation follows that commit and does not change executable code.

## Change

- Select miniz's existing 64-bit bit buffer for WebAssembly. Its architecture heuristic previously selected 32-bit buffering for wasm32, despite WebAssembly's i64 arithmetic. No new build feature is enabled.
- Use overlap-safe bulk copying for history matches of at least nine bytes with length no greater than distance, after the existing bounds checks. Those source bytes already exist. Preserve the original forward expansion for short-distance self-repeating matches.
- Add 33 regression tests, including 1,792 controlled fixed-Huffman distance/length/alignment cases.

No parser API, JSON rules, storage format, cache limits, deduplication policy, worker-count default, compression level, progress event, or UI behavior changes. Input/output bounds, CRC, exact-size, and trailing-input checks remain enabled. The older ZIP splitter, scanner, dense-rehash, cache-copy, and descriptor/string-copy experiments are excluded.

## Completed whole-import comparisons

Each run uses 12 adjacent AB/BA pairs per dictionary: **72 measured fresh-profile imports plus six separately excluded warmup imports**. Dictionary order rotates. Both builds use the same pinned dependencies, dictionaries, corrected PR #20 schema-3 timing harness, and production import defaults. No traces, screenshots, or process sampling run during timing. No outliers are removed and different runners are not pooled.

Timing: browser file-input change through the current operation's post-UI import-complete event. This is not a physical-paint measurement. Worker-RPC and automation-observed intervals remain separate.

Percentages below are medians of within-pair `(candidate / baseline - 1) * 100`, not ratios of the two independent time medians. Negative means less time. Intervals are exploratory, unadjusted 20,000-resample percentile bootstrap intervals for paired medians.

### First runner

[Completed run 34280922194](https://github.com/ManabiIO/manabitan/actions/runs/34280922194): AMD EPYC 7763, four logical CPUs, approximately 16 GiB RAM, Ubuntu 24.04, Node 24.20.0, Playwright 1.63.0, Chromium 153.0.8010.12, clang 18.1.3.

| Dictionary | Baseline median ms | Candidate median ms | Paired change | Faster pairs | Exploratory 95% interval |
| ---------- | -----------------: | ------------------: | ------------: | -----------: | ----------------------: |
| JMdict | 1554.9 | 1532.7 | -0.83% | 10/12 | -3.19% to -0.42% |
| JMnedict | 1393.6 | 1389.8 | +0.29% | 6/12 | -1.47% to +2.80% |
| Jitendex | 2777.7 | 2737.2 | -1.15% | 11/12 | -2.38% to -0.26% |

### Fresh-runner confirmation

[Completed run 34282494230](https://github.com/ManabiIO/manabitan/actions/runs/34282494230): Intel Xeon Platinum 8573C, four logical CPUs, approximately 16 GiB RAM; same runtime/compiler versions. This comparison uses immutable baseline and published candidate commits. Each resulting WASM binary is byte-identical to the corresponding binary from the first runner.

| Dictionary | Baseline median ms | Candidate median ms | Paired change | Faster pairs | Exploratory 95% interval |
| ---------- | -----------------: | ------------------: | ------------: | -----------: | ----------------------: |
| JMdict | 1446.7 | 1450.4 | -0.03% | 6/12 | -2.55% to +3.20% |
| JMnedict | 1308.8 | 1299.6 | -1.46% | 7/12 | -3.96% to +1.75% |
| Jitendex | 2526.3 | 2502.8 | -1.14% | 7/12 | -3.45% to +0.26% |

Every one of the 156 measured/warmup import reports passes exact title/revision/row-count checks, 12 readable-content probes, no import/settings errors, and no fallback/skipped verification. Every run's harness/lock/package fingerprints are re-audited. Compressed-input counters prove that the modified WASM inflation route ran, with identical per-dictionary compressed/uncompressed byte totals on both sides.

These persisted-content probes are sampled checks, not exhaustive database equality.

## Component results — not import speedups

A separate preloaded single-WASM benchmark measures inflation, CRC, and bank-wrapper compaction only. Local Linux x64 Intel Xeon Platinum 8370C, four-core quota, 4 GiB limit, one-CPU affinity, Node 24.20.0, clang 17. All bytes are checked outside timing.

After initial isolated four-pair trials of each change and the combination, the frozen combined candidate completed 12 new pairs per dictionary:

| Dictionary | Baseline component median ms | Candidate component median ms | Paired change | Faster pairs |
| ---------- | ---------------------------: | ----------------------------: | ------------: | -----------: |
| JMdict | 566.4 | 505.4 | -10.31% | 12/12 |
| JMnedict | 279.7 | 240.2 | -12.98% | 12/12 |
| Jitendex | 1436.5 | 1328.6 | -8.96% | 12/12 |

An exploratory six-pair Chromium 153 component check using the actual CI-built binaries also had lower paired medians: -11.91%, -13.66%, and -6.14%, respectively, with 5/6, 6/6, and 5/6 faster pairs. Its first launch failed before timing because the offline bundle lacked the optional headless shell; the completed run used the pinned full Chromium executable.

## Correctness

- Local and independent CI full unit suites: **5,422 passed, 46 existing skips, 152 files**. Separate options: **25 passed**. All four TypeScript projects, new-test focused lint, and all-target build dry run pass. Repository-wide lint/CI is not claimed green.
- Strict full Chromium E2E from the first verification run: **82 phases pass without skipped verification**, including concurrent lookup, interrupted-update recovery, updates, restart persistence, batch import, hover/search, and deletion. The confirmation run repeats boundary tests and measurements, not the full E2E suite.
- All **338 term banks / 754,052,959 decompressed bytes** match independent ZIP decompression and both implementations byte-for-byte. Repeated using local clang-17 modules and the actual downloaded clang-18 CI modules.
- **1,280 valid generated inputs plus 11,520 modified/truncated/trailing-input cases** produce zero status, output-byte, or output-guard differences. Repeated on the actual CI binaries. Some modified inputs may remain valid.
- A supplementary test-only streaming wrapper passes **384 cases per arm**: fragmented input down to one byte, wrapping/nonwrapping output, raw DEFLATE/zlib streams, repeated 32 KiB history, four compression levels, and output guards. It is separate from the committed 33-test suite.
- The saved three-file product patch reconstructs the tested Git tree exactly. No generated bundle or verification workflow is part of the product diff.

## Provenance and retained evidence

Actual first-run and confirmation WASM SHA-256:

- Baseline: `3f9e47b17109cdcada5c9c4c6bcd584bab9d8263a3add46e6bf8c772b0cd1f56`.
- Candidate: `da170cae914093e14d27b74944b68ac041f041342bf26368934a7d090b25fdd4`.

Local clang-17 candidate: `e2fa243a8754b45729997550f885de180708d6226e0ef7b74ee6c068ed105ebd`. Compiler-specific binaries are identified separately.

Raw GitHub artifact `inflate-core-verification` (10078040841), SHA-256 `6185e4a1ac95529b53ee379cf7db6e2aa3bc09201fbd62e93b2ff8894d737a8f`, retains every first-run report, source diff, build/test log, and both measured WASM binaries. `inflate-core-confirmation` (10078474070), SHA-256 `918fb52951fdb853e2d6304e99182857ddbbf8c4210c9fb48ef4bdac5cf4a5ca`, retains every confirmation report and binary. Both were retrieved and independently audited; they are not merely submitted jobs. Actions retention is 14 days; the delivered evidence bundle also preserves these complete archives, all paired values, local validation, and rejected experiments without fonts, dictionaries, dependencies, or browser binaries.

## Limits and exclusions

Only Linux x64 Chromium is performance-tested. Firefox, ARM, and 32-bit host devices are unvalidated. Lower-memory configurations selecting ZIP-worker inflation do not use this modified decoder; no whole-import benefit is claimed for that route. PR #20's pre-existing Firefox/parser sign-off concerns are separate and unresolved.

The earlier scanner and dense comparisons were recovered and remain mixed. The new owned-cache-copy experiment had approximately -1.09% / -1.19% / +0.32% paired changes and was not combined or promoted. A local whole-browser cache-copy run was interrupted after severe 4 GiB memory pressure; its partial evidence and stop reason are retained, but no effect estimate is used. Failed preflight attempts and diagnostic traces are explicitly excluded from authoritative timing.

No release branch or previous PR was merged. Reproduce with independent source worktrees and the repository's corrected `dev/perf/import-benchmark.js` / `mise run perf:import` entrypoint, pinned fixtures, identical builds except the candidate, and adjacent counterbalanced runs. Run traces separately.

Semantic references: [DEFLATE RFC 1951](https://www.rfc-editor.org/rfc/rfc1951.html) and [WebAssembly memory.copy](https://webassembly.github.io/spec/core/exec/instructions.html#exec-memory-copy). These constrain correctness; they do not establish performance.

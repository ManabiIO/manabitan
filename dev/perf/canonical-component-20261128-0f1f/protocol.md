# Frozen canonical component experiment

This is a prospective component experiment for two source transformations of the native canonical scan. It does not measure dictionary import completion, parsing, compression, storage, worker transport, process startup, or whole-process memory. Neither candidate changes the canonical algorithm, arena capacities, publication policy, or scheduling.

## Frozen inputs

`protocol.json` binds the baseline commit, baseline and candidate C sources, three exact WASM module digests, Node and LLVM versions, the Playwright version, the full Chromium executable version and digest, the locked JMdict archive, and the snapshot inventory. `source-inventory.json` binds the acquisition scripts, analyzer, candidate source files, protocol, and expected snapshot inventory.

The baseline is commit `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The candidates are reported independently: the full row helper and the smaller reservation helper. The helper sources are frozen before any component timing. Prior source-bound correctness checks cover ordinary behavior, allowed aliases, boundary inputs, late errors, rollback state, and repeated traps. Those checks are correctness evidence, not speed measurements.

The untimed capture uses the production parser and grouping logic with four logical CPUs, 8 GiB device memory, and three parser workers. It contains all 528,299 JMdict rows in twelve groups: 366,030 unique rows enter the native scanner, with 362,032 pending rows and 3,998 exact recent-source matches. Each native arena has 400 pages, or 26,214,400 bytes. Persistence offsets are deterministic surrogates; they do not enter the captured native arenas. Compression, record serialization, and OPFS persistence are outside this capture.

The repository stores only the expected inventory. The hosted runner regenerates compressed before images and XOR after images from the locked archive. Compressed and decompressed sizes and digests must match the inventory byte for byte. The combined compressed corpus is 63,654,684 bytes. The complete native output for every group must match before timing begins, for all three modules.

## Independent acquisition cells

Each candidate receives a separate hosted job. Cells are never pooled. Each cell follows the complete 36-observation schedule in `protocol.json`: six repetitions of an AB comparison pair, a BA comparison pair, and an AA identical-code control pair. This gives twelve candidate/baseline pairs and six baseline/baseline controls. The arm order and observation IDs are fixed in advance.

Every observation launches a new Node child, a new full Chromium process, a new browser context, one dedicated worker, and one fresh module instance. The explicit executable path selects the hash-bound full Chromium binary instead of Playwright's separate headless-shell binary. The experiment supplies no V8 flags, tracing flags, altered tiering settings, warmup loop, or artificial native calls. Standard Playwright launch arguments are recorded. The browser process is destroyed after the observation, and the fixed delay between observations is 500 ms. Acquisitions from a rerun of the workflow are rejected.

The local HTTP server uses the standard `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers, with same-origin resource policy. The worker must report `crossOriginIsolated === true`. This controlled component setting allows the browser's higher-resolution isolated timer; it does not change WASM memory or VM settings and makes no claim about production extension isolation policy.

Within one observation, the worker makes two ordered passes over the same twelve captured input arenas using the same module instance and fixed-size memory. Before every call, it fetches and validates the complete before and expected-after images, then restores the arena. It measures only the direct `scan_canonical()` invocation with `performance.now()`. After the interval, it compares all arena bytes, calculates the output SHA-256, and verifies the return value. It persists the result before advancing to the next call. A failure retains all previously completed calls and any failing native-call result that was obtained.

There is no request to force a compilation tier. The first call includes any natural first-call compilation that falls inside the invocation. The second pass is a declared second pass, not a claim that the VM has reached a particular steady state. Transport, hashing, restoration, verification, and persistence occur between calls and can allow background compilation to progress. These gaps differ from production importer scheduling, so the twelve-call component sum cannot be treated as a whole-import prediction.

The primary metric is the sum of native intervals in the first twelve-call pass. The second-pass sum is the prespecified check for recurring call overhead. All five metrics are reported together:

| Metric                  | Native intervals included   |
| ----------------------- | --------------------------- |
| `firstCallMs`           | Pass 1, group 1             |
| `remainingFirstPassMs`  | Pass 1, groups 2 through 12 |
| `firstPassSumMs`        | Pass 1, all twelve groups   |
| `secondPassSumMs`       | Pass 2, all twelve groups   |
| `secondPassFirstCallMs` | Pass 2, group 1             |

## Validation and failure policy

The exact protocol, source inventory, snapshot inventory, browser executable, module, scheduled observation, ordered 24 calls, return values, arena digests, and complete-memory comparison must all agree. Timing intervals must be finite and positive. Source, protocol, snapshot-inventory, workflow, and module identities are rechecked at cohort end. Any missing, duplicate, reordered, failed, or drifted observation invalidates the cell's aggregate qualification. No observation is silently excluded. Ordinary observation failures do not trigger retries or alter the remaining fixed schedule. Each observation has a 120-second deadline, with a 15-second controller cleanup allowance.

All input identities, regenerated compressed snapshots, generated modules, compiler arguments, host details, launch arguments, per-call partial reports, child logs, failures, and analysis are retained. Setup or acquisition failure still produces an invalid analysis when the analysis inputs are available. A candidate is not promoted on component results alone.

## Analysis fixed before acquisition

`analyze.py` reports each comparison pair and identical-code control, all five metrics, median paired percentage changes, equal-work percentage changes, median paired absolute differences, faster-pair counts, and both tails. A negative candidate-over-baseline percentage means a lower native-call time. The comparison orientation remains candidate over baseline for both AB and BA acquisition orders.

The descriptive interval resamples complete adjacent pairs 20,000 times with seed `0x0f1f2026`, using the 2.5th and 97.5th percentiles of the sampled paired medians. Individual native calls are not treated as independent observations. The interval is descriptive; it is not an automatic promotion gate. Both candidate cells, all controls, all metrics, and all tails remain visible. There is no adaptive rerun, outlier removal, posthoc winning-cell selection, or engine pooling.

## Reproduction

The one-shot workflow is `.github/workflows/canonical-component-20261128-0f1f.yml`. It creates a detached baseline product worktree, installs the locked dependencies, rebuilds baseline runtime libraries, verifies the locked fixture, rebuilds all three modules with the pinned LLVM toolchain, regenerates and verifies all snapshots, then runs each fixed cohort. The workflow runs the independent analyzer even if acquisition fails and uploads every retained artifact.

`check-harness.mjs` checks the browser-worker sequencing and failure protocol using a fake native export and a fake clock. It covers all 24 ordered calls, a late input mismatch, a differing final arena byte, a bad native return, a native trap, an out-of-order acknowledgement, and a worker isolation mismatch. It performs no native compilation or performance measurement.

No local Chromium acquisition was attempted for this experiment because the workspace blocks its required sockets. The only local execution for this frozen component design is untimed correctness, source/lowering inspection, and synthetic acquisition-contract validation. Separate earlier compilation diagnostics are retained as mechanism evidence and are excluded from this cohort.

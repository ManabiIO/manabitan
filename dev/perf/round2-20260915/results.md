# Import optimization round two — September 15, 2026

## Decision

**Seven additional source-isolated candidates were implemented and A/B-tested on complete JMdict and Jitendex imports. None is being promoted to an optimization PR.** Small/mixed initial results did not justify additional runtime code. The initially promising empty-string shortcut failed independent replication. This is a negative result, not evidence that these mechanisms can never help on another workload.

This review starts from `develop` commit `30ffb604e0a87f0aa252bd4331bc54668062b1e1`, tree `c069f4ca92d8e6902a1a182281a06b2579610c05`. It does not include or depend on [PR #39](https://github.com/ManabiIO/manabitan/pull/39). That PR's code remains at `e456fba18b7383ebbade745f2b41bfe2d8a3733f`; it was rechecked as open and unmerged. `develop` was rechecked after testing and is unchanged.

All candidate patches, drivers and these results are retained on the verification branch. No candidate from this round was merged; no product defaults, release refs, native Reader code or vendor pins changed. No new optimization PR was opened merely to retain a favorable first measurement.

## Completed whole-import comparisons

Values are `median(100 * (B_ms / A_ms - 1))` over adjacent matched pairs. **Negative is faster, positive is slower.** These are observed paired changes, not differences between separately calculated medians or confidence bounds. A/A compares the baseline binary with itself under the same labeling and timing protocol.

Every initial cell below contains six alternating AB/BA pairs, three interleaved A/A pairs, and an excluded complete warmup for each arm. Each candidate/dictionary cell has its own host; comparisons within a cell are serial. Hosts are not pooled.

| Isolated candidate | JMdict import | Jitendex import | A/A median: JMdict / Jitendex |
| --- | ---: | ---: | ---: |
| `int-span`: Single-pass score/sequence integer parsing | -0.377% | +0.988% | +0.857% / +0.950% |
| `equal-simd`: Bounded SIMD exact-content equality | +1.195% | +0.060% | +0.298% / -0.382% |
| `escape-word`: Word-sized escaped-key detection | -0.463% | +0.015% | +0.197% / -1.481% |
| `cheap-guards`: Short rules/tag checks before glossary comparison | -0.409% | -0.875% | -1.367% / +1.577% |
| `signature-loads`: Fixed-width reads of unchanged signature samples | +0.176% | -1.347% | +1.478% / -2.315% |
| `empty-strings`: Immediate recognition of empty JSON strings | -7.713% | -0.144% | -0.028% / +4.200% |
| `content-word-compare`: Word-sized JavaScript content comparisons | +1.356% | +0.443% | +0.493% / +0.888% |

Only the empty-string candidate advanced to independent replication. The other small and mixed results are retained rather than selecting a favorable aggregate, component number, or dictionary.

### Empty-string replication: initial gain did not repeat

The follow-up used new runners, twelve adjacent alternating pairs, reversed initial order (BA), six interleaved A/A pairs, and excluded full warmups. Source and options were unchanged.

| Dictionary | Initial six-pair median | Independent twelve-pair median | Replication equal-work total | Faster replication pairs | Replication A/A median |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | -7.713% | +1.398% | +0.652% | 4/12 | +0.524% |
| Jitendex | -0.144% | +0.542% | +0.345% | 6/12 | -1.325% |

The initial **7.713% lower JMdict runtime is not a retained speedup claim**. The independent comparison was 1.398% slower by paired median, with only four of twelve pairs faster. Jitendex was also slightly slower by paired median. Correctness validation does not override these performance results.

## What was reviewed and changed

The six C candidates each change only `ext/js/dictionary/wasm/term-bank-parser.c`. The JavaScript candidate changes only two byte-equality helpers in `dictionary-database.js`. Each patch is based directly on the baseline, not stacked on another candidate.

- `int-span` combines scalar token scanning and int32 conversion for score/sequence fields. It retains null/default handling, signed limits, leading-zero rejection, delimiter checks and failure on malformed suffixes. Its tiny/mixed import result does not justify another specialized parser helper.
- `equal-simd` tests bounded 16-byte exact comparisons, retaining eight-byte and scalar tails. It changes neither grammar nor hashes and does not revive the previously rejected SIMD string-scanner stack. It did not improve full imports convincingly.
- `escape-word` replaces byte-by-byte backslash detection with bounded eight-byte word tests and a scalar tail. Ordinary/escaped key behavior and complete key equality remain authoritative. Its small component change did not produce a clear import gain.
- `cheap-guards` reorders the same conjunction so short rules/tag mismatches can reject a candidate before long glossary equality. No hash or sample authorizes reuse. The small observed changes are comparable to control variation.
- `signature-loads` reads the same first/middle/last four-byte signature samples with fixed-width little-endian reads. Short samples and every fingerprint remain identical. This is not a new hash or reduced collision verification. Results were mixed.
- `empty-strings` recognizes two immediately adjacent quotes before entering the general string scanner. It retains the logical end bound and ordinary scanner. The four-line shortcut was correctness-valid but its initial import gain did not replicate.
- `content-word-compare` uses bounded `DataView.getUint32` comparisons plus scalar tails in the existing JavaScript deduplication helpers. Full equality, invalid-span fallback behavior, shared/ordinary buffers and length/type checks remain. Both initial whole-import medians were slower.

The `.patch` files in this directory preserve every attempted source change. The machine-readable evidence bundle records exact source, WASM, package, fixture-lock and harness hashes for each arm.

## Measurement and verification boundaries

There are **16 completed browser cohorts and 356 complete imports** in this round: 108 measured A/B pairs (216 observations), 54 A/A pairs (108 observations), and 32 excluded warmup observations. No import was retried, trimmed or discarded. All comparisons used Node 24.20.0, Clang 18.1.3 and Chromium 153.0.8010.12 on Ubuntu 24.04 x64. Native device capabilities were observed, not overridden to force a route.

Every observation starts with a fresh browser profile and uses real OPFS-SAH-pool persistence. The timing boundary remains the browser file-input change through post-UI import completion. Production worker counts, source admission, batching, concurrency, caches, compression and all ten false experimental flags are unchanged. Timing runs disable traces, screenshots, process sampling and phase profiling. These are warmed-host, fresh-profile results, not separately qualified cold-OS and warm-OS conditions.

The repository fixture lock is unchanged:

| Fixture | Release / revision | Term rows | Archive SHA-256 |
| --- | --- | ---: | --- |
| JMdict | 2026-09-06 / `JMdict.2026-09-06` | 526,942 | `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a` |
| Jitendex | 2026.08.11.0 | 435,448 | `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc` |

All 356 raw browser reports were independently reread against the complete plans. The audit requires exact title/revision/row count, twelve distributed persisted lookup/content probes, real OPFS, no import/settings errors or fallback storage, matching package/source identities, and identical source byte counts, bank counts, group/worker accounting and deduplication totals within each cohort. Maximum individual parser-worker heap bytes also remain equal within every cohort. **This is not an exhaustive persisted-store comparison or a process-tree peak-memory measurement.**

C comparison packages preserve all baseline members except the intended C file and its compiled WASM; the JavaScript comparison changes only its intended JS member and leaves WASM identical. This prevents unrelated worktree-dependent source-map paths from contaminating the comparison. The recorded package identities are frozen throughout each cohort.

Separate four-pair native component checks run every lexical row through resident decoded-bank parsing and completed lookup construction. They compare the complete prepared-index bytes, compact plans and canonical-content digests between sources, outside timing. These checks exclude inflation, worker IPC, global storage deduplication, Zstd, OPFS and UI; their effects are not whole-import gains. The JavaScript database experiment is outside that component boundary and has no invented component result.

## Correctness tests and retained failures

Each of the six C candidates passed the existing 545 focused parser/lookup/composite-state/scanner tests before browser timing. The JavaScript candidate passed its 72 existing content-deduplication tests. These are focused results, not a claim that all seven candidates received the full repository suite.

Four new local regression suites contain 164 tests: 53 key-scanner/collision tests, 54 integer-span tests, 29 empty-string tests and 28 JavaScript byte-comparison tests. Each applicable candidate and unchanged parent passed its new tests. They cover all alignment offsets, boundary tails, physical/logical memory ends, malformed/truncated tokens, independent bank bounds, shared buffers and a real xxHash32 key collision. The tests and local logs are retained in the evidence bundle.

The empty-string candidate received complete additional qualification because its first screen appeared promising. The final exact-source run passed **6,442 unit tests with 46 existing skips; 574 focused tests; 27 options tests; all four strict typecheck projects; new-file ESLint; all-target build plans; and actual Chrome-dev and Firefox-dev package builds**. The 29 new boundary tests also pass against the unchanged parent. Native source SHA-256 is `e3ba0849015956aa97f668795457863b8277dd6936921166ec633e363bcfb970`; the final test blob is `252b59676d8e58af558c210885cd7d5dfd475673`.

The first qualification correctly failed its final outcome gate because the uploaded test had three formatting diagnostics. Its test/type/build steps passed, but it is not relabeled as an entirely clean run. Formatting was corrected without changing assertions or the native candidate, then the full qualification was rerun. Both logs are retained. The final workflow is read-only and explicitly cannot publish a rejected performance candidate. Non-failing inherited bundler warnings remain visible.

No Firefox/Safari performance, native/mobile qualification, complete stored-byte equality or total browser-tree memory guarantee is claimed. No favorable component number overrides the failed replication.

## Exact runs and reproduction evidence

| Purpose | GitHub Actions run | Reviewed input revision |
| --- | --- | --- |
| First four candidates, eight complete cells | [35028487811](https://github.com/ManabiIO/manabitan/actions/runs/35028487811) | `57aa9cf944455e3e6f7f39f0915aa14add25c4b6` |
| Signature and empty-string screens | [35029115878](https://github.com/ManabiIO/manabitan/actions/runs/35029115878) | `50a1b96299568130ea3ce2b3b1dec50957a11ce3` |
| JavaScript word-comparison screens | [35029806746](https://github.com/ManabiIO/manabitan/actions/runs/35029806746) | `aeff8663e162f0fda090fbf2047e1f797706bb62` |
| Independent twelve-pair empty-string replication | [35029658550](https://github.com/ManabiIO/manabitan/actions/runs/35029658550) | `8ba684897c1257965d90dd317ee5c3f5e4c27f54` |
| Initial qualification with retained style failure | [35030036768](https://github.com/ManabiIO/manabitan/actions/runs/35030036768) | `ccb852b32c3a8db2711d234dd19ecafc268186b6` |
| Final read-only, corrected-test qualification | [35030658752](https://github.com/ManabiIO/manabitan/actions/runs/35030658752) | `78ed312e33f1775df88b9c655b4794fc508fe5ca` |

The workflows at these immutable revisions contain setup/build commands and the selected driver/patch inputs. Each timing artifact contains its exact executed driver, source patch, predeclared plan, toolchain and identities, every observation, raw browser reports, and completion marker. Native artifacts also include full-corpus comparison evidence. Artifact retention is 30 days; the separately supplied evidence ZIP preserves all sixteen timing artifacts and both qualification artifacts together with recomputed results, raw timings, tests and checksums.

**Final disposition: retain negative evidence, leave PR #39 untouched, and add no new production optimization from this round.**

# Round six: profile-guided first-special string scanning

September 16, 2026. Retained change: [PR #44](https://github.com/ManabiIO/manabitan/pull/44).

## Decision

Retain the scalar first-special-byte jump. Independent twelve-pair production comparisons measured **3.631% lower JMdict import runtime and 7.365% lower Jitendex runtime**, with **12/12 pairs faster in each dictionary**. The earlier six-pair screens were also favorable in every pair. The result is a complete browser-import improvement, not only an allocation reduction or extrapolated component percentage.

Keep the 16-byte SIMD variant as an unselected alternative: it beat production, but the direct SIMD-versus-scalar comparison did not establish a sufficiently consistent incremental advantage to retain the wider implementation. Reject the unrelated in-flight duplicate-reference range precheck; its results were small, mixed and noisy. Closed PRs #42 and #43 remain closed. No production ref or existing PR was merged by this round.

## Mechanism and research

The old eight-byte string scanner identified whether a quote, backslash or control character occurred somewhere in a word, then resumed scalar handling at the word's beginning. It could repeatedly reclassify overlapping words while advancing through ordinary bytes before the special character.

The retained change combines the existing masks and uses a guarded trailing-zero count to jump to the first marked byte. The old scalar escape/quote/control handling and logical bounds remain unchanged. On little-endian WASM, subtraction borrows can mark a later byte spuriously, but cannot move the first marked byte before the first true match. The code records that constraint and the conformance tests exercise it. No padding, overread, new SIMD requirement, deferred validation or lookup-time work is introduced.

Research: [Langdale and Lemire, Parsing Gigabytes of JSON per Second](https://arxiv.org/html/1902.08318v7) motivated examining byte masks and position extraction rather than repeating character-level work. [V8's SIMD documentation](https://v8.dev/features/simd) informed the separate vector alternative. Neither source is evidence of a Manabitan speedup; the actual A/B runs decide retention. No new parser dependency was added.

Fresh baseline traces were collected for both dictionaries. Idle samples and SQLite async-proxy waiting are not active CPU work, and concurrent phase/sample durations are not added into an end-to-end CPU percentage. A local named-WASM map used Clang 17 and is a diagnostic aid, not a verified symbol map for every Clang 18 profile index.

## All complete browser cohorts

Values are `median(100 * (B_ms / A_ms - 1))` over adjacent matched pairs. Negative is faster. Each cohort runs its arms serially on one host; different hosts and comparison baselines are not pooled. Complete warmups are excluded, A/B order alternates, and A/A controls are interleaved. No completed observation was retried, trimmed or removed.

| Comparison | Pairs per dictionary | JMdict | Jitendex | A/A median: JMdict / Jitendex |
| --- | ---: | ---: | ---: | ---: |
| Production A vs scalar jump B, initial | 6 | -4.990% | -8.628% | +0.572% / -1.565% |
| Production A vs SIMD jump B, initial | 6 | -5.881% | -8.022% | +0.364% / +1.251% |
| Production A vs in-flight range precheck B | 6 | +0.842% | -0.434% | +4.750% / -4.251% |
| Production A vs scalar jump B, independent, starting BA | 12 | **-3.631%** | **-7.365%** | +2.636% / -0.374% |
| SIMD A vs scalar jump B, direct comparison | 6 | +0.421% | +0.732% | -1.007% / -1.344% |
| Libdeflate A vs libdeflate plus scalar jump B | 6 | -5.913% | -8.397% | -0.728% / -1.607% |

The primary independent production comparison was faster in all twelve pairs for each dictionary. Equal-work total changes were -3.596% JMdict and -7.832% Jitendex. Per-arm medians were 1,613.55 / 1,560.50 ms and 2,860.75 / 2,639.00 ms. Paired percentages are not calculated from ratios of those separately computed medians.

The direct SIMD/scalar comparison retained +22.750% and +26.371% scalar outliers. The libdeflate comparison retained a +8.745% JMdict scalar pair and a -29.464% Jitendex pair; it was faster in 5/6 JMdict pairs and 6/6 Jitendex pairs. This smaller combined-backend cohort supports compatibility and a surviving benefit, not a replacement for the independent production result. Do not add #41's earlier percentages to #44's percentages.

There are **276 complete authoritative browser observations across twelve cohorts**: 84 measured pairs (168 observations), 42 A/A pairs (84 observations), and 24 excluded full warmups. Two additional diagnostic profiled imports and full lifecycle suites are not included in this timing count. The retained scalar candidate has 116 production-baseline observations; sibling and combined-backend comparisons remain separately labeled.

## Controls and complete corpus

Baseline: `b4094a423c20bb0ed424d944238f922c1b36559c`, tree `604c5c2b64b8d217e87895dbd981aa3a30579bcb`, already containing #39/#40. It was not replaced by a closed allocation experiment or an experimental flag configuration.

Locked JMdict 2026-09-06: 526,942 rows, ZIP SHA-256 `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a`.
Locked Jitendex 2026.08.11.0: 435,448 rows, SHA-256 `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc`.

Ubuntu 24.04 x64, Node 24.20.0, Clang 18.1.3, Chromium 153.0.8010.12. Real OPFS-SAH-pool storage, fresh browser profiles on warmed hosts, production source/worker/batching budgets, `{}` flags and ten false actual worker receipts. The timer spans file-input change through post-UI completion; tracing, profiling, screenshots and process sampling are disabled for timing.

A and B packages were actually built at the same filesystem path. Only the intended C source and WASM, or the one intended JavaScript file for the rejected range candidate, may differ. No archive member substitution or comment normalization is used. Source, native module, archive, lockfile and harness identities are frozen and checked throughout each cohort.

The independent offline audit reconstructs every timing from the raw browser report and verifies the entire plan, clean source/archive identities, exact title/revision/row count, twelve persisted content probes, real storage mode, actual settings and equal work. Source-byte totals, bank/group/worker counts, deduplication counts and content/record/index write totals match. Individual parser-worker maximum heaps remain 55,967,744 bytes for JMdict and 78,512,128 for Jitendex. Those are not total process-tree peak-memory measurements.

The resident parser-plus-completed-lookup checks use their unchanged component grouping and compare full canonical-content/prepared-index digests and index sizes. The independent scalar component checks measured -17.486% JMdict / -25.374% Jitendex over two pairs; these exclude inflation, persistence, IPC and UI and are not whole-import estimates. All corresponding digests agree.

## Correctness and exact publication

Qualified head: `78837c89c3d251fcedebc8ecaf14a4c2c2c1f6cb`; tree `de6e56e27ebb5503cdd36a07e0e1eba475b2eb33`.
Source SHA-256: `25d1c8054ad0978466eeb1cb7e7be8865673efb6b672b9bd9a1066b90b40b1e3`.
Measured and qualified WASM: `4da14e1bdb67de0bcee79982961337e86901bb86439ac0ccef878820326d8e52`.
New test Git blob: `2d051a2f20467dce052efdaa12f8913f6cde172c`.

The exact-source qualification passed **6,497 unit tests, 46 existing skips, 602 focused tests, 27 options tests, all four strict typecheck projects, new-file lint, build plans and actual Chrome/Firefox development builds**. The full strict Chromium lifecycle completed **84 phases with skippedVerification=false**.

Thirty-one new actual-WASM tests cover nearest-marker handling, subtraction-borrow cases, Unicode/escapes, all raw controls, alignment, logical and physical memory ends, truncated prefixes, independently bounded bank documents, nested glossaries, media metadata and malformed escapes. They also pass on the unchanged parent; they are correctness equivalence tests, not invented failure-first functional bugs.

An independent native scalar scanner oracle checked **1,250,784 cases under ASan and UBSan with leak detection**, including all adjacent byte pairs at sixteen positions, randomized bytes/start offsets, and valid/truncated escape strings. The exact candidate helper was extracted from the tested C file. Host-native sanitizers supplement actual WASM boundary tests.

Exploratory local logs retain a mocked worker-scheduling timeout and a test-literal lint error fixed before qualification. Local Node 22.16/Clang 17 runs are not relabeled as current-base CI results. Authoritative qualification passed without retrying or changing the measured C source. Existing non-failing bundler warnings remain in the logs.

## Integration with open libdeflate PR #41

Both arms include exact #41 head `726c5b7444a1b3c131c90de356f8261ac2fe65a2`; only B includes the scalar scanner change. These are ephemeral compositions, not remote merges. Combined runtime source SHA-256 is `dcbc282ec0a8769e76286bc3184eaf287fbce4edb928a96516662a7b5571d386`, WASM `d1ebeaab991c82d45ed9b9aa61f36bf4d575e5f1998374dd1534d7f46c52a337`.

After timing, the combined candidate with the same 31 new tests passed **6,524 unit tests, 46 existing skips, 27 options tests, all strict typechecks and lint**. Its full strict Chromium lifecycle passed **85 phases, skippedVerification=false**. The timing runtime tree `b66b9212ab3d549baa8257ffddae2c4abb8df43d` precedes copying the exact new test blob into that ephemeral checkout; it is not mislabeled as the complete committed test tree. #44's own committed source/test head above remains unchanged.

## Reproduction and limitations

- [Diagnostic profiles](https://github.com/ManabiIO/manabitan/actions/runs/35061502266).
- [Initial three-candidate screens](https://github.com/ManabiIO/manabitan/actions/runs/35061941613).
- [Independent production replication and direct alternative comparison](https://github.com/ManabiIO/manabitan/actions/runs/35062335322).
- [Exact-source full qualification and sanitizers](https://github.com/ManabiIO/manabitan/actions/runs/35062603422).
- [Libdeflate A/B and combined full lifecycle](https://github.com/ManabiIO/manabitan/actions/runs/35062816287).

Artifacts preserve fixed plans, scripts, patches, identities, raw observations, component digests, full logs and completion markers for 30 days. The offline evidence bundle adds recomputed CSV/JSON, an independent audit, research notes, diagnostic traces and retained exploratory failures. Native assets build from pinned source; generated WASM and verification workflows are not in the product PR.

No Firefox/Safari/ARM performance, cold-OS result, total browser-memory reduction or exhaustive persisted-store equality is claimed. No required validation is removed. Retain #44; leave the two new alternatives unpromoted and the old losers closed.

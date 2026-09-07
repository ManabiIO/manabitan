# PR #20 review validation

## Timing correction

The earlier UI percentages (-5.11% JMdict, -3.81% JMnedict, -11.34% Jitendex) are withdrawn: the harness started its total timer after file dispatch. Old reports omit enough timestamps that corrected browser intervals cannot be reconstructed reliably. Worker-RPC and isolated parser measurements have separate boundaries and are not invalidated by that defect.

Schema 3 uses a browser monotonic timestamp captured at the file input's `change` event through the current import session's post-UI completion event. Update confirmation and multi-file sessions use the same operation-scoped instrumentation. Automation-observed and worker-RPC intervals remain separate. A next-frame timestamp is not proof of physical paint.

## Corrected parser A/B

September 7, 2026; Apple M1 Max, 10 logical CPUs; Node 22.22.0; Playwright Chromium 153.0.8010.12. High, variable host load. Three adjacent pairs per dictionary, ordered AB, BA, AB. Fresh browser profiles, source ZIP imports, default dedupe enabled, no traces. Both arms use identical corrected instrumentation. Only `ext/js/dictionary/wasm/term-bank-parser.c` differs from the #18 source tree, with matching rebuilt WASM/packages for each arm.

- Baseline: `5c295fd17bed1aca2a5beae5963046574bcb2f36`.
- Candidate parser: `61588714864a58b22793dc8f17de4878ae29b315` (also present in `98ecaa39`).
- Baseline C SHA-256: `892b7d5545c908d7bab52242eea4564c98021d06b7e5da728a5a260d3e7e6ef7`.
- Candidate C SHA-256: `521d800c32634b28ae349180f791cd85568bd89e53dae79c6f1e57f26c49d21e`.
- Baseline WASM SHA-256: `61c60ecb8c3788cf3c10e300a67d9e53395ac74ae79945b4e6dd49081ac9d3c3`.
- Candidate WASM SHA-256: `f734104d5933719059406387dd07de2148c8612a7ae02f2bd5bb92eef80cfc56`.

Browser event-to-completion times (milliseconds):

| Dictionary | Pair | Baseline | Candidate |
| ---------- | ---- | -------: | --------: |
| JMdict     | AB   |    603.6 |     647.0 |
| JMdict     | BA   |    502.6 |     557.6 |
| JMdict     | AB   |    494.8 |     553.4 |
| Jitendex   | AB   |   1055.9 |    1193.5 |
| Jitendex   | BA   |   1028.4 |    1013.5 |
| Jitendex   | AB   |   1030.2 |     936.7 |

JMdict candidate was slower in all three pairs (median paired change +10.94%). Jitendex was mixed. **No whole-import speedup is established.** This is a performance sign-off concern, not evidence of data corruption. Repeat under less variable load before accepting the parser optimization on whole-path performance grounds. JMnedict was not rerun; its previous UI claim is withdrawn too.

All 12 runs passed pinned title/revision/count and sampled persisted-content checks: 526,942 JMdict rows and 435,448 Jitendex rows, with twelve first/middle/last-bank probes each. These are sampled checks, not exhaustive equality proofs. Complete local provenance: `/tmp/manabitan-pr19-parser-ab-20260907.json`; individual reports are under `/tmp/manabitan-pr20-parser-baseline/builds/perf/pr19-parser-20260907-*`.

## Real-layout overflow comparison

Baseline controller is `98ecaa39^`; candidate is `98ecaa39`. Actual popup styles, 16 entries with four definitions each: short, multiline, and horizontal-overflow content. No forced collapse. Twelve alternating adjacent pairs for each mode/width, after one warmup pair. Initial, width-shrunk, and toggle snapshots agree exactly in every pair. Pinned Arial font bytes SHA-256: `525979822591a3447cfc49d943d6f7683508e25543407871c0ed8fed05fd2bd9`; CDP confirms ArialMT from the supplied font, without system fallback.

Median component durations (milliseconds):

| Mode                             | Width | Baseline | Candidate |
| -------------------------------- | ----: | -------: | --------: |
| Expanded, automatic eligibility  |   360 |     5.25 |      3.00 |
| Expanded, automatic eligibility  |   800 |     4.20 |      2.95 |
| Collapsed, automatic eligibility |   360 |     4.95 |      3.10 |
| Collapsed, automatic eligibility |   800 |     4.70 |      3.00 |
| Not collapsible                  |   360 |     0.20 |      0.20 |
| Not collapsible                  |   800 |     0.20 |      0.20 |

**Component-local win**, consistent with two preceding paired runs. Not a full hover, full popup render, or Anki speedup claim. Absolute times near 0.2ms are too small for useful percentage comparisons. Report: `builds/perf/overflow-layout-final.json` in the review worktree.

## Firefox status

Geckodriver now explicitly receives `--allow-system-access`, required for Selenium commands in privileged extension pages. The readiness test no longer waits for dataset markers that the current content script never emits. Driver startup is awaited, and cleanup failure no longer masks the original test failure.

Local Firefox Developer Edition 150.0 gets through import, update, deletion, batch, and backend content checks, but still fails the hover lane: content-script dynamic imports are rejected even for a minimal module, while the same modules load from extension pages. The signature matches Mozilla bug [1803950](https://bugzilla.mozilla.org/show_bug.cgi?id=1803950); that does not prove every supported Firefox version is affected. Local stable Firefox 154.0.1 exits before Marionette starts. Neither is a passing Firefox validation. No product workaround or skip disguises this failure; complete Firefox hover validation remains open.

## Fix validation

- Full unit suite: 151 files, 5,389 passed, 46 skipped. Separate options suite: 25 passed.
- Strict TypeScript main/dev/test/bench projects pass, with typed partial fixtures and a declared native Zstd module boundary; no blanket typechecking disablement was added.
- All-target build dry run passes. Focused lint checks pass for the follow-up changes; repository-wide ESLint is still red elsewhere, including generated Zstd code and existing source/style violations. CI is not claimed green.
- Strict Chromium full E2E passes without skips: imports, interrupted-update recovery, update, cold restart, batch import, search/hover stress, and deletion. The final run confirms non-null current-operation browser timing for initial JMdict, Jitendex, update confirmation, and batch import, including after fresh browser contexts. The harness now re-enables its signal at every operation and does not silently use the idle-polling fallback for an armed operation.
- Source parser and content correctness tests remain enabled. The existing main checkout's uncommitted dictionary changes were not touched.

Merge readiness is not established by these passes alone: Firefox hover validation and the parser whole-import regression concern remain open. Do not carry forward the withdrawn UI percentages or present component-level layout gains as whole-hover gains.

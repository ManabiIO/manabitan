# Additional three-dictionary experiments — no new performance PR

Six independent default-off candidates and one metadata combination were tested. No additional all-three winner was established. Existing PR #41 was not modified in this round; no new performance PR, merge or production-default change was made.

Base: `51c06f03da22a416d331a9c72bf76f8435666f50` (PR #41). The standard cohorts keep libdeflate off. Separate composition cohorts enable libdeflate in both arms and toggle only the new CRC flag. All comparisons use the same build with the candidate flag off/on.

## Complete-import discovery screens

Each cell is a two-block ABBA screen with four adjacent comparisons. Percentages are median adjacent `100 * (B/A - 1)`; negative means lower time. These screens are not independent confirmations. Controls, warmups and slower observations are retained; no host/dictionary pooling or A/A subtraction.

| Candidate | JMdict | Jitendex | WTY |
| --- | ---: | ---: | ---: |
| CRC slicing16 | -1.906% | -0.757% | -0.943% |
| CRC slicing32 | +0.389% | +0.308% | -0.494% |
| Four-lane braided CRC | +0.394% | -2.697% | -0.915% |
| Lower metadata hash-table load | -1.140% | -0.195% | -0.093% |
| Cheaper dense-index allocation | -0.193% | -1.166% | -0.878% |
| Last dictionary-name fast path | -0.190% | +0.764% | +1.018% |
| All three metadata changes | -1.000% | +0.588% | +0.391% |

CRC16 had negative screening medians across all three and was independently confirmed below. The wider/braided implementations did not meet the shared-win screen. Sparse metadata slots had slightly worse equal-work totals on Jitendex and WTY despite small negative medians. Dictionary-name matching and the metadata combination were mixed.

Dense allocation remains a small, unconfirmed screening lead. JMdict improved only 0.193% in median, with 2/4 pairs faster and larger A/A variation. It has not received an independent isolated-source confirmation and is not a published winner. These results are not proof that the idea can never help.

## Independent isolated CRC16 confirmation

Six ABBA blocks per dictionary/backend; twelve candidate and twelve A/A pairs, with four excluded warmups. Fixed plan, serial fresh browser profiles, real OPFS-SAH-pool storage. Timing is browser file-input change through post-UI completion, with profiling/tracing/screenshots/process sampling off.

| Backend fixed in both arms | Dictionary | Paired time change | Equal-work total | Faster pairs | Median absolute A/A variation |
| --- | --- | ---: | ---: | ---: | ---: |
| miniz | JMdict | +0.045% | +0.137% | 6/12 | 1.359% |
| miniz | Jitendex | -0.573% | +0.814% | 6/12 | 4.927% |
| miniz | WTY | -0.285% | -0.683% | 8/12 | 1.318% |
| libdeflate | JMdict | -0.243% | +0.030% | 6/12 | 1.470% |
| libdeflate | Jitendex | -0.323% | -0.139% | 7/12 | 1.114% |
| libdeflate | WTY | +1.548% | +0.797% | 5/12 | 2.638% |

The apparent all-three CRC16 gain did not reproduce. JMdict/miniz is flat; Jitendex/miniz has a lower paired median but a higher total on a noisy host. WTY/libdeflate is slower in both aggregates, also with substantial control variation. This is not strong evidence of a universal regression, but it does not justify claiming a shared speedup. The A/A figures are observed variation, not formal confidence intervals.

## Implementations and current-round qualification

The CRC candidates calculate the same full-bank IEEE CRC, with original checks retained. Flag-off uses the original slicing-by-eight function. The final isolated CRC16 adds a private 16 KiB lookup table per module; this is not a whole-browser memory measurement.

Metadata candidates change the slot-array load target, avoid unnecessary new-index allocation bookkeeping, or check the last interned dictionary name before the existing map. Pending visibility, collision verification, rollback and free-list reset paths remain. Actual storage-side finalization flag receipts were verified, not just worker echoes.

Final CRC16 source passed 6,561 full unit tests (46 inherited skips), 27 options tests, 211 focused tests, all four typecheck projects, changed-file ESLint, build plans, and actual Chrome/Firefox package builds. All six final confirmation jobs succeeded. The byte-identified original and selected CRC helpers passed 32,768 native ASan/UBSan checks against an independent bitwise oracle at allocation ends. The final sanitizer log is retained from that execution, not counted as six separate sanitizer runs. This is not a sanitizer run of the entire importer.

CRC discovery passed 162 focused tests. Metadata discovery passed 234 focused tests including seven new regressions for flag/reset isolation, allocation growth/free-list reuse, dictionary-name alternation and clears, colliding probe chains, pending visibility, rollback and rehashing. Metadata did not receive full unit/type/lifecycle qualification.

Every timed import checked full persisted row count/title/revision, twelve distributed content probes, real storage mode and no errors/skips. No new exhaustive persisted-byte or complete-corpus parser-output comparison, full restart/crash/deletion lifecycle run, Firefox/Safari runtime or ARM/mobile qualification was executed for these candidates.

## Audit and retained evidence

All 582 complete browser observations were reopened and checked: 120 CRC discovery, 150 metadata discovery and 312 CRC16 confirmation. There are 504 measured observations and 78 excluded warmups. This includes controls and rejected candidates, not 582 observations of a single optimization.

The offline audit recreates fixed plans, checks unique raw report names and SHA-256 hashes, retained executed driver identities, pinned fixtures, instrumentation flags, actual worker/storage flags, browser event timing, storage mode and full validation receipts. It recomputes paired medians, block totals, equal-work totals and faster-pair counts. Source/group/worker/dedup and encoded-content/record/lookup-index write-byte accounting agree between arms in each cohort. The source audit checks tar-member bytes against measured identities; all six CRC16 hosts have identical patches and six-file qualification receipts.

Final CRC16 WASM SHA-256: `6168f9f51632e33323c21791886534c46c00c38b11d0e095faf537ffe82892fc`.
Final CRC16 C SHA-256: `06f12a01a61c84b59776ad8c29b0da142941f3003a38d7aeedbe38771761da0e`.
Exact extracted helper SHA-256: `c301b0bb1f55923c84e3378a397b050ba5686c51ff7bc83371e4887c29886b23`.

Failed preflights are retained separately: generated-library build order before lint; a test JSDoc annotation; and a test's widened compression-method numeric literal. None contributed successful timing observations. The final CRC16 run corrected only the test literal annotation, kept runtime source identical and repeated qualification before timing. CRC32 has discovery results but no isolated timed confirmation.

- CRC discovery: https://github.com/ManabiIO/manabitan/actions/runs/35191671690
- Metadata discovery: https://github.com/ManabiIO/manabitan/actions/runs/35193466047
- Isolated CRC16 confirmation, both backends: https://github.com/ManabiIO/manabitan/actions/runs/35193624357
- Retained CRC16 preflight: https://github.com/ManabiIO/manabitan/actions/runs/35193246501
- Immutable recipes/workflows: https://github.com/ManabiIO/manabitan/tree/ead982dcc7002062abcdae4c2fd3c1d133afbc43

Raw artifact ZIPs preserve executed drivers, every report/log, source patches and source tars. The user-facing evidence bundle additionally contains the complete offline report audit and source audit. No research workflow, candidate or default was promoted to a product branch. No additional all-three performance PR is justified by these measurements.

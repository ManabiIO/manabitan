# Import qualification results and protocol, 2026-11-22

## Result

**Correctness checks passed. A whole-import speedup was not established. Both production PRs remain drafts.**

[Hosted run 45104760158](https://github.com/ManabiIO/manabitan/actions/runs/45104760158) completed all three dictionary jobs successfully. Each dictionary contributed 36 timed imports and six excluded warmups: 108 timed imports and 18 warmups in total. The measured candidate is `a1d00c8408cb91281e7075fc398ef0810f8ac700`; its two runtime files are byte-identical to the final PR heads recorded below.

| Dictionary      | Baseline A median | Combined candidate B median | Identical baseline C median |
| --------------- | ----------------: | --------------------------: | --------------------------: |
| JMdict          |         730.65 ms |                   726.05 ms |                   736.50 ms |
| Jitendex        |       1,330.45 ms |                 1,317.70 ms |                 1,334.30 ms |
| VNDB Characters |       8,065.65 ms |                 8,079.80 ms |                 8,098.85 ms |

Paired medians below are medians of adjacent-run percentage changes, not ratios of the arm medians above. Negative changes mean faster. Equal-work changes compare the summed duration of all 12 runs in each arm.

| Dictionary      | Paired B/A |  Total B/A | Paired B/C |  Total B/C | Control total C/A |
| --------------- | ---------: | ---------: | ---------: | ---------: | ----------------: |
| JMdict          |     −0.20% |     −0.34% |     +0.22% |     −0.95% |            +0.62% |
| Jitendex        |     +0.47% |     +0.02% |     −1.20% |     −0.57% |            +0.60% |
| VNDB Characters |     −0.05% | **+2.68%** |     −0.08% | **+2.72%** |            −0.04% |

All candidate paired-median descriptive 95% intervals include zero. The JMdict and Jitendex results overlap unchanged-code variation. VNDB's median is effectively unchanged, while retained slow candidate runs make its aggregate time worse. The combined experiment cannot attribute that result to either individual patch. The component improvements reported in the PRs must not be presented as overall import gains.

VNDB B11 took 10.403 seconds versus 8.152 and 8.228 seconds in its two controls. Its recorded term-record writable close took 4,173 ms versus 1,922 and 1,913 ms; B10 also had a 2,893 ms close. These successful imports have matching validation and remain in every reported statistic. The [complete finalization diagnostics](results/import-qualification-20261122/vndb-finalization-diagnostics.json) preserve that phase for all 42 ordinary runs. They identify where the delay was recorded, not its cause.

Every ordinary run returned the locked row count and matching sampled content across browser restart: 526,942 JMdict rows, 435,448 Jitendex rows, and 6,648,310 VNDB rows. VNDB also returned 146,570 media rows, activated the packed-media path, and passed all five source-exact image probes before and after restart. Jitendex returned 236 media rows but did not perform media-byte probes. These checks do not establish exhaustive stored-content or media equality.

### Retained evidence

| Dictionary      | Comparison and all timed values                                              | All warmups, timings, hashes, provenance, and shared validation                  |
| --------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| JMdict          | [comparison](results/import-qualification-20261122/jmdict-comparison.json)   | [observations](results/import-qualification-20261122/jmdict-observations.json)   |
| Jitendex        | [comparison](results/import-qualification-20261122/jitendex-comparison.json) | [observations](results/import-qualification-20261122/jitendex-observations.json) |
| VNDB Characters | [comparison](results/import-qualification-20261122/vndb-comparison.json)     | [observations](results/import-qualification-20261122/vndb-observations.json)     |

The [provenance record](results/import-qualification-20261122/provenance.json) lists source identities, artifact digests, final PR heads, and CI runs. All downloaded ZIP digests matched GitHub's artifact metadata. Re-running the verifier independently reproduced each original comparison file byte for byte. Compact records retain all 126 ordinary summary hashes and 378 unrounded timing values; repeated source and validation objects are shared only after exact equality checks. Full logs and the separate JMdict/Jitendex traces remain in the workflow artifacts under their recorded retention dates.

Committed comparison files use the repository's four-space indentation. Each observations file distinguishes the original artifact comparison hash from the retained comparison hash; their parsed values are exactly equal.

### PR validation

| PR                                                                             | Final head                                 | Full unit result          | CI                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------- |
| [#806: archive classification](https://github.com/ManabiIO/manabitan/pull/806) | `2531f32d3f4322d05819a12e16fe70d34eb997a2` | 13,996 passed; 47 skipped | [15 applicable jobs passed](https://github.com/ManabiIO/manabitan/actions/runs/45104662449) |
| [#807: media ID parsing](https://github.com/ManabiIO/manabitan/pull/807)       | `5c956ee99c518cbc05b1c3db9f480a8d2aecc01c` | 14,016 passed; 47 skipped | [15 applicable jobs passed](https://github.com/ManabiIO/manabitan/actions/runs/45105120736) |

Both exact heads also passed CodeQL, restart interruption, static web acceptance, dependency review, workflow lint, and link checks. The CI matrix includes Chrome/Firefox end-to-end imports and pinned WASM/build verification. Later evidence-only changes on this qualification branch do not change the measured runtime or either PR head.

## Scope

This branch qualifies the combined runtime changes proposed in PRs #806 and #807 against `develop` at `5e1f8c12f7ff798ba407323aff675cb23b22af02`. It is a measurement branch, separate from the two production PRs. The packaged candidate must differ from baseline in exactly `js/dictionary/dictionary-importer.js` and `js/dictionary/dictionary-generation-media-store.js`.

The browser workflow, VNDB fixture overlay, and comparison verifier were adapted from the working qualification tools at `0f614ccdabd867f8c682e8c488d5f34ccd7509ae`. The changes here add an identical-code control, a fixed balanced schedule, exact package/fixture provenance checks, and a three-arm report. No other candidate's product changes are included.

## Fixed experiment

Each dictionary runs on its own GitHub-hosted Ubuntu runner using the repository's pinned Node and Playwright versions and the matching Chromium. The three locked fixtures are JMdict, Jitendex, and VNDB Characters by Bee. Downloads, hash checks, dependency installation, and release Chrome package builds finish before timing. Both sources receive the identical measurement-only overlay.

For each dictionary, A and C use the baseline package and B uses the candidate package. Every observation uses a fresh browser profile. Six warmups are excluded in the declared order `A B C C B A`. Twelve measured triplets follow in the exact order:

`ABC CBA BCA ACB CAB BAC BAC CAB ACB BCA CBA ABC`

This is 36 measured imports per dictionary, with no adaptive stopping, extension, or tail removal. The browser's monotonic timer covers file-input change through the post-UI import-complete event. Production import defaults are used; tracing, phase profiling, screenshots, and process sampling are disabled during timing. A separate diagnostic candidate trace runs afterward for JMdict and Jitendex only.

## Correctness and provenance

Every import must complete successfully with the locked term count. Twelve sampled term-content probes must remain readable and unchanged after browser restart and across arms. VNDB additionally checks the full media row count, packed-media activation and descriptor stability, and five source-exact image probes before and after restart. The image probes include the archive's compressed exception, `img/cc18737.webp`.

The verifier rejects missing observations, changed schedules, wrong source commits, changed fixtures, missing browser identity, package provenance mismatches, A/C package differences, unexpected packaged product changes, or differing validation results. Synthetic tests exercised valid reports for all three dictionaries and isolated corruptions of each of these constraints before publication. The overlay was applied to clean baseline file copies and both resulting JavaScript files passed Node syntax checks.

The reproducible verifier self-test is `python3 dev/perf/test-import-comparison.py --output builds/perf/verifier-self-test`; its output directory must not already exist. It creates explicitly synthetic evidence and runs before browser setup in each job.

Complete reports, logs, source and package hashes, package entry hashes, harness files, fixture identity, host observations, and any failed observation are retained in the workflow artifact. Evidence is initialized before preparation so download or build failures remain visible.

## Interpretation

Report B/A and B/C paired changes and equal-work totals, plus C/A identical-code controls. Keep all observations and tails. Do not subtract control drift or pool different dictionaries. Descriptive bootstrap intervals use a fixed seed and do not establish a cross-device guarantee.

Component evidence in the production PRs measures different boundaries and must not be presented as total-import improvement. The browser checks sample persisted term content and media rather than proving exhaustive stored-byte equality. This experiment does not measure peak memory or independently attribute a combined result to either PR.

If the fixed experiment fails, preserve the failure and repair only the identified issue before declaring a new attempt. A completed cohort must not be extended to obtain a preferred result. Any later evidence-only commit uses `[skip ci]` so it does not restart the experiment.

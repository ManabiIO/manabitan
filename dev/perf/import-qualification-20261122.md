# Import qualification protocol, 2026-11-22

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

# Complete-import screening for the UTF-8 and borrowed-content changes

This study measures the complete production import path for JMdict, Jitendex and VNDB. It supports [PR #941](https://github.com/ManabiIO/manabitan/pull/941) and [PR #955](https://github.com/ManabiIO/manabitan/pull/955). The UTF-8 candidate is stacked on [PR #932](https://github.com/ManabiIO/manabitan/pull/932), so its comparison includes both the original baseline and that intermediate change. This measurement PR is based on the existing checker correction in [PR #950](https://github.com/ManabiIO/manabitan/pull/950), commit `439a1c9b6d40452061cda094b0727005553c1d1d`.

## Frozen sources and schedule

| Study            | A                                                  | B                                                                | C                                                              |
| ---------------- | -------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| UTF-8 copying    | Develop `0143e9596cd8f790d5e166d4ba6a2425fbc57f14` | Shared-loop PR #932 `6ddfacf26fd2d5069192ac279bcc61f81b7832ee`   | Fixed-width PR #941 `3dab279bb671f4a4f26d145209b6415159410bd3` |
| Borrowed content | Same develop commit                                | Early-release PR #955 `1a234772a0be1001ca63ce9d320d218123bd9449` | Byte-identical control A                                       |

Each study/dictionary cell runs on one independent GitHub-hosted runner. Each arm uses the same Node 22.22.0 runtime, lockfile Playwright 1.63.0 / Chromium 153.0.8010.12 installation, checksum-pinned original dictionary archive and ordinary production settings. The runner records source trees, browser executable identity, fixture hashes and package-member hashes before acquisition.

Every cell has a fixed schedule of 24 fresh-profile imports:

1. One untimed warmup per arm.
2. Six timed blocks: ABC, ACB, BAC, BCA, CAB and CBA. These produce six observations per arm, with balanced positions and all pair orders.
3. One separate exhaustive-media validation per arm. Timed imports use sampled media validation; exhaustive validation is excluded from performance summaries.

The complete-import duration uses the existing browser monotonic clock boundary, from the file-input change event through the post-UI completion event. Every observation includes extension restart, all 72 public lookup observations, exact row-count checks, content readability, media checks and logical OPFS storage receipts. Public lookup result hashes are compared across arms. Physical content digests and storage inventories are checked within an arm because an equivalent implementation may choose different storage placement.

The runner retains every attempted observation and its failure. It does not retry or replace failed observations. The workflow triggers only when its runner or workflow is pushed to `test/import-qualification-20261126-fbc`; adding evidence or updating this explanation does not reacquire samples.

These are exploratory comparisons on one host per cell. The summary reports all observations, paired median changes and faster-pair counts. It does not turn a noisy or incomplete result into a broad speed claim. The duplicate baseline arm in the borrowed-content study provides a contemporaneous drift control. Browser peak-memory improvement is not measured by this study.

## Measurement correction

The benchmark receipt checker previously inferred native image projection when a media import exceeded 512 MiB. The importer actually requires at least 1 GiB before enabling projection. That also meets the parser's separate 512 MiB requirement, but a media pipeline alone does not establish projection eligibility.

Jitendex has 538,927,310 decoded term-bank bytes. Its ordinary production run uses the media pipeline with image projection and native escaped-key decoding disabled. The old checker incorrectly rejected those valid receipts after successful import. The adopted correction in PR #950 aligns the checker with the importer and retains all independent media/source/worker checks and strict comparison of requested and effective experiment settings. The same measurement-only helper is overlaid onto every source arm; extension product files are not changed by the overlay.

The two focused checker suites passed **165 tests** on the exact adopted PR #950 source. Coverage includes 512 MiB, the pinned Jitendex source size, both sides of 1 GiB, rejection of flipped effective escaped-key receipts, and missing or unsafe source sizes. The earlier equivalent local correction passed 167 tests and scoped ESLint before it was replaced with the already-published correction; those earlier receipts are retained separately. An unchanged Jitendex report captured by the earlier baseline study was also accepted by the corrected checker with all 72 lookup observations; this revalidation is not a new performance sample.

## Local correctness evidence

The archived evidence is in [`builds/perf/import-screen-20261126-fbc/local-correctness`](../../builds/perf/import-screen-20261126-fbc/local-correctness/README.md). It preserves original reports, harnesses and logs with a file checksum manifest.

| Native candidate parity |      Rows | Banks | Groups | Result                                                                                       |
| ----------------------- | --------: | ----: | -----: | -------------------------------------------------------------------------------------------- |
| JMdict                  |   528,299 |    53 |     12 | Keys, content, numeric columns and prepared lookup indexes match                             |
| Jitendex                |   436,555 |   219 |     22 | Complete compressed production-worker output matches; all content groups borrowed            |
| VNDB                    | 6,648,310 |   665 |    170 | Complete compressed production-worker output matches; 146,570 distinct projected image paths |

Together these checks cover 7,613,164 rows. They compare the fixed-width native parser against develop; they do not test the separate database handoff change. The compressed-worker replay is sequential and does not reproduce browser scheduling, OPFS persistence or complete-import latency.

An independent host-C differential compared **20,072,257 cases** with AddressSanitizer and UndefinedBehaviorSanitizer, including all byte strings through length three, every valid Unicode scalar, seeded random strings and protected-page tails. Return values, partial writes and output canaries matched. LeakSanitizer alone was disabled because it cannot run in the local sandbox's ptrace environment; allocation leaks were not assessed.

The native branch also passed both combined UTF-8 regression suites after stacking (**206 tests**), the earlier targeted native suites, all seven dry-build targets, scoped ESLint and regeneration of the source-bound WASM with pinned Clang/LLD 21.1.8. The local database handoff suite passed **150 tests**, including source overwrite, deliberate hash collisions, public reads, persistence failure and release ordering. Hosted CI remains the source for complete unit, type, lint and browser validation.

The local host was heavily contended. Elapsed values retained in the raw parity log are diagnostic only and must not be interpreted as a speed comparison. The first native test attempt also exposed an overlarge test-helper snapshot; its failed log is retained alongside the corrected passing run. Local browser launch was blocked by the execution environment, so complete-import measurements run on hosted CI.

## Running the registered study

The workflow installs dependencies and the lockfile browser, then runs:

```sh
python3 dev/perf/import-screen-20261126-fbc.py --self-test
python3 dev/perf/import-screen-20261126-fbc.py --study utf8 --dictionary jmdict --evidence builds/perf/import-screen-utf8-jmdict
```

The allowed study names are `utf8` and `borrowed-content`; dictionary names are `jmdict`, `jitendex` and `vndb`. Use a fresh evidence directory. Each cell's artifact includes the registered schedule, source/package/runtime identities, raw reports, command logs, failure receipts and a summary. Artifacts deliberately exclude dictionary archives, browser installations and browser profiles.

# Import optimization evidence, 23 November 2026

## Status and source identity

This packet retains reproducible correctness evidence and the first hosted browser screen. It does not establish a whole-import speedup. The six-block Jitendex screen is affected by unchanged-code drift, and a separate fixed twelve-block qualification is pending. Keep those cohorts separate and retain every observation.

| Change                                                                        | Published source                           | Local source with identical tree           | State                                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Packing and dispatch, [PR851](https://github.com/ManabiIO/manabitan/pull/851) | `78a2adcfba8d72d8cba070319b53d4b2b354a8f9` | `912c0bed18b5f6301a0a0eccd08ed2d2fefcf6b2` | Tree `5c074e07c8964e8435987b954987b4fba95d7fdb`; six-block Jitendex screen audited                              |
| Numeric media paths, [PR846](https://github.com/ManabiIO/manabitan/pull/846)  | `32c13e05c1a7fda88fd531dab40648c1978565f2` | `17c7c56803a5560d8b824bc04a49872dba4d2ed5` | Tree `2c4048a4f2be1dac76f16ec9f10efc93c1d966c4`; browser result pending                                         |
| Record-field runs, [PR855](https://github.com/ManabiIO/manabitan/pull/855)    | `bb1073961bb5adaa190e32943c94d063a18aa8bd` | `22f09dd819b2e338f2e16daea9ef061fe1176878` | Tree `de8f9ef7ba011def59396fe64855fe22bebedac9`; stacked on PR849 at `10a8f09e96ff943ec1351b1391cb56fa7e20feed` |

The baseline is `3d65e403c644b9a5a6be3128d72f9d30050b70e0`, tree `c540375466fc921ab05a5526a6130bc2d48010d5`. The earlier record-run candidate `a470edad0bdad293460cf89c5407ee69f29f96dd` is superseded. Its original component timings, failed attempt and patch remain available, but do not describe the stacked candidate. The score-boundary correctness fix is separate from all these frozen performance candidates. Full mappings and byte identities are in [manifest.json](manifest.json).

## Complete-source correctness and ownership

- **Jitendex packing:** the untimed frozen input spans cover 363,243 selected contents and 389,687,485 bytes from the complete pinned 436,555-row archive. Baseline and candidate have identical 382-block plans and compressed-envelope hashes. Every decoded frame was compared exactly with its source spans, and all 363,243 reference records were checked. Persisted output is 38,373,046 bytes, SHA-256 `647d1b757c3e206aa037b4a31205651d8708e1a2a1f041162d96bb78344a9e2f`. These are fixed parser-derived groups prepared at `467067650653c37c1f7d6b05d6737d070e1259cd`; this component check is distinct from browser database equivalence. See [summary](jitendex/summary.json), both full receipts, and the input manifest.
- **Snapshot boundary:** the same four immediate-mutation/detachment cases pass on baseline and PR851 but fail on the reviewed PR847 product source at `44d6830646bfa43cb30fbec3c05ea9d98d09406f`. Overwrite-only cases persist modified bytes; detachment cases reject. This is a specific source-lifetime difference, not a claim that ordinary PR847 imports always corrupt data. PR851 retains the synchronous source snapshot and round-robin assignment; PR847 bounds pending work and changes scheduling. See [snapshot receipt](jitendex/snapshot-summary.json) and all three control logs.
- **Record fields:** the original and stacked parity runners cover all 7,613,164 source rows: 528,299 JMdict, 436,555 Jitendex and 6,648,310 VNDB. They compare record-field bytes under deterministic resolved offsets above 1 TiB, using both constant compact lengths and actual native content lengths. The stacked result is relative to PR849, which already writes final columns directly. This does not establish whole-database equivalence or browser speed. See [stacked parity](local/jmdict-stacked-encoder-parity-results.json).
- **VNDB media index:** the Node component study uses all 146,570 verified image records and verifies equivalent index/selection outputs. Timing controls are noisy and remain component-only evidence. The source-derived records table is retained as a lossless gzip with its original size and hash in the manifest. See [component receipt](local/vndb-media-index-screen.json).

## Hosted baseline scope

Run [45260267997](https://github.com/ManabiIO/manabitan/actions/runs/45260267997) contains three ordinary baseline observations and one separate exhaustive-media diagnostic for each dictionary: twelve successful imports total. The three original downloaded artifact ZIPs are preserved unchanged alongside browseable top-level receipts. Nested raw reports remain inside each original ZIP. These baseline observations alone are not a candidate comparison.

The browser checks import complete pinned archives, verify row counts and readable content after restart, and compare 72 lookup receipts from **12 fixed terms** over the first pass and five warm passes; the first pass does not establish cold operating-system caches. They do not exhaustively decode every term. Ordinary observations check **64 media files** for dictionaries with media. Separate diagnostics check all **236 Jitendex files / 4,992,155 bytes** and **146,570 VNDB files / 188,131,284 bytes**; JMdict contains no media. These are content/hash checks, not visual screenshot review. Screenshots, tracing, phase profiling and process-memory sampling are disabled. No screenshots are present in the retained packets.

## First Jitendex screen

Run [45262916933](https://github.com/ManabiIO/manabitan/actions/runs/45262916933), artifact `14861638196`, compares the exact PR851 source with two uses of the same baseline package. Six blocks use orders `ABC`, `CBA`, `BAC`, `CAB`, `BCA`, `ACB`. All 18 timed imports and both separate exhaustive-media diagnostics passed. No observations were dropped.

| Comparison                         | Median paired change | Equal-work total change | Faster pairs |
| ---------------------------------- | -------------------: | ----------------------: | -----------: |
| Candidate B / baseline A           |              -4.817% |                 -4.619% |          6/6 |
| Candidate B / identical baseline C |              -2.474% |                 +0.141% |          5/6 |
| Identical baseline C / baseline A  |              -1.309% |                 -4.753% |          4/6 |

Block one is influential: A took 2,282.0 ms, B 2,131.6 ms and C 1,789.6 ms. The unchanged-code C/A difference is -21.58% in that block. The candidate's aggregate improvement against A is matched by unchanged-code drift and disappears against C. The complete screen therefore does **not** establish a whole-import gain. Retain all six blocks, including this first block; qualification must be independent, with no pooling or post-hoc trimming.

The independent audit verifies every original ZIP member, both frozen source trees, all 66 harness hashes for each source, all 550 package entries and the two intended packaged-file differences, all 20 source/package receipts, restart/lookup/media receipts and storage size of 67,466,332 bytes. It recomputes every paired percentage from raw observations. See [independent audit](audits/pack-dispatch-jitendex-screen.json) and [raw screen](browser/screen/pack-dispatch-jitendex/observations.json). Package receipts prove source/package identity; the packets do not contain extension build binaries.

## Validation failures and recovery

Keep unsuccessful runs alongside their successful follow-ups:

- The VNDB full local suite had two missing-compiler setup failures and an Android five-second timeout. An isolated rerun passed the 22 Android tests; the two native suites passed all 21 tests after the current compiler was selected. The original full-suite and intermediate rerun logs remain retained.
- The stacked record test initially timed out at the large score-dictionary boundary. Final focused coverage passed 272 tests. A combined lint process was killed with exit 137; changed-test lint passed separately. A test-typecheck constrained to 768 MiB exhausted that heap with exit 134; the isolated 1,536 MiB rerun passed. These are separate attempts, not a single uninterrupted clean suite.
- Earlier Jitendex lint errors and the corrected passing run are both retained. Six focused suites passed 120 tests, with a final 13-case dispatch regression rerun. Main and test typechecks passed.
- The audit's initial assertion compared complete A/C package metadata, including C's explicit `identicalArchiveFromArm` field. The corrected audit compares source, entry hashes and archive hash; its initial diagnostic and successful rerun are retained. This was an audit-schema assertion, not a failed browser import.

## Pending results

| Cohort or fix                                   | Required evidence before a conclusion                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| PR851 JMdict and VNDB six-block screens         | Original artifact, all observations, independent source/correctness/drift audit                         |
| PR846 VNDB six-block screen                     | Same audit and explicit unchanged-code comparisons                                                      |
| PR851 Jitendex fixed twelve-block qualification | Separate cohort, same frozen source, no pooling with the screen                                         |
| PR855 record runs on all three dictionaries     | Compare with PR849, not develop; frozen source/package receipts                                         |
| Score-boundary fix                              | Separate source identity, boundary regressions and validation; no attribution to performance candidates |

Run [45265448894](https://github.com/ManabiIO/manabitan/actions/runs/45265448894), frozen tooling `3c8f26e7ebfde84ad7bd46a5296617e18a46ca6a`, schedules the separate Jitendex qualification and the three stacked record-run screens. Results are pending in this snapshot. Fill these rows only from retained completed packets. This report makes no process-memory, lookup-speed or screenshot-based claim.

## Reproduction and retention

Run `python3 tools/verify.py` from this directory to verify every staged file and the manifest. Original artifact ZIPs live under `browser/original-artifacts/`; extract an original ZIP into a temporary directory when rerunning its independent audit, because nested raw reports are kept only in the ZIP. The large dictionary archives, generated libraries and prepared binary slabs are intentionally omitted. [The dictionary lock](inputs/dictionaries.lock.json) supplies permanent release URLs and required archive hashes. No expiring download URLs are retained.

For the Jitendex component, build libraries at the preserved input-preparation revision, run `node jitendex/prepare-inputs.mjs PREPARATION_REPOSITORY JITENDEX_ZIP PREPARED_DIRECTORY`, then compare the generated per-file hashes with `jitendex/prepared-manifest.json`. Run `node --expose-gc jitendex/check.mjs SOURCE_REPOSITORY PREPARED_DIRECTORY OUTPUT_JSON EXPECTED_COMMIT` once for each frozen compression source. The checker retains one source group at a time; the original preparer retains deduplication state across groups. `jitendex/compare.mjs` compares adjacent `baseline.json` and `candidate.json`.

The record-field runners are preserved exactly, including their original workspace and cache paths. Recreate the named checkouts or adjust those path constants in a copied runner; verify all source/lock/parser hashes against its JSON receipt before interpreting output. Set `PARITY_ONLY=1` for the original runner; the stacked runner performs no timing. The superseded local candidate can be reconstructed by applying `local/record-runs-original-superseded.patch` to the pinned develop baseline.

To repeat the snapshot comparison, place `jitendex/source-snapshot-repro.test.js` in an isolated source checkout's `test/` directory and run that file with Vitest. Test the listed baseline, PR847 and PR851 sources separately. The original reproduction used one detached checkout, changing only the two product modules between controls and restoring them afterward.

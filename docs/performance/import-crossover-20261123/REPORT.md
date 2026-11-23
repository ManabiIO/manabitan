# Import optimization evidence, 23 November 2026

## Status and source identity

This packet retains reproducible correctness evidence, exploratory screens and a separate fixed twelve-block qualification. **PR851 is ready for review**, with its exact tested source unchanged. Its qualification supports a modest Jitendex whole-import improvement on this hosted runner: the candidate is faster than both unchanged baselines in all twelve blocks. Its JMdict and VNDB screens passed integrity checks without establishing speedups. The earlier Jitendex screen remains affected by unchanged-code drift and is not pooled with qualification. **PR859 is also ready for review as a separate correctness fix. All four product PRs have green CI; PR846 and PR855 remain drafts because their complete-import results are inconclusive.** Every planned cohort is complete. No changes have been merged. Retain every observation and avoid cross-device or process-memory claims.

| Change                                                                        | Published source                           | Local source with identical tree           | State                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packing and dispatch, [PR851](https://github.com/ManabiIO/manabitan/pull/851) | `78a2adcfba8d72d8cba070319b53d4b2b354a8f9` | `912c0bed18b5f6301a0a0eccd08ed2d2fefcf6b2` | Ready for review; tree `5c074e07c8964e8435987b954987b4fba95d7fdb`; qualified Jitendex gain on this runner and all three screen integrity checks passed                 |
| Numeric media paths, [PR846](https://github.com/ManabiIO/manabitan/pull/846)  | `32c13e05c1a7fda88fd531dab40648c1978565f2` | `17c7c56803a5560d8b824bc04a49872dba4d2ed5` | Draft; tree `2c4048a4f2be1dac76f16ec9f10efc93c1d966c4`; complete-import result inconclusive                                                                            |
| Record-field runs, [PR855](https://github.com/ManabiIO/manabitan/pull/855)    | `bb1073961bb5adaa190e32943c94d063a18aa8bd` | `22f09dd819b2e338f2e16daea9ef061fe1176878` | Draft; tree `de8f9ef7ba011def59396fe64855fe22bebedac9`; stacked on PR849 at `10a8f09e96ff943ec1351b1391cb56fa7e20feed`; all three complete-import screens inconclusive |
| Score boundary, [PR859](https://github.com/ManabiIO/manabitan/pull/859)       | `585662de70b3efcf91e4d94376710181f7b10fd8` | `fab6370ceaeb86f0c3b936df430d285ff37236e0` | Ready for review; tree `6cb58901545a7468512f2154819f7cca0c489a07`; separate low-level encoder correctness fix                                                          |

The baseline is `3d65e403c644b9a5a6be3128d72f9d30050b70e0`, tree `c540375466fc921ab05a5526a6130bc2d48010d5`. The earlier record-run candidate `a470edad0bdad293460cf89c5407ee69f29f96dd` is superseded. Its original component timings, failed attempt and patch remain available, but do not describe the stacked candidate. The score-boundary correctness fix, [PR859](https://github.com/ManabiIO/manabitan/pull/859), is separate from all these frozen performance candidates: published `585662de70b3efcf91e4d94376710181f7b10fd8` and local `fab6370ceaeb86f0c3b936df430d285ff37236e0` share tree `6cb58901545a7468512f2154819f7cca0c489a07`. Full mappings and byte identities are in [manifest.json](manifest.json).

[PR854](https://github.com/ManabiIO/manabitan/pull/854) is a concurrent alternative for record encoding: it combines content-and-score runs, gates reuse on compact metadata, and retains scratch columns. PR855 encodes content and score runs independently on top of PR849's direct final columns. Evaluate these as alternatives; merging both would overlap the same encoding path.

## Complete-source correctness and ownership

- **Jitendex packing:** the untimed frozen input spans cover 363,243 selected contents and 389,687,485 bytes from the complete pinned 436,555-row archive. Baseline and candidate have identical 382-block plans and compressed-envelope hashes. Every decoded frame was compared exactly with its source spans, and all 363,243 reference records were checked. Persisted output is 38,373,046 bytes, SHA-256 `647d1b757c3e206aa037b4a31205651d8708e1a2a1f041162d96bb78344a9e2f`. These are fixed parser-derived groups prepared at `467067650653c37c1f7d6b05d6737d070e1259cd`; this component check is distinct from browser database equivalence. See [summary](jitendex/summary.json), both full receipts, and the input manifest.
- **Snapshot boundary:** the same four immediate-mutation/detachment cases pass on baseline and PR851 but fail on the reviewed PR847 product source at `44d6830646bfa43cb30fbec3c05ea9d98d09406f`. Overwrite-only cases persist modified bytes; detachment cases reject. This is a specific source-lifetime difference, not a claim that ordinary PR847 imports always corrupt data. PR851 retains the synchronous source snapshot and round-robin assignment; PR847 bounds pending work and changes scheduling. See [snapshot receipt](jitendex/snapshot-summary.json) and all three control logs.
- **Record fields:** the original and stacked parity runners cover all 7,613,164 source rows: 528,299 JMdict, 436,555 Jitendex and 6,648,310 VNDB. They compare record-field bytes under deterministic resolved offsets above 1 TiB, using both constant compact lengths and actual native content lengths. The stacked result is relative to PR849, which already writes final columns directly. An independent 196-case matrix also passed against PR849. This does not establish whole-database equivalence or browser speed. See [stacked parity](local/jmdict-stacked-encoder-parity-results.json) and [matrix review](local/stacked-record-review.json).
- **VNDB media index:** the Node component study uses all 146,570 verified image records and verifies equivalent index/selection outputs. Timing controls are noisy and remain component-only evidence. The source-derived records table is retained as a lossless gzip with its original size and hash in the manifest. See [component receipt](local/vndb-media-index-screen.json).

## Hosted baseline scope

Run [45260267997](https://github.com/ManabiIO/manabitan/actions/runs/45260267997) contains three ordinary baseline observations and one separate exhaustive-media diagnostic for each dictionary: twelve successful imports total. The three original downloaded artifact ZIPs are preserved unchanged alongside browseable top-level receipts. Nested raw reports remain inside each original ZIP. These baseline observations alone are not a candidate comparison.

The browser checks import complete pinned archives, verify row counts and readable content after restart, and compare 72 lookup receipts from **12 fixed terms** over a first pass and five warm passes. This does not guarantee cold operating-system caches. They do not exhaustively decode every term. Ordinary observations check **64 media files** for dictionaries with media. Separate diagnostics check all **236 Jitendex files / 4,992,155 bytes** and **146,570 VNDB files / 188,131,284 bytes**; JMdict contains no media. These are content/hash checks, not visual screenshot review. Screenshots, tracing, phase profiling and process-memory sampling are disabled. No screenshots are present in the retained packets.

## First Jitendex screen

Run [45262916933](https://github.com/ManabiIO/manabitan/actions/runs/45262916933), artifact `14861638196`, compares the exact PR851 source with two uses of the same baseline package. Six blocks use orders `ABC`, `CBA`, `BAC`, `CAB`, `BCA`, `ACB`. All 18 timed imports and both separate exhaustive-media diagnostics passed. No observations were dropped.

| Comparison                         | Median paired change | Equal-work total change | Faster pairs |
| ---------------------------------- | -------------------: | ----------------------: | -----------: |
| Candidate B / baseline A           |              -4.817% |                 -4.619% |          6/6 |
| Candidate B / identical baseline C |              -2.474% |                 +0.141% |          5/6 |
| Identical baseline C / baseline A  |              -1.309% |                 -4.753% |          4/6 |

Block one is influential: A took 2,282.0 ms, B 2,131.6 ms and C 1,789.6 ms. The unchanged-code C/A difference is -21.58% in that block. The candidate's aggregate improvement against A is matched by unchanged-code drift and disappears against C. The complete screen therefore does **not** establish a whole-import gain. Retain all six blocks, including this first block; qualification must be independent, with no pooling or post-hoc trimming.

The independent audit verifies every original artifact ZIP member, both frozen source trees, all 66 harness hashes for each source, all 550 recorded package-entry hashes and the two intended packaged-file differences, all 20 source/package receipts, restart/lookup/media receipts and storage size of 67,466,332 bytes. It recomputes every paired percentage from raw observations. See [independent audit](audits/pack-dispatch-jitendex-screen.json) and [raw screen](browser/screen/pack-dispatch-jitendex/observations.json). The product ZIPs are absent: this verifies recorded archive/entry hashes, A/C receipt equality and the changed runtime entries against Git, rather than independently rehashing or rebuilding the extension archives.

## Independent Jitendex qualification

Run [45265448894](https://github.com/ManabiIO/manabitan/actions/runs/45265448894), artifact `14864297300`, retained a separate fixed twelve-block cohort at the unchanged PR851 source. All 36 timed imports and both separate exhaustive-media diagnostics passed. Source, package-entry receipts, harness, OPFS use, restart, lookup/media receipts and storage checks passed. A second calculation reconstructed every timing from the raw browser start/completion clocks and reproduced every paired statistic. All twelve blocks remain included; no screen observations are pooled into this cohort.

| Comparison | Median paired change | Descriptive 95% interval | Equal-work total change | Faster pairs |
| ---------- | -------------------: | -----------------------: | ----------------------: | -----------: |
| B/A        |              -4.222% |       [-5.091%, -2.500%] |                 -5.827% |        12/12 |
| B/C        |              -2.469% |       [-4.623%, -1.991%] |                 -2.976% |        12/12 |
| C/A        |              -1.300% |       [-1.816%, +0.146%] |                 -2.938% |         9/12 |

This supports a modest Jitendex import improvement on this hosted runner: both candidate comparisons are consistently faster, and both descriptive paired-median intervals are below zero. The unchanged-code comparison still shows drift, so report both baselines and the more conservative B/C estimate. These are 10,000-resample descriptive intervals with the fixed seed, not cross-device guarantees or process-memory evidence. See [qualification audit](local/pack-dispatch-qualification-jitendex-audit.json), [independent paired calculation](audits/packing-qualification-independent-pairs.json) and [complete raw observations](browser/qualification/pack-dispatch-jitendex/observations.json).

## JMdict packing screen

The separate six-block JMdict packet from run 45262916933 also passed all 18 timed imports and both diagnostics. Its independent audit verified artifact members, frozen source/tooling identities, harness hashes, recorded package hashes, the intended two runtime changes and all recorded correctness checks.

| Comparison | Median paired change | Descriptive 95% interval | Equal-work total change |
| ---------- | -------------------: | -----------------------: | ----------------------: |
| B/A        |              -2.706% |      [-11.442%, -0.073%] |                 -5.071% |
| B/C        |              -1.824% |       [-4.107%, +3.411%] |                 -0.919% |
| C/A        |              -1.642% |      [-12.720%, +3.047%] |                 -4.191% |

This screen establishes no JMdict gain. The B/A interval narrowly excludes zero, but B/C does not, and unchanged-code drift is broad. These are descriptive six-pair intervals with no multiple-comparison correction. Keep all observations and interpret each comparison together with both baselines. See [JMdict independent audit](local/jmdict-pack-dispatch-audit.json) and [raw observations](browser/screen/pack-dispatch-jmdict/observations.json).

## Record-run screens against PR849

All three record-run screens compare PR855 with its exact PR849 parent. Each passed all 20 imports, and the audits verified frozen identity, harness and recorded package/correctness receipts. The single intended runtime module differs. These comparisons retain direct final columns in both arms. The JMdict results are:

| Comparison | JMdict median paired change | Descriptive 95% interval |
| ---------- | --------------------------: | -----------------------: |
| B/A        |                     +2.225% |      [-0.645%, +13.030%] |
| B/C        |                     -0.978% |      [-14.160%, +4.210%] |
| C/A        |                     +2.753% |      [-2.841%, +33.132%] |

This is an inconclusive result with a positive B/A median; no JMdict gain is established. The first unchanged-code control took 1,492.9 ms against baseline 933.1 ms, about 60% drift. That observation remains included. See [record-run JMdict audit](local/record-runs-screen-jmdict-audit.json) and [raw observations](browser/screen/record-runs-jmdict/observations.json).

The Jitendex record-run screen also passed all 20 imports, with 436,555 rows, 72 fixed lookup receipts after restart per import, all 236 media files checked in diagnostics and 64 sampled files per timed import. Its result is inconclusive:

| Comparison | Jitendex median paired change | Descriptive 95% interval |
| ---------- | ----------------------------: | -----------------------: |
| B/A        |                       +0.125% |       [-3.245%, +3.996%] |
| B/C        |                       -1.482% |       [-5.962%, +0.257%] |
| C/A        |                       +1.190% |       [-1.730%, +9.245%] |

No Jitendex gain is established. See [Jitendex record-run audit](local/record-runs-screen-jitendex-audit.json) and [raw observations](browser/screen/record-runs-jitendex/observations.json).

The VNDB record-run screen passed all 20 imports and restart checks, with 6,648,310 rows, 72 fixed lookup receipts per import and unchanged logical storage of 609,553,611 bytes. The separate A/B diagnostics verified all 146,570 referenced media files and 188,131,284 bytes; the timed imports each checked 64 sampled files.

| Comparison | VNDB median paired change | Descriptive 95% interval |
| ---------- | ------------------------: | -----------------------: |
| B/A        |                   -0.812% |       [-9.148%, +1.667%] |
| B/C        |                   -0.549% |       [-2.508%, +0.444%] |
| C/A        |                   +0.152% |       [-8.380%, +2.497%] |

No VNDB gain is established. Both candidate intervals cross zero, and the unchanged-code first block has a -13.60% C/A difference. All blocks remain included. See [VNDB record-run audit](local/record-runs-screen-vndb-audit.json) and [raw observations](browser/screen/record-runs-vndb/observations.json). PR855 remains a draft: all three exploratory screens are inconclusive. Do not pool the dictionaries or use the superseded original encoder timings as evidence for this stack.

## VNDB packing and media-path screens

Both first-run VNDB packets passed all 20 imports and restart checks, with 72 lookup receipts per import. Each candidate's two separate diagnostics verified all 146,570 media files and 188,131,284 media bytes against the independently checked baseline receipt. Logical storage remained 609,553,611 bytes. The audits verified all 164 original artifact members per packet, frozen identities and harness hashes, recorded package hashes and the exact intended runtime changes.

| Candidate / comparison | Median paired change | Descriptive 95% interval | Equal-work total change |
| ---------------------- | -------------------: | -----------------------: | ----------------------: |
| PR851 packing B/A      |              -0.542% |       [-6.532%, +0.635%] |                 -2.490% |
| PR851 packing B/C      |              -0.329% |       [-2.509%, +5.553%] |                 +0.855% |
| Packing control C/A    |              +0.361% |      [-10.582%, +1.948%] |                 -3.316% |
| PR846 media paths B/A  |              +0.057% |       [-9.486%, +0.986%] |                 -3.393% |
| PR846 media paths B/C  |              -0.268% |       [-2.562%, +0.989%] |                 -0.631% |
| Media-path control C/A |              +0.144% |       [-7.681%, +0.653%] |                 -2.779% |

Neither screen establishes a VNDB import gain. Their median candidate effects are close to zero and all intervals cross zero. Retain the influential first blocks and both unchanged-code comparisons; their total-time differences are not a basis for promotion. PR846 remains a draft. See both completed records in [VNDB audit](local/vndb-screen-audit.jsonl), [packing observations](browser/screen/pack-dispatch-vndb/observations.json) and [media-path observations](browser/screen/media-path-vndb/observations.json).

## Validation failures and recovery

At **2026-11-23 21:19:39 UTC**, the exact published sources for PR846, PR851 and PR855 each had **15 successful executed CI jobs and four conditional skips**, with none pending or failing. Full connector run/job metadata is retained in [PR846](ci/pr846-final.json), [PR851](ci/pr851-final.json) and [PR855](ci/pr855-final.json). The final [PR859 receipt](ci/pr859-final.json), captured at **21:31:40 UTC**, records the same 15 successful executed jobs and four conditional skips for its unchanged published source. All four product PRs therefore have completed green CI.

These gates include unit tests, main/dev/test/bench types, JavaScript/HTML/CSS/JSON/Markdown checks, the Test Build gate, Chromium/Firefox E2E and the Anki matrix. Conditional Edge, release-upgrade and Android jobs were skipped. For PR846, PR851 and PR859, the commit workflow metadata also records successful CodeQL, restart interruption, dependency review, workflow lint and static-web acceptance runs. PR855's returned workflow list records successful dependency review, workflow lint and static-web acceptance; it does not contain separate CodeQL or restart runs. The earlier PR855 partial CI snapshot remains alongside its completed receipt.

Keep unsuccessful runs alongside their successful follow-ups:

- The VNDB full local suite had two missing-compiler setup failures and an Android five-second timeout. An isolated rerun passed the 22 Android tests; the two native suites passed all 21 tests after the current compiler was selected. The original full-suite and intermediate rerun logs remain retained.
- The stacked record test initially timed out at the large score-dictionary boundary. Final focused coverage passed 272 tests. A combined lint process was killed with exit 137; changed-test lint passed separately. A test-typecheck constrained to 768 MiB exhausted that heap with exit 134; the isolated 1,536 MiB rerun passed. These are separate attempts, not a single uninterrupted clean suite.
- Earlier Jitendex lint errors and the corrected passing run are both retained. Six focused suites passed 120 tests, with a final 13-case dispatch regression rerun. Main and test typechecks passed.
- The audit's initial assertion compared complete A/C package metadata, including C's explicit `identicalArchiveFromArm` field. The corrected audit compares source, entry hashes and archive hash; its initial diagnostic and successful rerun are retained. This was an audit-schema assertion, not a failed browser import.
- The separate score-boundary fix at local commit `fab6370ceaeb86f0c3b936df430d285ff37236e0` retains an intentional failing control, the final regression, 243 passing tests across four focused suites, types, lint and dry-build logs. It addresses the low-level encoder contract; public chunk limits already protect publication. Two earlier fixture attempts hit existing 65K lookup limits; their logs were overwritten before the final regression and are unavailable. The final tests separate round-trip coverage from the larger boundary case and assert exact scores without integer coercion; do not describe the missing attempts as retained evidence.

## Study completion

All planned result sets are retained: three baseline packets, three packing screens, one media-path screen, three stacked record-run screens and one independent Jitendex qualification. The eleven original artifact ZIPs contain 190 successful import observations, including the separate diagnostics. Run [45265448894](https://github.com/ManabiIO/manabitan/actions/runs/45265448894), frozen tooling `3c8f26e7ebfde84ad7bd46a5296617e18a46ca6a`, completes the independent qualification and all three stacked record-run screens. No additional benchmarks are planned for this snapshot. This report makes no process-memory, lookup-speed or screenshot-based claim.

## Reproduction and retention

Run `python3 tools/verify.py` from this directory to verify every staged file and the manifest. Original artifact ZIPs live under `browser/original-artifacts/`; extract an original ZIP into a temporary directory when rerunning its independent audit, because nested raw reports are kept only in the ZIP. The large dictionary archives, generated libraries and prepared binary slabs are intentionally omitted. [The dictionary lock](inputs/dictionaries.lock.json) supplies permanent release URLs and required archive hashes. No expiring download URLs are retained.

For the Jitendex component, build libraries at the preserved input-preparation revision, run `node jitendex/prepare-inputs.mjs PREPARATION_REPOSITORY JITENDEX_ZIP PREPARED_DIRECTORY`, then compare the generated per-file hashes with `jitendex/prepared-manifest.json`. Run `node --expose-gc jitendex/check.mjs SOURCE_REPOSITORY PREPARED_DIRECTORY OUTPUT_JSON EXPECTED_COMMIT` once for each frozen compression source. The checker retains one source group at a time; the original preparer retains deduplication state across groups. `jitendex/compare.mjs` compares adjacent `baseline.json` and `candidate.json`.

The record-field runners are preserved exactly, including their original workspace and cache paths. Recreate the named checkouts or adjust those path constants in a copied runner; verify all source/lock/parser hashes against its JSON receipt before interpreting output. Set `PARITY_ONLY=1` for the original runner; the stacked runner performs no timing. The superseded local candidate can be reconstructed by applying `local/record-runs-original-superseded.patch` to the pinned develop baseline.

To repeat the snapshot comparison, place `jitendex/source-snapshot-repro.test.js` in an isolated source checkout's `test/` directory and run that file with Vitest. Test the listed baseline, PR847 and PR851 sources separately. The original reproduction used one detached checkout, changing only the two product modules between controls and restoring them afterward.

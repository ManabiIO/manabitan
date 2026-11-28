# Lookup checksum follow-up evidence

The combined score-cache and native-checksum candidate is **rejected at the component stage**. The richer measured boundary has warm regressions, and a large retained cold outlier reverses the combined equal-work result. The native experiment still requires its complete browser results; none of these local measurements establishes a whole-import gain.

This supplement retains the intrinsic typed-array guard correction, the five-arm interaction experiment, the paced diagnostic, and every new local gate attempt. The [original evidence](README.md) remains unchanged inside its original archive, including its favorable enclosing-writer observations and unfavorable warmed kernels.

## Correctness fix and exact sources

The first native guard accepted `Uint16Array` and `Int8Array` objects after their prototypes were changed to `Uint8Array.prototype`. The old JS hash reads whole words through DataView but trailing bytes through typed elements, so the forged views produced different results in the native route. On Node 22.22.0, the retained witnesses were:

| Internal kind | Byte length | Existing JS result | Native result before fix | Result after fix |
| ------------- | ----------: | -----------------: | -----------------------: | ---------------: |
| Uint16Array   |       1,026 |      1,521,503,112 |            3,597,568,538 |    1,521,503,112 |
| Int8Array     |       1,025 |      2,918,949,631 |            3,000,149,301 |    2,918,949,631 |

The fixed eligibility check calls the captured intrinsic `%TypedArray%.prototype[Symbol.toStringTag]` getter and requires the internal kind to be `Uint8Array`. Caller-owned tag properties cannot spoof this check, and their getters are not invoked. Other views retain the existing JS behavior. The fix adds no row-level check and leaves the fallback unchanged.

The fixed native runtime is published at `6eac74530a62269c171c874917a20ec341c9e662`; its hasher SHA-256 is `7ac8811fd389ea35ab9077f4c0e398b74c28396da31169ecbb7b36914c86b805`. Local `4da360ce59471b9563acf8189deeb75a11659ce9` changes only test formatting after the runtime fix. The score-only source is v3, with record-store SHA-256 `65e3bc1c98b45175d350d79a282b6445225339fafbb9024a7f02f0379222f3c9`. The local combined source was built by conflict-free cherry-picks and has no remote performance candidate or PR. Complete hashes and construction receipts are in the archive.

## Five-arm interaction screen

Each of ten balanced blocks runs frozen baseline, score only, native only, combined, and an identical baseline control in fresh Node 22.22.0 processes. The measured operation reacquires reference origin through that source module's actual factory, calls `_encodeArtifactChunkRecords` with the original captured score/reference columns, prepared lookup bytes and matching validated content base, then calls `_createLookupIndexChunk`. Begin/end lifecycle and all native initialization are charged. The outer DB/offset-validation loop, lookup preparation, parsing, compression, persistence and restart are excluded.

The new columns were captured at the real DB resolved-record append hook. All 12 frames match the corrected raw-v6 reference envelopes; the capture confirms 362,032 pending unique spans and 3,998 persisted hits. Offsets remain synthetic raw logical offsets. Separate precise-coverage processes prove that both score-eligible arms call the cache helper in all 12 groups. Serialization itself is never treated as private-origin proof.

Negative is faster. Equal work compares summed block durations; warm block durations are medians of four retained samples after six retained warmups.

| Arm vs baseline            | Cold paired median | Cold equal work | Warm paired median | Warm equal work |
| -------------------------- | -----------------: | --------------: | -----------------: | --------------: |
| Score only                 |             -9.57% |          -6.64% |             -2.47% |          -4.56% |
| Native only                |             +4.05% |         +13.97% |            +30.09% |         +31.46% |
| Combined                   |            -25.24% |         +14.46% |            +12.12% |         +23.51% |
| Identical baseline control |             -3.20% |          +0.77% |             +0.07% |          +3.00% |

The combined 447.174888 ms cold observation in block 6 remains included. Its delay spans both field and envelope work; no cause is assigned and no trimming is applied. Median component gains do not add into a dependable enclosing-operation gain. This cohort completed before the later repository-fetch activity described below.

## Paced diagnostic: contended, not qualifying

A separately planned diagnostic uses already encoded record fields and the original enclosing-writer boundary. It runs 12 fresh-process blocks for each of three spacing settings: no yield, one `setImmediate`, and a fixed 20 ms timer between successive frames. Native setup, actual synchronous envelope work and teardown enter the work metric; every actual wait and total wall duration is separately retained. No synthetic warmup precedes a cold observation.

| Spacing      | Native paired median | Native equal work | Identical control paired median | Identical control equal work |
| ------------ | -------------------: | ----------------: | ------------------------------: | ---------------------------: |
| No yield     |              -24.28% |           -18.14% |                         +13.64% |                      +15.31% |
| setImmediate |              -30.73% |           -41.73% |                          -5.61% |                      -15.99% |
| 20 ms        |              -38.30% |           -37.01% |                         -18.65% |                      -26.31% |

These controls are too variable for a performance conclusion. A concurrent read-only `git blame` query triggered an implicit partial-clone repository fetch/index operation and eventually failed with “No space left on device.” Its per-observation effect is unknown. The activity, failure and every timing remain recorded. No control effect is subtracted. This paced cohort qualifies neither a speedup nor a regression and does not resolve the richer-boundary warm regressions. No further local cohort was run under the disk pressure.

## Validation and stopping decision

On the intrinsic-kind fix, all 36 native-hasher unit tests passed. Main TypeScript and the all-target dry build passed on Node 22.22.0. Test-only ESLint first reported four parenthesis-newline style errors; mechanical formatting in local `4da360ce` then passed. A runtime typed-lint attempt was killed with signal 9 at 658,520 KiB before source diagnostics. An earlier attempt could not start because `/usr/bin/time` was unavailable. Both failures remain in the evidence.

The remote experimental source has not been relabeled as passing full source validation. Its test formatting is still a local follow-up, and exact-source full unit, lint, all-type, browser and memory qualification are not established by these component gates. The original failed combined-unit attempt and successful isolated retry remain in the first archive.

The read-only remaining-work review found only a fixed 12 duplicate compact-header parses as clearly redundant unclaimed work. The score-key loop overlaps prior #944, current-byte hashes are already under study, and the writer already hands complete lookup chunks directly to its synchronous writer without the descriptor merge copy. No new material removal was established; no additional envelope patch was implemented. The complete reasoning is in `lookup-envelope-opportunity-review.md`.

## Files and reproduction

`followup-evidence.tar.gz` contains all new raw timing/result/gate JSON and logs, scripts, input manifests, exact source identities, the local combined score delta, and guard witnesses. It excludes the 8,657,847-byte columns V8 capture and the original payload V8 captures; their acquired hashes and every column/frame digest are retained. `followup-files.sha256.json.txt` binds all members and the archive. The original 36,206,711-byte full local bundle remains unchanged with SHA-256 `26186c9da1ecf3830f8360024b7d640c27d9d60a16b8508a51e6cb3160e163f1`.

Extract both evidence archives into one directory. Regenerate and verify the corrected payload capture using the original README, then:

1. Run `node regeneration/capture-combined-columns.mjs <baseline-root> <payloads.v8> <columns.v8> input-manifests/jmdict-lookup-payloads-baseline-raw-v6.v8.json`. This helper accepts regenerated container metadata only after checking the acquired per-frame payload, field and envelope digests.
2. Run `node regeneration/verify-combined-columns.mjs <columns.v8> input-manifests/manabitan-combined-columns-0119.v8.json` to check every original column digest and emitted-envelope identity.
3. For a combined checkout, apply `followup/combined-score-delta.patch` to the fixed native runtime. The score-only source and all combined/runtime hashes are recorded in `followup/followup-summary.json`.
4. Run `python3 followup/combined-run.py <node22> <baseline-root> <score-root> <native-root> <combined-root> <payloads.v8> <columns.v8> <result.json>`.
5. The retained paced acquisition command is `python3 followup/envelope-paced-run.py <node22> <baseline-root> <native-root> <payloads.v8> <result.json>`. Reproduction does not erase the known contention in the acquired cohort.

The acquisition scripts remain unmodified in `followup/`; regeneration helpers are separately identified. Regenerated V8 containers may differ because they include paths, host details and timings, while the acquired per-column and per-frame byte digests must match.

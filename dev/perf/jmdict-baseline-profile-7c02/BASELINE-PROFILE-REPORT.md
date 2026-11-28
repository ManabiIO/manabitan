# Frozen import baseline: hosted profile campaign 7c02

## Outcome

All three dictionary jobs succeeded in [workflow run 46102820124](https://github.com/ManabiIO/manabitan/actions/runs/46102820124). Each ran an ordinary baseline import, one diagnostic trace, then another ordinary baseline import. Every observation passed the existing import, restart, lookup/content probe, and sampled-media checks. Semantic and public-output receipts matched within each dictionary.

This is a baseline-only investigation. It establishes current phase attribution and ordinary host/order variation; it does not establish an optimization gain or qualify a candidate PR.

## Source and environment

- Production source: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`, tree `d99ea4d04658f7ec1c76acdc5f3684594212a471`.
- Research workflow commit: `dcabc5f2bb5f720d598da3f5aebd90367ef98c4f`, branch `perf/import-baseline-20261128-7c02`. Only the wrapper and workflow differ from the base. No PR was opened for the profile study.
- Node 22.22.0; Chromium 153.0.8010.12; native artifact toolchain Clang/LLD 21.1.8. Each dictionary job built its own source-verified releaseChrome package on its own runner.
- Fixture lock SHA-256: `60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89`.
- Parser WASM SHA-256: `8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee`.
- Canonical scanner WASM SHA-256: `40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af`.
- Source-bound native manifest digest: `3a57887352cbc53a62bd3bda797f6513a72634515e6ea65a9a4ae9120739a1b6`.
- Published wrapper SHA-256: `682d350662d7a395118c68b2a99e28eb27f1048963eceb8a3defbbe5d9de5c74` (13,266 bytes).
- Published workflow SHA-256: `63c0309526f87ce1b695c5674e9b11de16ec9432cac94b5f92149243149edc0b` (2,553 bytes).

The local wrapper copy with a later optional trace metadata guard was never published. The exact published wrapper is preserved as `../hosted-baseline/published-profile-import-baseline-7c02.py`. The original published logs and receipts are retained unmodified.

## Ordinary controls

All numbers below are milliseconds, ordinary-before → ordinary-after. Rows can overlap and must not be summed. In particular, the native parser measurements sum work across three concurrent workers; they are not the exposed parse interval on the import critical path.

| Measurement | JMdict | Jitendex | VNDB |
|---|---:|---:|---:|
| Browser import total | 959.9 → 861.2 | 1,344.5 → 1,122.0 | 3,785.4 → 3,887.1 |
| Worker import total | 931.9 → 835.0 | 1,314.5 → 1,097.5 | 3,761.4 → 3,866.3 |
| Data-bank wall time | 789 → 688 | 1,237 → 1,048 | 3,661 → 3,761 |
| Exposed term-parse interval | 196 → 210 | 419 → 364 | 1,470 → 1,595 |
| Bulk-add terms | 561 → 452 | 756 → 626 | 1,962 → 1,923 |
| Content compression | 344.1 → 263.4 | 558.1 → 437.2 | 226.8 → 199.7 |
| Content metadata publication | 152.2 → 116.9 | 38.3 → 31.3 | 41.0 → 35.7 |
| Record-field encoding | 44.6 → 41.0 | 31.4 → 34.2 | 262.8 → 283.6 |
| Existing record-validation timing counter | 37.1 → 27.3 | 40.1 → 19.2 | 30.1 → 29.0 |
| Finalization | 123 → 126 | 28 → 25 | 22 → 23 |
| Record closeWritable | 108 → 112 | 10.6 → 10.7 | 7.6 → 7.7 |
| Summed native parser work | 823 → 802 | 1,100 → 933 | 4,989 → 5,070 |
| Summed source inflation | 343.6 → 295.2 | 845.3 → 716.5 | 948.1 → 955.3 |
| Separately reported CRC stage | 0 → 0 | 0 → 0 | 990.9 → 1,092.7 |

The identical-code controls changed by −10.28% for JMdict, −16.55% for Jitendex, and +2.69% for VNDB. These are not optimization improvements. There are only two ordinary baseline controls per dictionary, and dictionaries ran on separate hosts. Zero in the separate CRC counter does not mean no CRC work: the named parser trace contains `crc32_bytes` during JMdict/Jitendex inflation.

JMdict's observed finalization includes a 108–112 ms record close. Jitendex and VNDB show much smaller closes on their own hosts. The writer already overlaps record and sidecar finalization and retains a final durable flush. The difference is a diagnostic lead, not evidence that a flush can be removed or that a source-size threshold should change.

## Native trace attribution

The baseline parser was rebuilt once with the identical pinned compiler and arguments except `--strip-all`. Every noncustom WebAssembly section was identical to the checked-in module. The resulting symbol table maps the numeric profiler labels to source functions. Proof and names are retained in `../../strict-locals-prototype-checkpoint/baseline-symbols.json`.

Selected self-sample interval weights below sum overlapping parser-module profiles, including media workers. They are diagnostic weights, not CPU milliseconds, elapsed critical-path time, or promised savings. Scheduler delays and native waits can inflate them. These weights use the complete raw traces with corrected process/profile grouping; no original top-list cutoff is applied. The full named function table is retained in `native-profile-compact-corrected.json`.

The raw Chrome profiles also contain signed negative `timeDeltas`. The analysis retains those values exactly; it neither clamps them to zero nor treats the resulting sums as measured CPU time. Sample counts and caller relationships remain useful attribution evidence, while both long positive intervals and negative intervals limit interpretation of the reported weights.

| Native function | JMdict sample weight (ms) | Jitendex sample weight (ms) | VNDB sample weight (ms) |
|---|---:|---:|---:|
| parse_composite_span_impl | 360.828 | 471.671 | 241.924 |
| parse_and_encode_term_bank_token_binary_dedup | 275.327 | 145.589 | 1,750.288 |
| libdeflate_deflate_decompress_ex | 223.066 | 368.582 | 996.313 |
| crc32_bytes | 159.718 | 503.395 | 214.736 |
| crc32_update_gap | — | — | 911.503 |
| parse_row_single_pass | 103.846 | 45.275 | 851.767 |
| encode_term_content_token_binary_row | 96.293 | 79.292 | 20.002 |
| hash_content_xxh32_pair | 56.384 | 121.299 | 45.225 |
| hash_content_xxh32 | 13.491 | 10.694 | 283.652 |
| reuse_validated_glossary | 11.596 | 71.219 | 865.483 |

Of VNDB's `crc32_bytes` weight, 152.377 ms is in its separate media worker. A dash means no samples were observed for that function. The sqlite OPFS proxy function `f` spends its apparent dominant sampled time in `Atomics.wait`; it is not a large JavaScript CPU target.

Traced import totals were 1,349.3 ms JMdict, 1,567.8 ms Jitendex, and 4,644.1 ms VNDB. Tracing stopped at worker completion in every job. These durations are explicitly non-authoritative.

### JMdict compact record-field validator: exact caller attribution

The full JMdict trace was reanalyzed after the campaign to distinguish constructor validation from persisted reads. Every one of the 54 `parseCompactRecordFields` self samples used this captured stack:

`parseCompactRecordFields → validateRecordFields → _createLookupIndexChunk → _appendEncodedChunk → async root`

No persisted-loader or rebuild caller appeared for that function during the traced import. Fifty of the 54 samples mapped to source line 207, the `for (const scoreKey of scoreKeys)` validation loop.

| Function | Self-sample interval weight | Samples | Median interval |
|---|---:|---:|---:|
| parseCompactRecordFields | 26.265 ms | 54 | 166.5 µs |
| validateRecordFields | 3.190 ms | 4 | 264.5 µs |
| _createLookupIndexChunk | 18.760 ms | 70 | 179.5 µs |
| _encodeArtifactRecordFields | 24.137 ms | 96 | 170.0 µs |

Three long intervals account for 15.470 ms of the validator's 26.265 ms weight. The other 51 samples total 10.795 ms. This is evidence that the loop runs on the constructor path, not evidence that 26 ms of ordinary latency can be removed. Most constructor self samples map to its two `output.set` copies and are separate from validator samples.

The existing `termRecordValidationMs` counter in the ordinary table measures content-reference validation in `_encodeAndAppendArtifactChunkForState` plus encoding validation. It does **not** isolate this second compact-score scan.

The raw trace's `ProfileChunk` events can move between exporter threads. The follow-up analyzer groups by process/profile ID, verifies no conflicting node definitions, and recovers the actual execution thread from the `Profile` event. This removes the published summary's 210 unresolved JMdict, 193 Jitendex, and 256 VNDB sample-node references; all samples and time deltas resolve in the follow-up. The target validator totals are unchanged. The JMdict importer executes on DedicatedWorker thread 3649, while its profile chunks are exported on thread 3697. Published receipts have not been edited.

### Same validator in Jitendex and VNDB

The full traces confirm the same constructor/append caller stack exclusively for both additional dictionaries.

| Dictionary | Validator self weight / samples | Weight from intervals over 1 ms | Loop/check-line weight / samples |
|---|---:|---:|---:|
| JMdict | 26.265 ms / 54 | 15.470 ms / 3 | 25.825 ms / 50 |
| Jitendex | 5.668 ms / 9 | 4.376 ms / 1 | 1.111 ms / 7 |
| VNDB | 23.467 ms / 100 | 5.227 ms / 3 | 21.482 ms / 97 |

Jitendex's single long validator interval maps to the return line, and its score loop has little sampled work. The whole-import gain available from this validator alone therefore appears small on Jitendex. VNDB has more score-loop samples, but the constructor's copies are a larger separate target: 233.864 ms across 1,133 self samples at `output.set(payload, ...)`, and 31.804 ms across 175 samples at `output.set(recordFields, ...)`. These remain sampling observations, not direct CPU timings.

## Correctness and data identity

| Dictionary | Fixture revision | Term rows | Media inventory | Stored bytes per observation |
|---|---|---:|---|---:|
| JMdict | JMdict.2026-11-22 | 528,299 | 0 files | 43,520,477 |
| Jitendex | 2026.10.03.0 | 436,555 | 236 files / 4,992,155 bytes | 67,466,332 |
| VNDB | 395525135651 | 6,648,310 | 146,570 files / 188,131,284 bytes | 609,176,779 |

Each observation checks title, revision, row and media counts, 12 content probes across restart, public lookup output, and sampled media bytes. Media checking used 64 files for Jitendex and VNDB, with the full media inventory also checked. This baseline profiling campaign did not perform an all-media byte scan.

Semantic SHA-256 receipts were identical across all three observations of each dictionary:

- JMdict: `039c9b4f8f04e1964f79e76392e1f106df281f8738aa2f7f98bfcaf7c70c935a`.
- Jitendex: `6072840ec8ed064a0a9b825ebd896e6004a471a801549b7780b62eac8c7a9aa8`.
- VNDB: `72ecb5d04bacb1300cb6d6993a0e92b4d0392d84d8984e9bccdcb20b74d2594d`.

Public-output digests also matched within each dictionary. Full storage inventories are retained, and storage byte totals happened to match across each dictionary's three imports. Inventory hashes differ across fresh imports; no exact full-storage byte-identity claim is made.

## Retained evidence

All small records are in this directory:

- `jmdict-receipts.json`, `jitendex-receipts.json`, `vndb-receipts.json`: full tagged source, observations, original hotspot summaries, and outcome receipts.
- `jmdict-job.log.gz`, `jitendex-job.log.gz`, `vndb-job.log.gz`: losslessly compressed decoded job logs.
- `all-dictionary-profile-compact.json`: compact ordinary-phase table and selected original native weights.
- `native-profile-compact-corrected.json`: complete named native weights from the corrected raw-trace analysis.
- `artifact-manifest.json`: exact hosted artifact IDs, sizes, digests, and expiry metadata.
- `jmdict.trace.json.gz`, `jitendex.trace.json.gz`, `vndb.trace.json.gz`: losslessly compressed raw traces, verified against original observation SHA-256 receipts. JMdict is 5,014,171 bytes before compression, Jitendex 8,568,688 bytes, and VNDB 18,014,754 bytes.
- `{dictionary}-validator-callers.json` and `analyze-validator-stack.py`: reproducible exact caller attribution for all three dictionaries.

Hosted artifacts retain the complete raw reports and traces, built packages, environment metadata, storage/semantic receipts, and logs. Artifact IDs are 15246484756 (JMdict), 15246676338 (Jitendex), and 15246796550 (VNDB), expiring on 2026-12-12. This baseline study has no missing or failed observations.

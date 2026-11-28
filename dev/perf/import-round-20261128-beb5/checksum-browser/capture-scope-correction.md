# Native sidecar capture scope correction

This note supplements the already frozen Node and Chromium component studies. It does not change their inputs, source, schedule, or interpretation after seeing new Chromium results. The Chromium study was still queued when the distinction was identified.

The capture uses all current source partitions and real lookup/record encoders, but does not reproduce every production parser option or writer run split. Its results measure the frozen byte spans and their checksum calls, not the complete production call sequence.

## Actual worker diagnostic

The unmodified production worker was exercised through the repository's Node worker transport shim. The report and exact harness are `native-sidecar-ownership-worker.json` and `native-sidecar-ownership-worker.mjs` beside this note. Group indexes are zero based:

| Dictionary | Group index | Source banks                                |   Rows | Actual worker score type |
| ---------- | ----------: | ------------------------------------------- | -----: | ------------------------ |
| JMdict     |           0 | term_bank_1.json through term_bank_5.json   | 50,000 | Int32Array               |
| Jitendex   |           0 | term_bank_1.json through term_bank_8.json   | 16,000 | Int32Array               |
| VNDB       |           0 | term_bank_1.json through term_bank_4.json   | 40,000 | Int32Array               |
| VNDB       |          23 | term_bank_93.json through term_bank_96.json | 40,000 | Int32Array               |

The report retains every parse option, exact archive and manifest hashes, current source identities, ownership flags, and all resulting span metadata. It checks both the worker-prepared whole group and a deliberately forced pair of content-dictionary runs. Those forced runs exercise the fallback encoder; they are not a reconstruction of actual compression output.

Every tested base, derived, and record span had an ordinary fixed ArrayBuffer and ordinary Uint8Array prototype, with no own metadata shadowing or alias of parser content. The frozen three-stream helper actually entered native code once for each of 12 tested sidecars, and every result matched the existing sidecar checksum fields. This is a bounded ownership/admission diagnostic, not full-corpus activation or browser performance evidence.

## Escaped-key option and record representation

The synchronous capture sets `mediaHintFastScan` but omits `projectImagePaths` and `experimentalNativeEscapedKeys`. In the production pipeline, projected source imports at least 512 MiB automatically set `experimentalNativeEscapedKeys` and `ownContentBytes` in `ParallelTermBankPipelineRun`.

Without the escaped-key option, the fused native parser returns fallback status -5 for an escaped key. The JavaScript parser allocates Float64 score columns when the fused string plan is absent; the successful fused plan uses Int32 columns. Accordingly, the earlier synchronous capture represented VNDB group 23 with Float64 scores, while the actual worker diagnostic for precisely the same banks, with production options, returned Int32Array. This is an observed representation difference. It must not be labeled as production Float64 activation.

The relevant baseline code is `term-bank-wasm-parser.js` around the `ParallelTermBankPipelineRun` constructor, score column creation, and `term-bank-parser.c`'s `EXPERIMENT_NATIVE_ESCAPED_KEYS` guard. Baseline source is 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2. No production or frozen-study file was changed for this finding.

## Actual writer run splitting

The capture directly calls `_encodeAndAppendArtifactChunkForState` for one whole group under a synthetic `raw` content dictionary. Real `appendArtifactChunk` splits rows into runs for actual content dictionaries before encoding lookup and record sections. VNDB produces both raw-block-v2 and raw-v6 sidecars, so its production call sizes and counts differ.

Captured VNDB checksum inputs total 401,458,992 bytes. Adding its 170 captured chunk envelopes/lookup headers and one file header gives 401,468,552 bytes. The observed two production sidecars total 401,899,832 bytes; 431,280 bytes remain beyond this simple framing adjustment. The record-representation option above is an additional concrete source of scope difference, so that entire difference must not be attributed solely to run splitting.

For JMdict, captured spans plus known framing equal the observed production sidecar size: 23,748,240 + 12 × 56 + 40 = 23,748,952 bytes. This size equality does not establish an identical asynchronous schedule or complete production behavior.

## Qualification consequence

The fresh Chromium component remains useful for testing the native checksum mechanism, cold initialization and copy-inclusive costs on the retained real-source-derived spans. Any positive signal still requires integration at the final production `_createLookupIndexChunk` call, followed by actual whole-import checks, complete output identity, cancellation/reopen lifecycle validation, and warmed-session controls. The unfavorable warmed Jitendex/Intel observation remains part of the decision.

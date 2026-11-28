# JMdict operation-elimination review

Read-only review against `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` on 2026-11-28. No implementation or new timing arm was created.

## 1. Redundant key-plan copies: already covered or inactive

`ext/js/dictionary/term-bank-wasm-parser.js` creates an owned v7 index in `encodeNativeTermLookupIndex` (around line 1597), then copies the key arena, lengths and expression IDs again in `copyWasmBackedColumnChunk` (around lines 4143–4189). The current revision of [PR #820](https://github.com/ManabiIO/manabitan/pull/820), `f65f4ef97ebf2f37a5b1b79ca7733d7b362ec963`, already removes these copies at the immediate native-worker ownership boundary. Its current-corpus JMdict work receipt reports 10,434,868 cumulative bytes removed, including 2,113,196 expression-ID bytes. This is an allocation-volume result; full-import qualification remains pending.

A distinct extension could omit the global fallback plan when every row already belongs to an owned segmented index. That does not activate in the measured JMdict path: the current ordinary receipt has three workers, twelve groups and zero native segmented lookup segments. [PR #921](https://github.com/ManabiIO/manabitan/pull/921) independently documents the same policy outcome. No grouping or worker change is justified to activate this idea.

The global plan remains relevant to `appendBatchFromArtifactChunkResolvedContent` and `_encodeAndAppendArtifactChunkForState` in `term-record-opfs-store.js`: retained record materialization, mixed content-dictionary runs, content-offset-delta splitting and missing/replaced prepared entries need current keys and row IDs. Any future omission would need to preserve those fallbacks and retained-buffer ownership without caching mutable validity across an await.

**Decision:** reject as a fresh JMdict arm because the active case duplicates #820 and the distinct segmented case has no current target activation.

## 2. Duplicate numeric span scans: already covered

The strict `parse_format3_row` validates score and sequence JSON numbers. `parse_and_encode_term_bank_token_binary_dedup`, around lines 3513–3540 of `ext/js/dictionary/wasm/term-bank-parser.c`, subsequently calls `scan_scalar_span` again before integer conversion. [PR #972](https://github.com/ManabiIO/manabitan/pull/972) already carries the validated token ends; [PR #899](https://github.com/ManabiIO/manabitan/pull/899) tested broader strict integer projection.

An equivalent change must preserve JSON numeric grammar, int32 overflow/fallback, negative-zero score handling, sequence sentinels, logical bank bounds and CRC-before-publication/error ordering. It must not infer semantic validity solely from a diagnostics flag.

**Decision:** reject as duplicate work.

## Evidence and scope

- Current ordinary receipt: `profiles/jmdict/ordinary/summary.json`. It records zero fused fallbacks, zero native segments, zero compact-content groups, 131.1 ms aggregate parser result copying, and all 101,143,281 recent-source bytes adopted without another retained-slab copy. These nested/overlapping diagnostic durations are not wall-time savings.
- Exact-executable native attribution: `native-parser-analysis/function-profile.json`. The named module's executable sections match baseline SHA-256 `8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee`. Aggregate sampled JMdict CPU includes 355.57 ms composite grammar, 204.19 ms fused driver, 99.34 ms row parsing, 77.50 ms content encoding, 77.27 ms paired hashes, 11.26 ms UTF-8 copying and 15.18 ms lookup encoding.
- Other tempting whole-operation removals were already covered: native compact descriptors [#841](https://github.com/ManabiIO/manabitan/pull/841), canonical projection/copy work #631/#667/#741/#742, UTF-8 validation/copy [#941](https://github.com/ManabiIO/manabitan/pull/941), and long-glossary copy/hash fusion [#840](https://github.com/ManabiIO/manabitan/pull/840).
- Concurrent delimiter, composite-minsize, descriptor-queue, cache-envelope, codec-word-width and canonical hash-tag studies were excluded from this review.

No new implementation-worthy opportunity survived this bounded review. Existing prefix, native-checksum and decompression experiments retain their own separate source identities and qualification requirements.

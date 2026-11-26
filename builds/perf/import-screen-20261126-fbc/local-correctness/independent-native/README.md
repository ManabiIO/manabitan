# Independent UTF-8 parser review and corpus parity

No correctness blocker was found in the fixed-width `copy_valid_utf8` change. This directory records independent correctness verification against develop `0143e9596cd8f790d5e166d4ba6a2425fbc57f14`. It does not claim whole-import speed or browser peak-memory improvement.

## Tested implementation

- Baseline WASM SHA-256: `b97009b54ae1056efba84964dc6f20e334cd27f47b793a5028e66d9482cb6cfa`
- Candidate WASM SHA-256: `68d4584e47cc6371a6b0d1d1bf56bdfcdc45e8f8b138ef172e2013b7cd23f13f`
- Candidate C SHA-256: `20b595bb858258ee6bbafda345ba5c2e80fa9016b235e9ad523870ec7acfba7f`
- Node runtime: `v22.22.0`

The candidate uses explicit continuation-byte checks and copies for two-, three- and four-byte UTF-8 sequences. Static review verified that every complete-width check precedes the corresponding tail reads, the E0/ED/F0/F4 restrictions remain intact, invalid lead bytes reject, and failed partial copies remain unpublished. The two callers copy literal source strings into a separate interning arena; escaped strings already in the arena bypass this helper.

## Native sanitizer differential

`native-differential.py` extracts the exact function bodies from the baseline and candidate C files, compiles them with AddressSanitizer and UndefinedBehaviorSanitizer, and compares the return values and every output byte, including failed partial writes and canaries.

| Coverage | Cases |
| --- | ---: |
| Every byte string of length 0–3 | 16,843,009 |
| Every valid Unicode scalar, alone and with ASCII tail | 2,224,128 |
| Seeded random byte strings of length 0–96 | 1,000,000 |
| Input/output tail adjacent to a protected guard page | 5,120 |
| **Total** | **20,072,257** |

All cases passed. Address and undefined-behavior checks stayed enabled. Leak detection was disabled because LeakSanitizer cannot run under the execution sandbox's ptrace environment; these tests do not assess allocation leaks. The result and exact source hashes are in `native-differential.json`. This host-C audit complements the candidate's WASM regression tests; it is not a replacement for them.

## Compressed production-worker corpus parity

`replay.mjs` runs the unchanged production term-bank worker through `worker-adapter.mjs`, supplies the two pinned WASM modules, reads compressed member payloads through `RawZipPayloadReader`, and uses production byte-balanced groups. It executes one baseline and one candidate worker sequentially, so it does not reproduce the browser's three-worker scheduling or OPFS database writes.

| Result | VNDB | Jitendex |
| --- | ---: | ---: |
| Banks | 665 | 219 |
| Groups | 170 | 22 |
| Term rows | 6,648,310 | 436,555 |
| Decoded source bytes | 4,267,992,967 | 538,927,310 |
| Fused attempts / fallbacks | 170 / 0 | 22 / 0 |
| Native escaped-key decodes | 1,870 | 0 |
| Owned / borrowed content groups | 170 / 0 | 0 / 22 |
| Later-parse owned-buffer checks, both arms | 338 | 42 |

All nested output bytes, metadata, string/record plans, prepared lookup indexes and media rows matched in every group. Only the elapsed diagnostic `preparedLookupIndexEncodeMs` was omitted from output hashing. Group profiles were checked for matching ownership flags, native heap capacity, fallback counts, escaped-key counts and compressed-source/CRC counters. Every ordinary owned output buffer from the preceding group was rehashed after the next parse; none changed.

VNDB enabled image-path projection, ownership and native escaped keys. Both arms produced 146,570 distinct projected paths and 146,725 group-local media representatives. Jitendex used the actual production settings `projectImagePaths=false`, `experimentalNativeEscapedKeys=false`, and `ownContentBytes=false`; all 22 content slabs were borrowed. Its 339 media representatives retain materialized media rows. The legacy raw report field `projectedMediaRows` counts all media representatives; consult `options.projectImagePaths` and the summary for whether projection was enabled.

The fixture hashes were checked before and after each complete replay. Candidate source and WASM hashes were rechecked after completion. Reports retain all per-group output hashes, filenames and counters. The summary fingerprints are:

- VNDB: `9a4445239e4c891ed13ae2d706be52c297964d5f09d27e539297b93d67ea6864`
- Jitendex: `52f9782755f3746034c65ca7f6821d5d6fd03914ba43e4c3e2982ea918722b29`

The checked borrowed spans are hashed while their worker is idle. The harness deliberately allows them to change when that worker parses another group. It tests stability only for owned buffers after reuse.

## Reproduction

Install the candidate checkout's dependencies and provide the original compressed fixture and baseline WASM. These commands write reports beside the harness:

```sh
BASELINE_WASM=/path/to/baseline.wasm DICTIONARY_ID=vndb node replay.mjs /path/to/candidate /path/to/vndb_characters_by_bee.zip
BASELINE_WASM=/path/to/baseline.wasm DICTIONARY_ID=jitendex node replay.mjs /path/to/candidate /path/to/jitendex-yomitan.zip
BASELINE_C=/path/to/baseline/term-bank-parser.c CANDIDATE_C=/path/to/candidate/term-bank-parser.c python3 native-differential.py
```

Use Node 22.22.0 for the worker runs and GCC with sanitizer support for the host audit. `OUTPUT_DIR` optionally redirects the native audit artifacts. `MAX_GROUPS` can limit a worker smoke run; such a report explicitly has `complete=false`.

## Independent database handoff review

The separate Jitendex database handoff diff was reviewed for source lifetime, raw-span escape, in-flight registration, reader barriers and failure ordering. No blocker was found. In particular:

- `sourceConsumed` resolves after compression has gathered the source; fallback retains the original source until it has finished reading it.
- Metadata staging/publication completes before the early-release handler is attached. Recent-content caching copies borrowed input; record encoders that continue after an await use owned non-content arrays and resolved references.
- The in-flight batch changes to a persistence-completion barrier before releasing the parser lease. Exact raw-span comparisons are synchronous, and released reservations still participate in duplicate-reservation detection.
- Scalar and batched durable readers wait on the barrier. Batched readers drain all matching barriers before rejecting.
- Content persistence, record persistence and the release handler are joined; terminal cleanup removes registration and consumes the lease idempotently.

The new targeted tests cover source overwrite, exact collision verification, public reads, persistence and source-consumption failures, record failure while content writes remain pending, and multi-reservation drains. Those tests were reviewed; their execution was performed by the implementing agent. This static review does not establish an end-to-end import performance result.

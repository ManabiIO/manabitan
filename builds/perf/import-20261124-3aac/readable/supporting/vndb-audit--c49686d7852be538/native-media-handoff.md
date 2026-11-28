# Native single-image projection: frozen source and evidence

## Candidate and current claim

Frozen source is commit `33594ec55b34b8c88fe2c50e30c1302d50ee5847`, tree `0939bd1eec85dc0b3f15ef002a8f0f5111c80103`, based on develop `bbccabd520972cc351a65d9f545bd5369b6e9747`. The worktree `round2/media-critical` is clean. The candidate removes full glossary reconstruction for media rows whose native semantic scan proves exactly one supported image path. Full import timing, memory, and complete release package qualification remain owned by the separate browser study; the source replay establishes correctness and work removed, not elapsed savings.

The worker passes its existing live inflated-source capability to `copyWasmBackedColumnChunk`. The new native export validates the complete glossary span and implements the existing collector's selection rules. It returns the single quoted path span without heap allocation; JavaScript decodes that token and checks the existing filename media-type rule. Missing capability/export, foreign or out-of-range views, invalid input, zero or multiple paths, and unsupported extensions retain the existing JavaScript collector. No dictionary names, density thresholds, row layouts, per-row metadata, worker counts, batch sizes, or cache settings change.

## Complete pinned VNDB correctness oracle

`production-media-projection-oracle.json` is the definitive effective-production replay. Its runner is `verify-production-media-projection.mjs`. The archive is the locked 1.0.0 VNDB fixture, 291,705,969 bytes, SHA-256 `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`; the lock SHA-256 is `60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89`.

The replay uses Node 22.22.0, the frozen native module, the actual three-worker media minimum of three groups per worker, and the effective `experimentalNativeEscapedKeys: true` flag. The 24 MiB size bound determines all 170 groups because the banks total 4,267,992,967 uncompressed bytes. All 665 banks and 6,648,310 rows are covered. All 170 fused parses succeed, with 1,870 escaped keys decoded and no fused fallback.

| Mechanical count | Legacy collector | Native candidate |
| --- | ---: | ---: |
| Media rows projected across source groups | 146,725 | 146,725 |
| Distinct image paths | 146,570 | 146,570 |
| Full-glossary JSON.parse calls | 146,725 | 0 |
| Full-glossary JSON.parse input bytes | 84,398,732 | 0 |
| TextDecoder calls | 146,725 | 146,725 |
| TextDecoder input bytes | 84,398,732 | 2,391,178 |
| Native projection calls / successful single-path spans | — | 146,725 / 146,725 |

Native projection still scans and validates the original 84,398,732 bytes. The candidate replaces each full shared-buffer snapshot and glossary decode with a path-sized copy/decode; the table does not imply those source bytes cease to exist or predict whole-process peak memory. The discrepancy between 146,725 group-local media rows and 146,570 unique paths is retained.

Each candidate output chunk is deeply compared against the legacy JavaScript projection of the same parsed chunk, including all columns, content bytes, projected paths, string/key plans, and prepared lookup indexes. Each owned output is also compared with a retained snapshot after the next native parse; the last output is checked at completion. This proves projection and ownership parity for the complete fixture, not byte equality of a later persisted browser database. The ordered path digest is `178cc8ec07fe43a1b6f66ef201381703f1d570c49979d61fa3e6a6785be56c0a`.

Commands executed:

```sh
source /workspace/scratch/3aacd533c01f/round2/env.sh
node /workspace/scratch/3aacd533c01f/round2/vndb-audit/verify-production-media-projection.mjs \
  /workspace/scratch/3aacd533c01f/round2/media-critical \
  /workspace/scratch/3aacd533c01f/round2/baseline/builds/e2e-dictionary-cache/vndb_characters_by_bee.zip \
  /workspace/scratch/3aacd533c01f/round2/vndb-audit/production-media-projection-oracle.json
```

The JSON.parse/TextDecoder hooks are active only during the paired legacy/candidate copy calls. No component timing result is derived from this replay.

## Retained earlier observations and corrections

The original `media-projection-counts.json` recorded four groups per worker, the plain-path minimum, while the executed media path uses three. Both minima are below the same 170-group size bound, so bank grouping and the media byte/path counts are unchanged. The original report remains unmodified.

The earlier complete `native-media-projection-oracle.json` omitted `experimentalNativeEscapedKeys`; the standalone default is false, whereas `ParallelTermBankPipelineRun` forces true for large projected imports. That earlier run remains useful separate fallback correctness coverage, rather than the effective-production recipe. It had 26 fused fallback groups, admitted 146,296 native projections, and used the legacy collector for 429 rows. Complete chunk parity and the ordered path digest still matched. Candidate full-glossary parse input was 242,532 bytes and total decoder input was 2,626,586 bytes in that run.

The separate `native-admission-diagnostic.json` intentionally covers only the first 24 groups and remains marked incomplete. It found 13 `before-source` range rejections in group 23 after native fallback relocated the JSON. This sample explains the conservative admission behavior; it is not a complete enumeration of all 429 rejected rows. The bounds were not widened. The corrected effective-production run has zero fused fallbacks and admits all 146,725 projections. The earlier receipt, scripts, reports, and logs are preserved alongside the corrected receipt.

## Why this path was selected

Fresh ordinary and CPU-profile browser receipts used develop `698d685c21618a8e8dbdab7a49a8dcf0d30680eb` before the cache-only #824 merge. They are in `round2/artifacts/import-critical-path-3aac-vndb-45458569610-1`. The ordinary run's browser completion interval was 8,027.3 ms. Its parser workers reported aggregate result-copy time of 3,371.6 ms, while packed media append at finalization took 15 ms and media preparation already overlapped parsing. These aggregate and overlapping phases cannot be summed into an exclusive critical path.

`analyze-media-projection-trace.py` reconstructs the three relevant worker CPU profiles and retains all samples within `copyWasmBackedColumnChunk`. `media-projection-trace-attribution.json` records 3,516.056 weighted sample ms in that function, including 972.537 ms attributed to full glossary decode, 787.566 ms to the private glossary snapshot line, and 762.737 ms of `parseJson` self samples. Collector-inclusive weighted samples were 885.364 ms. These are diagnostic sampled weights, not exact CPU consumption or predicted elapsed savings.

Chrome recorded negative sample time deltas. Signed sums retain those observations exactly. Removing only negative weights yields 3,534.785 ms for the copy function as a separately labeled sensitivity calculation. The trace itself has SHA-256 `ffdd53b5157119e56f771c24bdc95221b741dcef48dcc38351b59258b8d5cdc7`. No new profile was selected to replace these observations.

## Semantics and local validation

The native walker preserves last-key behavior for duplicate selector, path, and content fields; escaped key identity; top-level versus structured-content array rules; image-node suppression of child content; ignored unknown fields; and malformed JSON fallback. Multiple paths conservatively fall back even when an individual extension would later be ignored. The whole span must be valid before the result is returned. The native read has checked memory bounds and the existing 256-level nesting cap. A 253-layer admitted shape and the deeper fallback boundary are covered without traps.

The final focused command passed four suites and 222 tests:

```sh
npm run build:dictionary-wasm -- --write
npm run build:libs
npm exec -- vitest run \
  test/term-bank-media-projection.test.js \
  test/dictionary-importer-media-reference.test.js \
  test/term-bank-experiments.test.js \
  test/term-bank-glossary-semantics.test.js --maxWorkers=2
npm run test:ts:main
npm run test:ts:test
```

Pinned Clang/LLD 21.1.8 produced the committed native module. Main and test TypeScript checks, changed-file ESLint, and `git diff --check` passed. Tests include escaped Unicode paths, empty/malformed/truncated selectors, duplicate field orders, unsupported/multiple paths, invalid ignored scalar fields, source and guard bytes unchanged, no native heap allocation, wrong/foreign source fallback, and output stability after parser reuse. A real compressed worker test rejects full glossary JSON.parse and still verifies the returned projection after a subsequent worker request.

Initial new-code type and formatting failures are retained in the earlier logs; final passing logs have distinct names. Full unit tests, all-target build, and browser import/memory qualification are delegated to the exact-source PR and parent study. No optional local full-suite or timing retry was run.

## Source and package growth

| Changed runtime file | Base bytes | Candidate bytes | Raw delta |
| --- | ---: | ---: | ---: |
| `ext/js/dictionary/term-bank-wasm-parser.js` | 204,189 | 205,979 | +1,790 |
| `ext/js/dictionary/term-bank-wasm-parser-worker.js` | 15,334 | 15,449 | +115 |
| `ext/js/dictionary/wasm/term-bank-parser.c` | 149,389 | 154,841 | +5,452 |
| `dev/data/dictionary-wasm/term-bank-parser.wasm` | 62,783 | 67,329 | +4,546 |

The C source also ships in extension archives. These files grow by 11,903 raw bytes in total; that is not the compressed package delta. The native module grows about 7.2%. Its SHA-256 is `75989e16062aee072a5b4e3ffa65f1696b0bee0db267540372f0a57cef30357f`. The manifest records the new native export and regenerated digest. Tests and build manifest account for the other source changes. Complete package comparison remains a separate gate.

Open #845 changes the fallback glossary snapshot allocator and can still help unsupported shapes; it touches the same copy block and requires manual integration. Open #850 compacts transported projected rows after image paths are computed; it is a separate mechanism but also requires resolving the shared copy method. This candidate does not duplicate their changes, #846's media-index path encoding, #863's media bookkeeping, or already-merged direct media archive reads/early payload staging.

## Evidence handoff

`native-media-projection-final-receipt.json` is the consolidated source, raw-size, recipe, correction, and artifact-hash receipt. Its SHA-256 is `315b3dea55435ea3bc4f5c6436f78570428258c0825f059777fb7c3f1be5f114`. The definitive oracle SHA-256 is `73cd4cdd23b623ee08d56e5f4f9357134814a3737a79f48f7e4724467fddd06c`; its executed runner SHA-256 is `9a516feda3d781ee172fafc3b5ddfe4623cc3999f21095e6b2ebb97dde157f6e`. All paths above are relative to `round2/vndb-audit` unless an explicit root is shown. Source and evidence are ready for parent publication; further performance conclusions require the unchanged complete-browser harness.

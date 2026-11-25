# Independent VNDB catalog checks for PR #901

This follow-up adds two importer regressions and evidence for the unchanged runtime
at PR #901 head `ea176867e66515d12f7a75c044d1082624ce76cd`. The baseline is its parent,
`7d1643e6147a10cb2165e9744cf0e63b59e46632`. It contains no extension code changes.
Earlier measurements of a separate lazy-view-only implementation are superseded;
its 12,955,080-byte heap reduction is not a result for #901.

## Retained memory and complete catalog equality

Four fixed alternating AB/BA pairs in fresh Node processes measured **10,745,124 to
10,985,820 fewer retained bytes per catalog** in `heapUsed + external` (26.38–26.97%).
This includes the candidate's additional 2,400,540 reported external bytes. Do not
add `arrayBuffers` again: it is already included in `external`.

| Per-catalog post-GC delta        |     Baseline |                 PR #901 |
| -------------------------------- | -----------: | ----------------------: |
| `heapUsed + external`            | 40,731,436 B | 29,745,616–29,986,312 B |
| `heapUsed` only                  | 38,330,856 B | 24,944,496–25,185,192 B |
| `external`                       |  2,400,580 B |             4,801,120 B |
| `arrayBuffers` (included above)  |  2,400,540 B |             2,400,540 B |
| Retained own `rawFilename` views |      147,237 |                       0 |

Each child discards two warmups, settles pending work and explicitly collects
garbage before and after retaining one catalog. Hashing and lazy raw-name access
happen after the retained-memory snapshot. Node is `24.22.3`, V8 is
`13.6.233.17-node.63`. This measures catalog retention, not whole-import peak memory.
RSS deltas are higher in the candidate processes while their final RSS is lower;
the receipt retains these warmup-dependent allocator figures without treating them
as evidence of peak or resident-memory improvement. No timing screen was run.

All eight observations have identical ordered metadata and raw filename bytes for
all **147,237 entries**, comprising **2,400,540 filename bytes**. The canonical
catalog SHA-256 is
`6542a7006ec38536e573a6a443077be39f9b09565f1a1d9b48376dd69c8d87ff`.
The hash includes every entry's filename, offset, compressed/uncompressed lengths,
compression method, CRC, encryption/directory flags, and raw filename bytes.

`catalog-memory.json` preserves every observation. `source-identity.json` gives
the combined-memory calculation and source hashes. The reusable runner is
`test/perf/dense-zip-catalog-memory.mjs`. Its post-acquisition changes are only
ESLint parentheses, braces, and wrapping; the exact measured runner is also
preserved as `acquired-memory-runner.txt`.

## Complete media output oracle

The unchanged production media-preparation worker handler ran in separate Node
processes for both revisions. Both produced identical descriptors, full packed
Blob bytes, and index bytes. A separate Python `zipfile`/`zlib` verifier compared
every decoded image with its original ZIP entry, checked sizes/CRCs, deflate
completion, occupied slots and holes, and the complete output hashes.

| Verified output           |           Result |
| ------------------------- | ---------------: |
| Images                    |          146,570 |
| Decoded image bytes       |      188,131,284 |
| Stored / deflated images  |      146,569 / 1 |
| Index slots / empty slots | 163,034 / 16,464 |
| Packed bytes              |      195,649,882 |
| Index bytes               |        3,912,816 |

- Packed Blob SHA-256: `02ea178832f43bb1ef0ff6d97c1f9b8aebe2be100842f862303e0aa943d13ecc`.
- Index SHA-256: `a385fd324da2f40f1f414f5db4c1ffe4f624076fce240eee8ccbb3426cf3aca5`.
- All decoded media SHA-256: `8e059c7593f23b9827c15df54f58c714b898fe5652d3ae756acd2fb4866b460a`.

The source is the pinned 291,705,969-byte `vndb_characters_by_bee.zip`, SHA-256
`da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`, from
`test/perf/dictionaries.lock.json`. The WASM hash matches between revisions.

The first oracle attempt failed writing its derived pack because the workspace
volume was full (`ENOSPC`); `media-worker-enospc.json` preserves the failure.
An unchanged retry used a separate temporary volume and completed all checks.
`media-worker-oracle.json` and `media-verification.json` preserve that result.
The oracle's diagnostic durations are not benchmark observations; its measured
observation list is empty. Large reproducible packs and source archives are not
committed.

This checks the production handler in Node, not browser worker startup or message
transfer, database persistence, or the full import lifecycle. Local Chromium
qualification was unavailable because Chromium aborted with `socket() Operation
not permitted`. No overall import speed or browser memory claim follows from
these checks.

## Added regressions and reproduction

The dense directory suite passes all 24 tests, including the two new contracts:

- The importer rejects a duplicate decoded filename at the end of a dense catalog.
- Real dense entries successfully decode through both `TextWriter` and
  `Uint8ArrayWriter`, exercising the importer-added `getData` method and the small
  entry decoder's object spread.

Existing #901 coverage already checks raw-name mutation, local header mismatches,
variable lengths, malformed late records, ZIP64, and cancellation. Those tests
are not duplicated here.

Use isolated baseline and candidate checkouts with dependencies and generated
libraries prepared, and the pinned fixture cache. From the candidate checkout:

```sh
node node_modules/vitest/vitest.mjs run test/dense-zip-directory.test.js --maxWorkers=1
node test/perf/dense-zip-catalog-memory.mjs "$BASELINE_ROOT" "$CANDIDATE_ROOT" "$FIXTURE_CACHE/vndb_characters_by_bee.zip" "$EVIDENCE_OUT/catalog-memory.json"
node test/perf/direct-media-entries-20261123/screen.mjs --baseline-root "$BASELINE_ROOT" --candidate-root "$CANDIDATE_ROOT" --cache-dir "$FIXTURE_CACHE" --out "$EVIDENCE_OUT/media" --oracle-only
python3 dev/perf/direct-media-entries-20261123/verify_media.py --archive "$FIXTURE_CACHE/vndb_characters_by_bee.zip" --evidence "$EVIDENCE_OUT/media"
```

To run the byte-for-byte acquired memory runner, copy `acquired-memory-runner.txt`
to a temporary `.mjs` file and invoke that file with the same four arguments.
Both runners verify fixture and source hashes; the receipts identify the exact
source revisions. Use a new output directory for each acquisition.

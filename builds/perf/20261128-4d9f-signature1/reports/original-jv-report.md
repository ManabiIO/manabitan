# Constant-S1 complete Jitendex and VNDB term-sink parity

Both complete corpora passed current-parent versus candidate byte parity. The physical first-signature column remained null throughout both candidate imports. This establishes a concrete allocation reduction of **2,097,152 bytes for Jitendex** and **1,048,576 bytes for VNDB** at the end of these imports, with the same logical metadata and persisted output. These are owned metadata-arena byte counts, not a browser peak-memory or elapsed-time qualification.

## Frozen inputs and results

Parent: `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16` (merged parser #972). Candidate: `232de57c6fd78ef1115d6db97d2ac5bb2c224417`, tree `b1f6585579990fd1083f7c505b1fc119da2f72e5`. Both trees stayed tracked-clean. Exact Node v22.22.0 SHA256 `1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31`; 512MiB old-space cap in all acquisitions. Source/runtime/helper identities, manifest hashes, archive SHA/CRC and process launch status are retained with each result.

| Corpus | Rows | Production groups | Final canonical entries | Parent owned arena bytes | Candidate owned arena bytes | Bytes avoided |
|---|---:|---:|---:|---:|---:|---:|
| jitendex | 436,555 | 22 | 363,243 | 26,214,400 | 24,117,248 | 2,097,152 |
| vndb | 6,648,310 | 170 | 157,150 | 17,301,504 | 16,252,928 | 1,048,576 |

The full output-oracle SHA256 values are:

- Jitendex: `16ea2af33a07c79d163d5c16cc73276940a9d5ab46776c0b2d300d70514ae6ff`.
- VNDB: `01aa55b3440a4bb5f6831a5e3c94eb20c2f7a672029824b00b31e3738043ea62`.

Jitendex covered 219 banks, 538,927,310 inflated source bytes, 22 record chunks, 385 codec requests/replies and 61,977,692 persisted bytes. VNDB covered 665 banks, 4,267,992,967 inflated source bytes, 192 record chunks and 409,433,345 persisted bytes. VNDB used its existing uncompressed content route (zero codec requests) and its real import-index worker with the adapter's existing no-SAH asynchronous fallback. Jitendex used four real codec workers; its size policy did not dispatch the index worker.

## What was checked

Every group retained hashes for complete parser content spans, typed metadata columns, unique content IDs/first rows/signatures, key plan strings and IDs, prepared lookup payloads and route filters before the database mutated them. The existing field analysis independently decoded every record row and compared its score/reference with the supplied source. All field and final envelope digests matched between A and B.

All persisted files were read in full and hashed twice. Raw per-run hashes are retained in `raw-final-files.json`. The comparison form normalizes only the random 16-byte generation IDs in record/index headers after checking format magic and paired generation linkage. No content payload bytes or row fields are normalized. The complete comparison contains the final file hashes plus all 23 logical metadata properties, including slots, dense/free state, ordered collision maps and dictionary interners.

The candidate metadata oracle independently decodes marker 2 as literal `0x3652424d` and logical presence 1, without calling the product materialization/getter path. Full-capacity columns are included. Allocation receipts separately count native arena bytes and any external physical S1 array, and record null status per group. Parent/candidate canonical entry counts, capacities and hash-slot counts match.

VNDB additionally passed all 170 group lists/counts and the independent media projection oracle: 146,725 representative references, 146,570 distinct image paths and 155 repeated group representatives. The ordered path digest is `178cc8ec07fe43a1b6f66ef201381703f1d570c49979d61fa3e6a6785be56c0a`; the independently checked distinct filename digest is `be30ba4f81706cfffbe2e7d4d8d3ffefe4366f6f7de9e0f562613c4d2be5b2a3`. Media files themselves are outside this term-sink boundary.

## Execution boundary and limits

The copied corrected census v5 retains production compressed lazy input, dense ZIP catalog, CRC/size validation and exact group selection from a 4-core/8GiB policy. It runs the production parser worker handler through an in-process transport adapter that preserves structured clone and borrowed-source lease behavior; it does not run three concurrent parser threads. Groups feed the public database sink in order. Codec workers and the selected import-index worker are actual Node workers. Filesystem-backed bounded OPFS writes and atomic renames preserve adapter semantics; private Blob snapshots remain outside the measured file tree. Production content payloads are unchanged, with the normal settings direct-artifact media boundary (`skipImageMetadata=true`).

The paired acquisitions are correctness/allocation observations. Parent callbacks, digests, field decoding and checkpoint I/O intentionally add work. They cannot support an import-speed claim. Sampled RSS and process high-water RSS remain in raw resources for transparency; one process per arm cannot establish a process or browser memory regression result. Browser scheduling, media persistence, settings UI, SQLite transactions, restart and lookups are not exercised by this helper.

## Preserved preflight failure

`jitendex-A-1` exited 1, with no terminating signal, before any group parsed. The source guard rejected regenerated `ext/lib/zip.js`: restored shared `node_modules` changed 24 esbuild source-path line comments, adding 936 bytes. Current A and B raw files are identical, SHA256 `48cdbc73ba8dccbba63e8d868d9a2a430625e98e0898c883b593f39d2356790e`. Replacing exactly that fixed line-comment prefix reproduces the entire frozen file byte-for-byte, SHA256 `d41cfb9b932267ebb9d018b5f77f3b973e9f48173d0f1136a2581a83735f344d`.

Protocol v2 records this exact two-hash, 24-line equivalence gate; no runtime source or generated asset was edited. The previous protocol/source, complete comment diff, provenance receipt and failed launch/logs remain under this directory. Successful runs are `jitendex-A-2`, `jitendex-B-1`, `vndb-A-1` and `vndb-B-1`; all exited 0 with no signal. There were no failed acquisitions after source preflight passed.

## Reproduction and evidence

`protocol.json`, `common.mjs`, `sink-parity.mjs`, `metadata-oracle.mjs`, `compare-results.mjs`, `file-oracle.mjs` and `launch.py` are the exact frozen helper. The original corrected census and copied helper receipt are also retained. The archive catalog and bounded OPFS adapter remain byte-identical to the reviewed upstream copies.

Use fresh output paths; the runner refuses overwrite:

```sh
python launch.py jitendex A /absolute/fresh/jitendex-A
python launch.py jitendex B /absolute/fresh/jitendex-B
/path/to/pinned/node compare-results.mjs /absolute/fresh/jitendex-A /absolute/fresh/jitendex-B /absolute/fresh/jitendex-comparison.json
python launch.py vndb A /absolute/fresh/vndb-A
python launch.py vndb B /absolute/fresh/vndb-B
/path/to/pinned/node compare-results.mjs /absolute/fresh/vndb-A /absolute/fresh/vndb-B /absolute/fresh/vndb-comparison.json
```

Machine-readable summaries are `summary.json`, `jitendex-comparison-1.json` and `vndb-comparison-1.json`. Full per-run results, normalized and raw file receipts, metadata hashes, source/resource receipts, group observations and exact launch exit statuses remain in their run directories and sidecars.

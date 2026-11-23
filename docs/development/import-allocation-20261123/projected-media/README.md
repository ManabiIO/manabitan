# Projected media transport oracle

This evidence supports [PR #850](https://github.com/ManabiIO/manabitan/pull/850), which reduces projected media rows from sixteen properties to the four diagnostic key fields consumed after projection. Complete fallback rows and persisted columns remain unchanged. The oracle passed for all 7,613,164 term rows in 937 banks across the three pinned dictionaries.

## Captured files and sources

The runner, result, and receipt are byte-for-byte copies of the original files. The receipt records the runner, result, and fixture-lock SHA-256 values; the result records runtime source and native parser hashes, checked again when the run finished.

| Source                              | Commit                                     |
| ----------------------------------- | ------------------------------------------ |
| Baseline                            | `3d65e403c644b9a5a6be3128d72f9d30050b70e0` |
| Local candidate used by this oracle | `797f1a78fab8efde8ee7aff46369bd2d19a222f9` |
| Published candidate in PR #850      | `3597a103b0f35d076587e08196caa9f5d12f53ef` |

The local and published candidate commits have the identical tree `27587b807d38c6ed910a056d46305a3ef4554b78`. Their commit IDs differ because publication used the GitHub API. The recorded runtime and fixture hashes refer to the local candidate.

## Reproduction

The unmodified runner uses the following absolute paths. Recreate this layout, or adapt a separate copy of the runner and record its new hash.

| Purpose                                                        | Path                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Baseline checkout at the commit above                          | `/workspace/scratch/1d04fee2c265/manabitan`                             |
| Candidate checkout at the local or equivalent published commit | `/workspace/scratch/1d04fee2c265/manabitan-vndb`                        |
| Pinned ZIP cache                                               | `/workspace/scratch/72c24f1e7bc9/manabitan/builds/e2e-dictionary-cache` |
| Result written by the runner                                   | `/workspace/scratch/1d04fee2c265/vndb-compact-media-oracle.json`        |

Use Node.js 24.22.3 for the recorded environment. Install the checkouts' lockfile dependencies with `npm ci` and prepare their generated libraries with `npm run build:libs`. The generated native parser must match the SHA-256 in the result. Populate the cache from the candidate's `test/perf/dictionaries.lock.json`; the runner verifies every archive's locked byte size and SHA-256. Its three fixture keys are `jmdict`, `jitendex`, and `vndb`.

From the study checkout, run:

```sh
node docs/development/import-allocation-20261123/projected-media/vndb-compact-media-oracle.mjs
```

The runner writes to the absolute scratch output path above, leaving the packaged result unchanged. A replay using the published commit records that commit ID instead of the original local ID; the source tree is equivalent. This packaging step did not rerun the oracle or any benchmark.

## Results

Property counts cover the `row` objects inside media sidecars. Serialization counts sum Node V8 serialization of each group's media sidecar array.

| Dictionary | Banks / groups | Term rows | Projected / fallback rows | Row properties, baseline → candidate | V8 serialized bytes, baseline → candidate |
| ---------- | -------------- | --------- | ------------------------- | ------------------------------------ | ----------------------------------------- |
| JMdict     | 53 / 14        | 528,299   | 0 / 17                    | 272 → 272                            | 16,962 → 16,962                           |
| Jitendex   | 219 / 55       | 436,555   | 324 / 15                  | 5,424 → 1,536                        | 211,719 → 133,836                         |
| VNDB       | 665 / 167      | 6,648,310 | 146,722 / 0               | 2,347,552 → 586,888                  | 56,685,599 → 21,817,716                   |

VNDB removes 1,760,664 row properties (75%) and 34,867,883 bytes from this serialized representation (61.51%). The source-path checks found all 236 unique Jitendex image paths and all 146,570 unique VNDB image paths; JMdict has none. Exact diagnostic digests and archive hashes are in the result.

## Coverage and limits

- The runner uses the complete real pinned ZIPs with independent Node inflate, size, CRC, and JSON decoding. It invokes the native parser once per group, then compares baseline and candidate owned copies of that same parse. All non-media columns, content buffers, key plans, and prepared lookup indexes compare exactly. Projected rows retain identical keys and ordered paths; fallback rows compare in full.
- This is a source-level transport parity replay. It uses fixed groups of four banks, private owned buffers, schema validation, media hints, content hashing/deduplication, compact metadata, and prepared lookup indexes. The native escaped-key experiment is enabled for VNDB only. These explicit settings do not reproduce the adaptive production planner or all default flags.
- Expected paths use the unchanged production `tryCollectGlossaryImagePaths` collector on separately Node-JSON-decoded source values. The source decoding is independent; the path-selection algorithm is shared.
- Generic `structuredClone` transfers owned buffers, and snapshots are checked after subsequent native heap reuse. That replay does not invoke the production worker's transferable collector or the full importer. Separate focused tests exercise the actual worker collector, mixed projected/fallback rows, retained views after a second worker request, and importer diagnostics; all 351 focused tests passed.
- Property counts and V8 serialization sizes describe representation size and copying work. They are not measurements of Chrome wire bytes, peak memory, or full-import elapsed time. Actual browser import qualification belongs to the separate hosted study; this evidence makes no timing claim.

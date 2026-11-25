# Fused media projection: corpus proof

The complete fused parser result already contains term columns. Media selection previously walked every row again after validating canonical content IDs. This change collects each content ID's first **hinted raw row** during that validation and then decodes only the selected rows. It preserves duplicate-key normalization and hint false positives; selecting only the first canonical representative would be incorrect.

## Production worker replay

The attached runner uses the production compressed source planner, actual parser workers, and unchanged WASM at eight logical CPUs and 8 GiB device memory (five workers). It verifies the locked archive SHA-256 before parsing. ZIPs use file-backed Blobs; archive identity and directory iteration are streamed. No archive-sized JS copy or collection of every media filename is retained.

| Dictionary | Source rows | Groups | Selected media rows | Maximum selected per group | Secondary loop iterations avoided |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | 528,299 | 20 | 0 | 0 | 0 (media hints disabled) |
| Jitendex | 436,555 | 22 | 339 | 30 | 436,216 |
| VNDB | 6,648,310 | 170 | 146,725 | 1,180 | 6,501,585 |

Every group completed the native fused path without fallback. Every returned chunk field matched between baseline and candidate, including typed values, canonical content bytes, all metadata and dedup arrays, all term keys, prepared lookup bytes/plans/filters, complete media rows, image paths, and local diagnostic indexes. Only the timing field and borrowed-content release function are excluded from the recursive value hash. The separate original lookup/content digest also matched. `corpus-proof.json` preserves per-group oracles, exact source/runner/WASM/fixture identities, and resource totals.

Media counts here are group representatives before global deduplication. They are not the archive's distinct image-file count. Media hint reads move into the existing ID scan; the avoided work is the second full traversal. The extra temporary number array is sparse and bounded by the group's unique content count. The existing bitmap is reused in the new location rather than adding a second bitmap.

Requested WASM allocation totals and maximum WASM heap sizes were unchanged. Process RSS was sampled only to detect runaway harness memory and is not a peak-memory improvement claim. This proof excludes global canonical deduplication, Zstd, storage, media reads, and UI. It provides no elapsed-time or complete-browser-import speedup claim. The `rowDecodeMs` counter now includes content ID validation for this fused path, so its old/new values have different boundaries.

## Reproduce

Use Node 22.22 or later and worktrees with dependencies plus generated libraries prepared. Substitute the worktree and locked archive cache paths:

```sh
node builds/perf/fused-media-projection-20261125/replay.mjs /path/to/baseline jitendex 8 /tmp/jitendex-baseline.json '{}' /path/to/cache
node builds/perf/fused-media-projection-20261125/replay.mjs /path/to/candidate jitendex 8 /tmp/jitendex-candidate.json '{}' /path/to/cache
```

Repeat for `jmdict` and `vndb`. Compare `groups`, `fullDigest`, `mediaDigest`, total rows, canonical bytes, index bytes, and resource summaries. The baseline is `7d1643e6147a10cb2165e9744cf0e63b59e46632`; the candidate runtime/tests commit is `bc303c23556986d27342f51abf5829c4453a110f`. The preserved runner's hash is included in the proof and each raw receipt it emits.

## Regression coverage

The new nine-test suite covers overwritten duplicate object keys with differing raw hints, escaped markers and false positives, strict validation, first-hinted ordering, chunk-local indexes, cross-chunk duplicates, numeric fallback, disabled hints, and repeated parse ownership. Together with the existing parser and experiment suites, 343 focused tests passed. Targeted ESLint and main TypeScript checks passed. Combined full-unit/build checks and remote browser CI are coordinated on the PR.

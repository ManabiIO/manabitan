# Owned media diagnostic key views: component evidence

This archive preserves source-backed correctness, actual buffer counts, and local validation for [PR #843](https://github.com/ManabiIO/manabitan/pull/843). It does not claim a whole-import speedup or a peak-memory reduction. Browser timing, memory, persisted media, and restart checks belong to the separate hosted qualification.

## Change and frozen source

The worker result already owns a copied string arena for its term-key plan. Successfully projected image rows can use exact subviews of that same arena for diagnostic expression/reading bytes. The change checks each key's length, offset bounds, and every byte before reusing a view. Empty keys, mismatched or incomplete plans, and rows without projected image paths retain the independent-copy path. Decoded escaped strings remain verbatim.

The existing worker transfer collector deduplicates ArrayBuffers, so these views add no separate buffer transfer. No worker protocol, source grammar, image ordering, native module, compression, persisted format, or ownership lease changes. The importer reads diagnostic keys into its own diagnostic arena before later chunk release; the borrowed native views never escape in the reused keys.

| Role                             | Commit                                     | Tree                                       |
| -------------------------------- | ------------------------------------------ | ------------------------------------------ |
| Frozen develop baseline          | `467067650653c37c1f7d6b05d6737d070e1259cd` | `934dd7011275aafa9f5b0314af8c729eb5fc96a2` |
| Local candidate used by receipts | `61e3b7e3fd05e9e40f1e9c283faa143af32588f6` | `f06a3ec9bfe4574cf50583cb0d77f4bf97e7de00` |
| Published PR #843 candidate      | `b1b4fe3b6e396f5b30f8e006de1916e8584d9d3e` | `f06a3ec9bfe4574cf50583cb0d77f4bf97e7de00` |

The complete production diff is [product.patch.txt](product.patch.txt). This candidate starts directly from develop. It contains no PR #842 glossary-copy change, PR #841 compact metadata, shared-content integration, or new diagnostic-key arena. PR #820's lookup-sidecar ownership work is also separate: this change reuses a fresh, already-owned string snapshot for media keys, with exact-byte fallback checks.

## Measured representation change

A baseline inspection first counted the actual copied media-key ArrayBuffers and checked every encoded key against the existing owned string arena. All eligible nonempty key bytes matched. The original inspection runner, report, and output are preserved as `baseline-key-counts.mjs.txt`, `baseline-key-counts.json.gz`, and `baseline-key-counts.log.txt`.

The subsequent two-arm full-source oracle exercised the actual owned-column copy and image-path projection. These counts are **fixed four-bank component partitions**, not production planner counters.

| Corpus   |      Rows | Banks | Fixed groups | Baseline key backings | Candidate key backings | Candidate independent key backings |
| -------- | --------: | ----: | -----------: | --------------------: | ---------------------: | ---------------------------------: |
| JMdict   |   528,299 |    53 |           14 |                    34 |                     34 |                                 34 |
| Jitendex |   436,555 |   219 |           55 |                   678 |                     79 |                                 30 |
| VNDB     | 6,648,310 |   665 |          167 |               293,393 |                    167 |                                  0 |

For VNDB, all **293,393 nonempty diagnostic key views** reuse 167 existing per-group string arenas. Their **4,342,421 payload bytes** are identical between arms. The 51 decoded string fields remain decoded strings. The candidate creates no separate key arena. It still creates the typed-array views and performs the explicit byte comparisons; the table does not imply that all media objects or all processing work disappear.

Jitendex reuses 648 key views for 324 image rows; the 30 dedicated buffers belong to 15 fallback rows. JMdict has 17 media hints but no projected image paths in this fixture, so its key representation is unchanged. All counts are cumulative output-object counts, not peak memory or elapsed-time savings.

## Full-source correctness

The exact-source oracle passed **7,613,164 rows across 937 banks**. It verifies archive hashes/sizes, ZIP member identities, independent inflation size and CRC, every row's keys and numeric values, and canonical content representatives against JSON. Baseline and candidate match every row's content bytes, descriptors/hashes, unique references, key plans, numeric columns, prepared lookup bytes, and media projections.

The copied worker result is also compared: all owned columns, every projected image path, and every diagnostic key. Expected paths and keys are checked against independently JSON-decoded source values. Every typed-array field in copied media rows must have an ordinary ArrayBuffer backing. Source commits, trees, product hashes, and clean status are captured before the run and verified afterward.

The original full report is [oracle.json.gz](oracle.json.gz), decompressed SHA256 `7770dce6f8e52ebc5e662e1dfe15a87c974ffb58b229d375103a618f383bcb20`. The exact runner and progress output are [oracle.mjs.txt](oracle.mjs.txt) and [logs/oracle.txt](logs/oracle.txt). [summary.json](summary.json) repeats the source identities and deterministic totals.

| Corpus   | Locked archive SHA256                                              |
| -------- | ------------------------------------------------------------------ |
| JMdict   | `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f` |
| Jitendex | `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356` |
| VNDB     | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` |

## Focused behavior and full validation

- **354 focused tests passed** across parser, experiment/worker, media reference, and media-key suites. New coverage includes exact spans, owned arena reuse, stability after native memory reuse, out-of-range row/string indexes, out-of-range offsets, wrong lengths, and equal-length unequal bytes.
- The actual parser-worker test uses `parentPort.postMessage` with the production transfer list. It checks that every transfer entry is unique, the string arena appears exactly once, all eligible key views share it, decoded escaped strings survive, and the previous result stays intact after a later native parse.
- Existing tests retain missing-image error wording/order, empty/equal readings, shared-image behavior, escaped keys, leading BOMs, and unpaired Unicode.
- **Full pinned unit run: 640 files passed, 14,380 tests passed, 47 skipped, zero failures**; [complete original output](logs/full-unit.txt).
- All four TypeScript configurations passed. Main/dev passed on the frozen source; final test/bench checks passed sequentially after concurrent heavy checks stopped.
- Changed-file ESLint, all seven dry-run build targets, actual Chrome packaging, and diff checks passed. Original outputs are retained under `logs/`.

The earlier final test-TypeScript process was killed with exit 137 and no compiler diagnostics while other heavy validation jobs were active. Bench types had not started. The empty original output is `logs/ts-test-killed.txt`, and [type-gate-initial-exit.json.txt](type-gate-initial-exit.json.txt) records the observed shell completion. The originally named output file was later archived under the `killed` name; successful retry output is separate. The empty compiler output does not establish the termination cause.

Initial test-style lint failures are retained in `logs/lint-initial.txt` and `logs/lint-index-cases.txt`; formatting was corrected before freezing. The first focused pass of 352 tests preceded the two added index-boundary cases. The final focused pass contains 354 tests, and the full unit suite exercises the final frozen source. No failed attempt is represented as a pass.

## Actual package identity

Actual Chrome archives were built with `node dev/bin/build.js --target chrome`, Node **24.22.3**, clean source, and the same installed lockfile dependencies. Each has **550 non-directory members**. Only `js/dictionary/term-bank-wasm-parser.js` differs:

| Arm       | Member bytes | Member SHA256                                                      |
| --------- | -----------: | ------------------------------------------------------------------ |
| Baseline  |      200,103 | `4caba3bb7d6afba6871a94a4daacc123ec29462ee25e6e0eac4d0ecf1d640066` |
| Candidate |      201,479 | `da1fc9f804f9718139e7bc223453e44399e319f5ed6e3156b693be2558832c59` |

[package-comparison.json.gz](package-comparison.json.gz) contains every member's size/hash, archive hashes, source identities, and the exact one-member difference list. Its decompressed SHA256 is `0a1ea8d6d49a9636858344e6d02f488b2e74ef1b464bf30de2199bbed7b789db`. The package was built before publication, so its candidate remote SHA is null; the source table above supplies the equivalent published commit.

Both native modules are unchanged. The parser remains **62,783 bytes**, SHA256 `25149bac5db0dda3bba85fe8e133fb06d51881a822f27565e4587ba223dde41c`. Both original pinned manifests are retained as `baseline-wasm-manifest.json` and `candidate-wasm-manifest.json`.

## Reproduction and limits

The runners are archived byte-for-byte with `.txt` suffixes. Copy a runner back to its executable suffix and replace only its workspace path bindings with clean recorded checkouts, the locked fixture cache, and a fresh output path. Install the lockfile dependencies and use the recorded Node version.

Focused validation used:

```sh
node node_modules/vitest/vitest.mjs run \
  test/dictionary-importer-media-reference.test.js \
  test/dictionary-importer-media-keys.test.js \
  test/term-bank-experiments.test.js \
  test/term-bank-wasm-parser.test.js \
  --maxWorkers=1 --testTimeout=30000
```

Full units set `MANABITAN_CLANG` to the retained pinned Clang/LLD 21.1.8 wrapper and run `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --testTimeout=30000`.

The oracle's elapsed fields remain in the original receipt, but this was a correctness run concurrent with other work, without a controlled paired timing protocol or warmup. They do not establish browser speed. The fixed grouping counts must not be substituted for production planner activity. Persisted browser content, exhaustive media readback, lookup execution, and memory measurements have separate scope.

`evidence-sha256.json` inventories every archived file, excluding itself, with byte length and SHA256. Gzip receipts preserve the original JSON bytes on decompression.

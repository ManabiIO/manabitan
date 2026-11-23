# Native compact content metadata: source-backed component evidence

This receipt qualifies parser correctness and records avoided work for the compact consumer representation from [PR #825](https://github.com/ManabiIO/manabitan/pull/825) plus direct native unique-descriptor emission in [PR #841](https://github.com/ManabiIO/manabitan/pull/841). It does not establish a whole-import speedup or a native heap reduction. Browser qualification is separate.

The authoritative full-source oracle passed for all **7,613,164 rows across 937 banks** in the three locked dictionaries. Every original bank was independently inflated and checked for size and CRC. Baseline and candidate agreed on every row's content bytes, content descriptors and hashes, unique references, key plans, numeric columns, prepared lookup bytes, and media projections. Canonical content representatives and every row's keys and numeric fields were also checked against an independent JSON parse.

## Source identities

| Role                                                           | Commit                                     | Tree                                       |
| -------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| Frozen develop baseline                                        | `467067650653c37c1f7d6b05d6737d070e1259cd` | `934dd7011275aafa9f5b0314af8c729eb5fc96a2` |
| Frozen local candidate used by oracle and actual package build | `ac04ebb5194cd0d52fba017ee3d804296b6275b8` | `5af34f86e394aafc77540737d80efd43762eb236` |
| Published PR #841 candidate with the same tree                 | `0ca9aed5ba46e7d9fe556181500c2279270445e3` | `5af34f86e394aafc77540737d80efd43762eb236` |
| Subsequent local test-only type narrowing                      | `1ebbc663e8e2ca1a220f9f5db1abc297d3561f98` | `8d3b724f9610f7b58d49fce1f7094a72c2c22aa4` |

The last commit adds an explicit numeric guard in the new test snapshot helper. It changes no product source, build manifest, WASM, or packaged member. The full unit run and exact-source oracle were completed before that guard; test TypeScript, the nine new tests, and their scoped lint check were rerun after it.

The inherited consumer commit was `aed295978d3ee252275ed4263c8d378a2f4b376a` from PR #825. Local commit `4e7183da4b51d5d2e7d204f3ff545a552f79e797` adapts it to this develop baseline while retaining develop's lazy scratch allocation. Native emission is the next local commit, `ac04ebb5`. A browser comparison of this candidate against develop therefore measures the **consumer representation plus native emission** together; it cannot isolate the native increment.

The frozen oracle captures Git commit/tree identities and SHA256 hashes of all eight changed product inputs before running, checks both worktrees are clean, and verifies their identities and hashes again afterward. [summary.json](summary.json) repeats those hashes and deterministic totals. The original report is [oracle-frozen.json.gz](oracle-frozen.json.gz); its decompressed SHA256 is `887a72ddec66707bdfb0c6f76c023b9b8a06e67647a2e15950916d5478874f62`.

## Activation and deterministic work

These are **fixed four-bank component partitions**, selected by the oracle. They are not production planner counters. All banks are included, with a smaller final partition where needed.

| Corpus   |      Rows | Banks | Fixed groups | Compact consumer groups | Direct native compact groups |
| -------- | --------: | ----: | -----------: | ----------------------: | ---------------------------: |
| JMdict   |   528,299 |    53 |           14 |                       0 |                            0 |
| Jitendex |   436,555 |   219 |           55 |                       0 |                            0 |
| VNDB     | 6,648,310 |   665 |          167 |                     167 |                          141 |

JMdict and Jitendex retain the original row-indexed content descriptor representation for every tested group. VNDB's 141 admitted native groups avoid **88,116,016 bytes of repeated descriptor stores** and **2,123,984 bytes of JavaScript unique-descriptor gathering**. Across native and existing JavaScript compaction, VNDB's compact descriptor snapshots avoid **103,847,328 bytes** compared with row-sized snapshots. These counters describe specific writes/copies; they are not additive estimates of peak resident memory or total process allocation.

Native admission uses the existing deferred source-CRC transaction together with a full single chunk, content slab, compact request, and module capability getter. It introduces no dictionary-name special case. The remaining 26 VNDB partitions use the existing JavaScript compaction path. If an admitted group has too few duplicates, native code expands its descriptors backward into the original row layout. Older modules without the new getter also retain the JavaScript path.

The native arena still reserves row-capacity descriptor space. Strict eight-field row validation, the full 17-word validation metadata, canonical-content equality, and source CRC completion before emission remain in place. Unit coverage includes bad later-bank CRC, numeric fallback, low-duplication expansion, nonadjacent canonical duplicates, media projections, older-module compatibility, and output stability across later parses.

## Fixtures

The runner verifies the archive size and SHA256 from `test/perf/dictionaries.lock.json` before parsing. These are the locked archives used in this receipt, not older same-named dictionaries.

| Corpus   | Archive SHA256                                                     | Original term-bank bytes |
| -------- | ------------------------------------------------------------------ | -----------------------: |
| JMdict   | `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f` |              171,617,523 |
| Jitendex | `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356` |              538,927,310 |
| VNDB     | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` |            4,267,992,967 |

The original oracle also checks each compressed ZIP member's local-header identity, decoded size, and CRC before supplying it to the parser. It covers all media projections emitted by the parser. Persisted browser database contents, lookup execution, and decoded media assets are outside this component run and belong to the browser validation.

## Pinned WASM and actual packages

Clang and LLD **21.1.8** rebuilt the native module. A separate `--check` reproduced the checked-in manifests and bytes. The exact per-arm manifests are [baseline-wasm-manifest.json](baseline-wasm-manifest.json) and [candidate-wasm-manifest.json](candidate-wasm-manifest.json); the original check output is [logs/pinned-check.txt](logs/pinned-check.txt).

| Module                  | Baseline bytes | Candidate bytes | Change |
| ----------------------- | -------------: | --------------: | -----: |
| `term-bank-parser.wasm` |         62,783 |          63,192 |   +409 |

Baseline SHA256: `25149bac5db0dda3bba85fe8e133fb06d51881a822f27565e4587ba223dde41c`.

Candidate SHA256: `bf5689e5f4e57468978c717ce68e77ca07685e666141466a019e978eb1e67ce1`.

The separate canonical scanner module is unchanged, SHA256 `40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af`.

Actual Chrome archives were built using `node dev/bin/build.js --target chrome` from clean, frozen source in independent worktrees, with Node **24.22.3** and the same installed lockfile dependencies. Each has **550 non-directory members**. [package-comparison.json.gz](package-comparison.json.gz) contains the SHA256 and uncompressed size of every member, both archive hashes, source identities, and the complete seven-member difference list:

- `js/dictionary/dictionary-database.js`
- `js/dictionary/dictionary-importer.js`
- `js/dictionary/term-bank-wasm-parser-worker.js`
- `js/dictionary/term-bank-wasm-parser.js`
- `js/dictionary/term-content-canonical-scan.js`
- `js/dictionary/wasm/term-bank-parser.c`
- `lib/term-bank-parser.wasm`

No other member differs. The package comparison's decompressed SHA256 is `37894726126ede354afa9cce51e4a38bcf83c62c94eb96193d50f3c91d58b9ec`. Archive hashes identify these local artifacts; ZIP timestamps can differ in a rebuild, so study allowlists should compare member bytes.

## Validation and retained attempts

| Check                                                                                | Result                                                                    | Original log                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Four focused files: native compact mode, parser, source CRC reuse, compact consumers | 227 tests passed                                                          | [focused.txt](logs/focused.txt)                                                                        |
| First full unit attempt, compiler environment unset                                  | 640 files passed, 2 suite setup failures; 14,380 tests passed, 68 skipped | [full-unit-first.txt](logs/full-unit-first.txt)                                                        |
| Full unit rerun with pinned compiler/linker wrapper                                  | 642 files passed; 14,401 tests passed, 47 skipped; zero failures          | [full-unit-configured.txt](logs/full-unit-configured.txt)                                              |
| Main, dev, and bench TypeScript                                                      | Passed                                                                    | `logs/ts-main.txt`, `logs/ts-dev.txt`, `logs/ts-bench.txt`                                             |
| Initial test TypeScript                                                              | One possibly-undefined content length in the new test snapshot helper     | [ts-test-initial.txt](logs/ts-test-initial.txt)                                                        |
| Test TypeScript after numeric guard                                                  | Passed                                                                    | [ts-test.txt](logs/ts-test.txt)                                                                        |
| Nine new native tests after guard                                                    | Passed                                                                    | [test-guard.txt](logs/test-guard.txt)                                                                  |
| Scoped ESLint, before and after test guard                                           | Passed; existing vendored pako warning retained                           | [lint.txt](logs/lint.txt), [lint-test-guard.txt](logs/lint-test-guard.txt)                             |
| All seven dry-run build targets                                                      | Passed                                                                    | [build.txt](logs/build.txt)                                                                            |
| Actual baseline and candidate Chrome archives                                        | Passed                                                                    | [package-baseline.txt](logs/package-baseline.txt), [package-candidate.txt](logs/package-candidate.txt) |
| Frozen full-corpus oracle                                                            | Passed                                                                    | [oracle-frozen.txt](logs/oracle-frozen.txt)                                                            |
| Pinned native rebuild check                                                          | Passed                                                                    | [pinned-check.txt](logs/pinned-check.txt)                                                              |

The first full unit attempt's only failed suites were the compiler-dependent CRC and memory-page suites; their setup could not locate a supported compiler. The configured rerun exercised those suites successfully. The pinned compiler wrapper is preserved as [pinned-clang-wrapper.sh.txt](pinned-clang-wrapper.sh.txt).

Earlier local attempts are also retained. `logs/initial-tests.txt` and `logs/lint-initial.txt` precede building generated dependency libraries. `logs/tests-integration.txt` contains two inherited PR #825 scratch assertions that were updated to match develop's existing lazy allocation; the remaining 216 tests passed. `logs/new-tests.txt` records a worker exit during the first large snapshot assertions, without a proven underlying cause. The assertions were changed to hash byte snapshots while retaining exact column checks; all nine tests then passed, including in the full suite. These attempts are not omitted from the evidence.

The earlier full-corpus run, [oracle.json.gz](oracle.json.gz), also passed, but started before the native product commit was made; its recorded HEAD is the previous consumer commit. It is retained as a preliminary receipt only. The authoritative `oracle-frozen` rerun uses committed, clean trees and before/after source guards.

## Reproduction and limits

The original runners are preserved byte-for-byte as `oracle-frozen.mjs.txt`, `oracle.mjs.txt`, and `package-compare.py.txt`. The `.txt` suffix marks archived execution inputs, not a new maintained build or test entry point. Their hardcoded workspace paths identify the original execution. For reproduction, copy the frozen runner to a `.mjs` file and replace only its `baselineRoot`, `candidateRoot`, `cacheRoot`, and `outputPath` bindings with clean checkouts of the recorded source trees, the verified fixture cache, and a fresh output path. Install the lockfile dependencies and run it using the recorded Node version.

The focused command was:

```sh
node node_modules/vitest/vitest.mjs run \
  test/term-bank-native-compact-metadata.test.js \
  test/term-bank-wasm-parser.test.js \
  test/term-bank-source-crc-reuse.test.js \
  test/term-content-unique-metadata.test.js \
  --maxWorkers=1 --testTimeout=30000
```

The configured full unit command was:

```sh
MANABITAN_CLANG=/workspace/scratch/72c24f1e7bc9/round3-pinned-clang \
  node node_modules/vitest/vitest.mjs run --maxWorkers=2 --testTimeout=30000
```

The separate pinned artifact check set `MANABITAN_CLANG` and `MANABITAN_WASM_LD` to the pinned Clang/LLD binaries, set their runtime library path, and ran `node dev/bin/build-dictionary-wasm.js --check`.

Diagnostic elapsed times are retained in both oracle reports, but these runs were correctness work with other validation running concurrently. They had no controlled paired timing protocol or warmup. They establish full-source parity and activation, **not browser import speed**. The fixed four-bank activation counts must not be substituted for production planner results. `evidence-sha256.json` records every archived file's byte length and hash, including decompressed hashes for gzip receipts.

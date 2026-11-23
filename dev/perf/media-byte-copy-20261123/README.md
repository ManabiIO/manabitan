# Shared glossary byte copy: exact-source evidence

This archive records component correctness and local validation for [PR #842](https://github.com/ManabiIO/manabitan/pull/842). It does not establish browser import speed or peak-memory improvement. The separate hosted study evaluates those effects.

## Change and source identity

The production change is one line in `copyWasmBackedColumnChunk`: use `new Uint8Array(row.glossaryJsonBytes)` in place of `Uint8Array.from(row.glossaryJsonBytes)` when snapshotting a shared glossary view before image-path projection. The typed-array constructor still creates an owned, exact-span, ordinary ArrayBuffer. The decoder and JSON/image-path processing are unchanged. This branch contains no compact-metadata, shared-content, pooled-key, parser-grammar, storage-format, or compression change.

| Role                                 | Commit                                     | Tree                                       |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| Frozen develop baseline              | `467067650653c37c1f7d6b05d6737d070e1259cd` | `934dd7011275aafa9f5b0314af8c729eb5fc96a2` |
| Local candidate used by all receipts | `5ba8d8b2e797ab09f612c398d29900d2675809d1` | `8ece3d2c355b78573705872987e95e36555e453d` |
| Published PR #842 candidate          | `396a87e25036963c0836ee58650e2459559189b8` | `8ece3d2c355b78573705872987e95e36555e453d` |

The complete product diff is preserved in [product.patch.txt](product.patch.txt). The other changed repository file adds one focused test for an exact shared subview, escaped image paths, an owned decoder snapshot, and stability after the source view is overwritten. Existing tests cover missing-image errors, diagnostic keys, escaped and unpaired Unicode, and fallback behavior.

The oracle records source commits, trees, module hashes, and every changed product input's SHA256 before running. It verifies clean source and the same identities and hashes after completion. [summary.json](summary.json) contains these source identities and coverage totals.

## Full-source correctness

The frozen oracle passed all **7,613,164 rows across 937 banks**. It independently checks every archive's locked size/hash, every term bank's ZIP header, inflated size and CRC, every row's keys and numeric values, and canonical content representatives against JSON. It compares all row content bytes, metadata/hashes, unique references, lookup bytes, and media projections across baseline and candidate.

This runner also executes the actual **owned column copy and image-path projection** where the changed line lives. It compares the owned columns and every projected row between arms; expected image paths and diagnostic keys are checked against independently JSON-decoded source values. All emitted typed-array fields in those copied media rows must use ordinary owned ArrayBuffers.

| Corpus   |      Rows | Banks | Fixed groups | Shared glossary snapshots | Snapshot bytes | Rows with projected image paths |
| -------- | --------: | ----: | -----------: | ------------------------: | -------------: | ------------------------------: |
| JMdict   |   528,299 |    53 |           14 |                        17 |          5,264 |                               0 |
| Jitendex |   436,555 |   219 |           55 |                       339 |        818,519 |                             324 |
| VNDB     | 6,648,310 |   665 |          167 |                   146,722 |     84,396,857 |                         146,722 |

These are **fixed four-bank component partitions**, not production planner counters. The snapshot counts establish that the changed path executes. Both arms copy the same payload byte count; the change replaces the copy operation, not its output or payload size. Media hints with no recognized image path retain the existing fallback, including all 17 JMdict hints in this fixture.

The full original report is [oracle.json.gz](oracle.json.gz). Its decompressed SHA256 is `aa02d19115a02f384552ccf3641594f1176d4bc62382d430f9096dcb41c43f9e`. The original runner and progress log are [oracle.mjs.txt](oracle.mjs.txt) and [logs/oracle.txt](logs/oracle.txt).

### Locked fixtures

| Corpus   | Archive SHA256                                                     |
| -------- | ------------------------------------------------------------------ |
| JMdict   | `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f` |
| Jitendex | `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356` |
| VNDB     | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` |

The fixture lock is `test/perf/dictionaries.lock.json` at the recorded source. Persisted browser databases, restart lookups, and decoded image assets are outside this component oracle and are covered by separate browser qualification.

## Actual packages

Actual Chrome archives were built from clean source using `node dev/bin/build.js --target chrome`, Node **24.22.3**, and the same installed lockfile dependencies. Each archive contains **550 non-directory members**. Exactly one differs:

| Member                                   | Baseline bytes | Candidate bytes |
| ---------------------------------------- | -------------: | --------------: |
| `js/dictionary/term-bank-wasm-parser.js` |        200,103 |         200,102 |

Baseline member SHA256: `4caba3bb7d6afba6871a94a4daacc123ec29462ee25e6e0eac4d0ecf1d640066`.

Candidate member SHA256: `1703c926979cc4582e69e535583f5e960fd43267c1ddb5e3439f19af55475f5a`.

[package-comparison.json.gz](package-comparison.json.gz) retains both complete member maps, sizes, hashes, archive hashes, and source identities. Its decompressed SHA256 is `be35b1f507168742504bdad1fbea46a9ae55423f74160fa625ba402d878523df`. The local package was built before publication, so the report's candidate remote SHA is null; the identity table above maps its exact local tree to the published candidate.

Both native modules are unchanged. The per-arm pinned manifests are retained separately as [baseline-wasm-manifest.json](baseline-wasm-manifest.json) and [candidate-wasm-manifest.json](candidate-wasm-manifest.json). The parser remains **62,783 bytes**, SHA256 `25149bac5db0dda3bba85fe8e133fb06d51881a822f27565e4587ba223dde41c`.

## Validation

- **202 focused tests passed** across the native parser, media references, and media key cases; [original log](logs/focused.txt).
- All four TypeScript configurations passed: main, dev, test, and bench. Their original empty successful outputs are retained under `logs/ts-*.txt`.
- Changed-file ESLint passed; the existing vendored pako warning is retained in [logs/lint.txt](logs/lint.txt).
- All seven dry-run build targets passed; [logs/build.txt](logs/build.txt).
- Actual Chrome packaging passed; [logs/package.txt](logs/package.txt).
- Full-source oracle passed with source identity guards; [logs/oracle.txt](logs/oracle.txt).
- **Full pinned unit run: 640 files passed, 14,374 tests passed, 47 skipped, zero failures**; [original complete log](logs/full-unit.txt). All local product checks above passed on their first attempt.

The focused command was:

```sh
node node_modules/vitest/vitest.mjs run \
  test/dictionary-importer-media-reference.test.js \
  test/dictionary-importer-media-keys.test.js \
  test/term-bank-wasm-parser.test.js \
  --maxWorkers=1 --testTimeout=30000
```

The full unit command sets `MANABITAN_CLANG` to the pinned Clang/LLD 21.1.8 wrapper, then runs `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --testTimeout=30000`.

The separate evidence worktree initially lacked generated dependency bundles needed to load the repository's ESLint configuration. Its reproduced setup failure is retained in `logs/evidence-lint-setup.txt`. Building the dependency bundles resolved that setup issue; evidence JSON lint and Markdown formatting then passed. It did not alter the frozen product or any oracle input.

## Reproduction and interpretation

The archived runner files keep their exact execution bytes with a `.txt` suffix. To reproduce, copy `oracle.mjs.txt` to a `.mjs` file and replace only its workspace path bindings with clean recorded source checkouts, the verified fixture cache, and a new output path. Install the lockfile dependencies and use the recorded Node version. The package comparison runner is archived in the same way.

The oracle's elapsed fields are retained for completeness. The run was a correctness check concurrent with other validation, without a controlled paired performance protocol or warmup. They are **not speed measurements**. The source-copy change is independent of PR #799's earlier repeated-row projection loop; that earlier PR does not remove this owned glossary snapshot. No result from that previous study is attributed here.

`evidence-sha256.json` records every archive file's size and SHA256, plus decompressed hashes for gzip receipts. Gzip compression preserves the original report bytes on decompression.

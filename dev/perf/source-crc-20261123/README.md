# Source CRC reuse component study

This study measures the native source-inflate and term-parser portion of dictionary import. It does **not** measure complete browser import latency. PR #819's browser qualification is a separate gate.

## Candidate and baseline

| Item                              | Identity                                                           |
| --------------------------------- | ------------------------------------------------------------------ |
| Baseline develop commit           | `5e1f8c12f7ff798ba407323aff675cb23b22af02`                         |
| Published candidate commit        | `0d5a05c40410fd97b0b85a2ad5e432dc5507bb33`                         |
| Equivalent local candidate commit | `a0dc35abafcc3e411de65d62def2fa88f0f6fb31`                         |
| Candidate tree                    | `9e453e1ea1caca6b0c8105d61710538a3562ec8e`                         |
| Baseline parser WASM SHA-256      | `cc749c53fc32dfb28eefbd69f99868f8c303caa1a3f1354231516dfa5a6e1b0f` |
| Candidate parser WASM SHA-256     | `878623a8b61354387a63ec2c957a10cd7145a4cecdea7883984eadc25bff73f9` |
| Fixture                           | `vndb_characters_by_bee.zip`, 291,705,969 bytes                    |
| Fixture SHA-256                   | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` |
| Full source                       | 665 term banks; 6,648,310 rows; 4,267,992,967 uncompressed bytes   |

Both arms use the frozen candidate's JavaScript adapter, with a separate module instance and either the baseline or candidate production WASM binary. This isolates the native CRC algorithm and its adapter overhead; it is not a comparison of two complete extension checkouts. The baseline binary lacks the new verifier export, so the common adapter retains immediate whole-bank CRC validation for that arm.

The binary is regenerated with the repository's pinned Clang and LLD 21.1.8 toolchain. The production WASM changes from 54,596 to 58,323 bytes. No vendored DEFLATE source is modified.

## Work removed

Native source inflation previously scanned the entire decoded bank again for CRC32. The parser already establishes exact equality of repeated raw glossary spans. The candidate carries that raw witness into CRC verification, scans the first occurrence, and composes subsequent occurrences with their already computed CRC and length. Gaps and non-glossary bytes are still scanned. The composition uses the same reflected IEEE CRC32 polynomial as the ordinary ZIP verifier.

Admission requires multiple banks, at least 4 MiB of uncompressed source, an uncompressed/compressed ratio of at least 32, the validated-glossary reuse path, and the native verifier export. Production enables the deferred path only inside the validated version-3 parser worker transaction. Standalone inflater callers retain immediate CRC validation.

The additional native scratch is four bytes per reserved fused-parser row, plus fixed CRC shift state (a 512-byte nibble table and scalar state) and 12 bytes of counters. It shares the existing bounded worker heap lifetime. It does not retain source bytes or witnesses across parse tasks.

## Integrity and failure behavior

- CRC covers every byte of every original bank, including array wrappers, BOM handling, whitespace, row prefixes, non-glossary fields, and tails.
- Reuse is based on byte-exact raw JSON equality. Canonically equal glossary content encoded with different whitespace, Unicode escapes, or structured text representations is not sufficient.
- Each bank's complete CRC is checked before a later bank can consume its trusted witness CRC. Witnesses are local to one invocation and are consumed only backwards in row order.
- The parser verifies source integrity before returning a chunk, copying a fallback source, resetting the source heap, or exposing a borrowed source/result view. Failed sources remain rejected through cleanup and retries, including native verifier traps.
- In deferred mode, a native inflation/wrapper error reruns the unchanged originals through ordinary immediate CRC inflation before selecting the error. This preserves the previous sequential precedence between earlier CRC failures, malformed wrappers, and later DEFLATE failures. Parser failures still yield to source CRC errors as in the previous inflate-before-parse sequence.

## Measurement boundary

`source-crc-component-benchmark.js` records fixture, source, and WASM SHA-256 identities; exact bank grouping; effective parser options; Node/V8/CPU metadata; warmup and measurement order; and a final completion marker. It refuses to replace an existing output file.

The measured interval begins before native source inflation and ends on entry to the single sink callback. It includes CRC verification, native parse/encode, JavaScript column projection, and prepared lookup generation. The historical result key `nativeMs` therefore includes JavaScript adapter work. It excludes ZIP source reads, compilation, the independent oracle, digesting, worker transport/copies, storage, media import, startup, and UI readiness. Process CPU is captured over the same interval.

`crcMs`/`sourceCrcMs` is **inside** the fused `parseMs`/`parseBankMs` interval. Do not add those phase counters. Scanned/reused byte counters describe the deferred verifier; the ordinary immediate baseline reports zero for those new counters.

The runner partitions the 665 banks into 170 byte-balanced groups with a 24 MiB target and a 12-group floor. `projectImagePaths` enables the same large projected-import escaped-key option as the production parallel pipeline. Source identity checks cover the entire fixture. The untimed Node zlib oracle independently inflates and verifies each bank's CRC and byte length and parses JSON to verify the complete row count.

Output verification consumes all borrowed views before the next parse. The current digest frames names, array types, lengths, and values for term columns, preinterned string plans, encoded content slabs, projected media rows, and prepared lookup bytes/plans. The result is checked across every measured run. Its framing differs from the earlier exploratory digest.

## Receipts

- `smoke-aa.jsonl`: measured snapshot using the same candidate binary in both arms; 16 VNDB banks / 160,000 rows, independently verified, with equal framed output digests. This tests the runner and activation counters only. Its timings are not a treatment comparison.
- `smoke-typed-aa.jsonl`: incomplete smoke of the typed reusable port on the same 16-bank VNDB sample. The process was killed (exit 137) after the two warmups while other TypeScript/integration workloads ran concurrently; it has no pair or completion record and is not a performance result. The warmup output digests match the measured snapshot. The port then received formatting-only lint changes.
- `smoke-reusable-aa.jsonl`: final typed/linted runner using the same candidate binary in both arms on the smaller complete JMdict fixture. This is a serial runner correctness check, not a treatment comparison.
- `fixed-abba.jsonl`: separate planned full-corpus warm AB/BA study, two pairs after 12 warmup groups per arm. A receipt is complete only when it contains the final `complete` record.
- `exploratory-interrupted.jsonl`: retained earlier raw run using the same production options and 170 groups. The planned second BA pair did not finish because the tool session was interrupted. Only one complete AB pair is present, so this file is exploratory and must not be described as a completed AB/BA study. Its unframed digest covered term columns, string plans, content slabs, and prepared lookup bytes, but not the additional media-row digest added to the reusable runner.

### Completed fixed AB/BA result

Both planned pairs completed on Node 22.22.0 / V8 12.4.254.21-node.33, Linux x64, Intel Xeon Platinum 8573C. The host reported nine available CPUs; initial load averages were 2.21, 4.29, and 4.16. This shared host was not reserved or CPU-pinned.

| Pair and order   | Baseline component | Candidate component | Wall change | Baseline CPU | Candidate CPU | CPU change |
| ---------------- | -----------------: | ------------------: | ----------: | -----------: | ------------: | ---------: |
| Pair 0, A then B |        5,896.63 ms |         4,365.36 ms |     -25.97% |  5,892.33 ms |   4,368.44 ms |    -25.86% |
| Pair 1, B then A |        5,978.78 ms |         4,360.43 ms |     -27.07% |  6,044.85 ms |   4,358.78 ms |    -27.89% |

Every measured run processed all 665 banks and all 6,648,310 rows with zero fused fallback groups. All four full output digests were `bb24e1761f7469c81b198c41d7f39876bd12ee732403696b4018cad4f449ba6d`. The independent source oracle checked 665 CRCs, 4,267,992,967 decoded bytes, and 6,648,310 JSON rows before timing. The receipt ends with a `complete` record at `2026-11-23T06:23:22.390Z`.

Baseline source-inflate time was 2,441.63 / 2,494.86 ms. Candidate source-inflate time was 581.60 / 559.23 ms, followed by 611.08 / 625.52 ms of source CRC work inside the fused parse interval. The component gain is consistent in both orders and in process CPU, but two pairs do not establish browser-level latency or a confidence interval.

### Retained interrupted exploration

The interrupted exploratory pair measured 5,801.22 ms baseline and 4,539.47 ms candidate over the component interval (21.75% lower). It covered every bank with equal output digest `196b8306c20cbd15fe7e99a52a49e63d6295ac24d2f90ee8002c046f243eeed5`, zero fused fallback groups, and equal row/byte counts. These numbers motivated full-browser qualification and are not a whole-import speed claim.

For the full fixture, the deferred verifier reports 3,699,708,599 bytes reused, 568,284,368 bytes scanned, and 6,490,145 reused raw glossary witnesses. Reused plus scanned bytes equal all 4,267,992,967 original bank bytes.

## Reproduction

Use Node 22.22.0 or later from the repository's supported range and install the locked dependencies. Keep fixtures external to the checkout. Extract the baseline production binary without rebuilding it:

```sh
git show 5e1f8c12f7ff798ba407323aff675cb23b22af02:dev/data/dictionary-wasm/term-bank-parser.wasm > /tmp/source-crc-baseline.wasm
node dev/perf/source-crc-component-benchmark.js \
  --fixture /path/to/vndb_characters_by_bee.zip \
  --fixture-sha256 da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792 \
  --expected-rows 6648310 \
  --baseline-wasm /tmp/source-crc-baseline.wasm \
  --candidate-wasm dev/data/dictionary-wasm/term-bank-parser.wasm \
  --output /tmp/source-crc-fixed-abba.jsonl \
  --pairs 2 --warmup-groups 12 --project-image-paths --verify-source
```

The measured executable snapshot is retained byte-for-byte as `measured-runner.mjs.txt` (SHA-256 `e2775bee0a785fbeb9ba07408aa160c454d81f0d7b4199c764fb7be50e870c85`), matching the identities recorded in the raw receipts. The reusable `.js` runner adds type annotations, repository lint integration, and input assertions outside the timed interval; its measurement, grouping, and digest algorithms are unchanged.

The output path must not already exist. Run the fixed plan once with other local test workloads stopped; preserve all runs and the completion status. `--limit-banks` is provided only for runner smoke tests. Omitting `--verify-source` skips the independent source oracle and is recorded in the configuration.

## Runtime validation

The frozen candidate passed 102 focused tests across CRC composition, source CRC reuse, inflater behavior, bank boundaries, and escaped-key fallback. The source reuse suite covers raw-distinct/canonical-equal rows with zero reused bytes, cross-bank witnesses, checksum corruption in both bank orders, malformed wrapper/DEFLATE precedence, native parser/verifier traps, allocation failures, zero result emissions before verification, sticky rejection, and valid fallback before heap reset.

All four TypeScript projects, targeted ESLint, pinned WASM reproduction (`--check`), and all-target dry-run packaging passed. The full unit run passed 626 of 628 files and 14,003 tests; eight timeouts occurred in two unrelated permission/Android helper files. Both files then passed unchanged at one worker (29/29), giving coverage of all 628 candidate unit files. The original timeout result is retained separately from the successful targeted rerun; it is not represented as a single clean full-suite execution.

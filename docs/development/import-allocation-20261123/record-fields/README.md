# Record-field encoding allocation evidence

PR [#849](https://github.com/ManabiIO/manabitan/pull/849) removes offset and length staging columns when the encoder can prove that its factory-created references and integer scores remain stable during the synchronous call. It also chooses the Float64 output format before allocating unused compact columns.

The replay compares baseline and candidate output bytes across all **7,613,164 rows in 937 pinned term banks**. Both reference modes match exactly. Each mode avoids **40,818,984 bytes of cumulative typed-column allocation** and **40,818,984 bytes of cumulative column copying**, over 255 component groups. These figures describe eliminated encoder work; they do not measure peak memory or import speed. No timing measurements were collected.

## Sources and receipt mapping

| Role | Commit |
| --- | --- |
| Baseline | `3d65e403c644b9a5a6be3128d72f9d30050b70e0` |
| Measured candidate | `49de8db6c3b1c079673f9d50af3e7a978c156a7a` |
| Published candidate | `10a8f09e96ff943ec1351b1391cb56fa7e20feed` |

The publication check verified that the measured and published candidate commits have the same Git tree: `deae81513cb4fb5508c9d9a388316e049b05429b`. The baseline tree is `c540375466fc921ab05a5526a6130bc2d48010d5`. [source-receipt.json](source-receipt.json) records source, parser, fixture-lock and WASM hashes, plus check commands and exit codes. [integrity.json](integrity.json) records the SHA-256 hash of each other packaged file.

The replay ran on Node `v24.22.3`. It uses the production native parser, production resolved-reference chunk factory, and each revision's production record-field encoder. The parser JavaScript, WASM binary and fixture lock are identical in both checkouts; the runner asserts those identities and verifies each archive's pinned SHA-256 digest.

## Results

The following results apply separately to both `raw` and `compressed-references` modes. The modes reuse the same corpus rows; adding their counts would double-count the corpus.

| Corpus | Rows | Banks | Groups | Direct Int32 rows | Generic integer Float64 rows | Allocated column bytes avoided | Copied column bytes avoided |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| JMdict | 528,299 | 53 | 11 | 528,299 | 0 | 3,169,794 | 3,169,794 |
| Jitendex | 436,555 | 219 | 22 | 436,555 | 0 | 2,619,330 | 2,619,330 |
| VNDB | 6,648,310 | 665 | 222 | 5,838,310 | 810,000 | 35,029,860 | 35,029,860 |
| Total | 7,613,164 | 937 | 255 | 6,803,164 | 810,000 | 40,818,984 | 40,818,984 |

Per mode, cumulative instrumented column allocation falls from 61,138,784 to 20,319,800 bytes, and instrumented copying falls from 60,905,312 to 20,086,328 bytes. Allocated column buffer counts fall from 993 to 537. The encoder outputs 60,929,536 bytes per mode, with every byte compared against baseline. Per-corpus output digests are retained in the original result JSON files.

All replayed outputs use the compact integer layout. The 810,000 VNDB rows with integer-valued `Float64Array` scores retain the generic path and contribute zero allocation or copy savings. Actual Float64-layout output does not occur in these corpora; its separate eight-byte-per-row scratch-allocation reduction is covered by the focused unit tests, including preservation of negative zero.

## Scope and instrumentation

- `raw` retains parser content lengths and shifts parser content offsets by `2 ** 40` to exercise a nonzero wide content base.
- `compressed-references` supplies synthetic consecutive 16-byte references, also based at `2 ** 40`. It does not run the content compressor or reproduce actual compressed offsets.
- Groups contain five JMdict, ten Jitendex or three VNDB banks. These fixed component groupings do not reproduce the production adaptive batching planner.
- Constructor instrumentation counts newly allocated `Uint32Array` and `Uint16Array` column storage. `.set` instrumentation counts column bytes copied. It preserves the native prototypes and factory origin proof, and asserts the expected allocation/copy delta for each group.
- Final `Uint8Array` output storage, other JavaScript allocations, browser OPFS writes, persisted media and whole-import behavior are outside this component replay. Browser qualification and hosted import comparisons are separate evidence.

## Preserved attempts

Attempt 1 completed JMdict and Jitendex, then stopped in VNDB because the original harness incorrectly required every parser score column to be `Int32Array`. The complete raw log retains that assertion failure. Its successful corpus receipts are associated with the unchanged attempt-1 runner hash:

`8d37230802d87cce55510159429a2bb45a602465c7c7f9f9c35a524933f96730`

Attempt 2 corrected only the harness: it copies the actual `Int32Array` or `Float64Array` score type without coercion, retains that type in its prepared-column manifest, and distinguishes direct Int32, Float64 output and generic integer-valued Float64 cases. VNDB was replayed in full and passed. Its runner hash is:

`83d614bdf49f926c85d123a3d3c17b3a6b17ecccad339fa17617a6579750f38a`

The runtime candidate remained frozen throughout. Partial attempt-1 VNDB results are excluded. Large prepared column binaries remain disposable scratch output and can be regenerated from the pinned archives.

| Evidence | Files |
| --- | --- |
| Completed JMdict and Jitendex receipts | [JMdict](attempt-1/jmdict.json), [Jitendex](attempt-1/jitendex.json) |
| Original attempt 1 | [Runner](attempt-1/runner.mjs), [raw console](attempt-1/console.log) |
| Completed VNDB receipt | [VNDB](attempt-2/vndb.json) |
| Corrected attempt 2 | [Runner](attempt-2/runner.mjs), [raw console](attempt-2/console.log) |
| Exact-source focused checks | [210 passing tests in three suites](checks/focused.log), [scoped ESLint exit 0](checks/scoped-eslint.log) |

The two runner files, three corpus receipts and four raw check/run logs were copied without modification.

## Reproduction

Prepare baseline and candidate checkouts at the commits above, install their pinned dependencies, and run `npm run build:libs` to provide the parser WASM and generated libraries. Set `CANDIDATE_ROOT`, `BASELINE_ROOT`, `DICTIONARY_CACHE` and `REPLAY_OUTPUT` to absolute paths. The cache must contain the exact archive filenames and hashes listed in `test/perf/dictionaries.lock.json`.

From this directory, reproduce the completed corpus checks with:

```sh
node --max-old-space-size=1536 attempt-1/runner.mjs "$CANDIDATE_ROOT" "$BASELINE_ROOT" "$DICTIONARY_CACHE" "$REPLAY_OUTPUT/attempt-1" jmdict jitendex
node --max-old-space-size=1536 attempt-2/runner.mjs "$CANDIDATE_ROOT" "$BASELINE_ROOT" "$DICTIONARY_CACHE" "$REPLAY_OUTPUT/attempt-2" vndb
```

Omitting the dictionary arguments from the attempt-1 command also runs VNDB and reproduces its original score-type assertion failure. Replaying the published candidate records its published commit ID in new receipts; the measured source tree remains identical.

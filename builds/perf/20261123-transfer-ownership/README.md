# Native lookup ownership: correctness and copy accounting

The transfer candidate reuses the key UTF-8 arena and Uint16 key-length table
already present in the native lookup sidecar. The production parser previously
copied both fields again while making a worker result independent of WASM
memory. This evidence establishes exact output equality and the removed copy
volume. It contains no local timing observations and makes no browser peak-memory
claim. Browser timing and sampled process-tree memory studies are recorded
separately.

## Frozen sources

| Role                          | Commit / tree                              |
| ----------------------------- | ------------------------------------------ |
| Baseline                      | `5e1f8c12f7ff798ba407323aff675cb23b22af02` |
| Final local candidate         | `adf4b7fc822571089e7dd9bd7134e0f086b32e08` |
| Published candidate / PR #820 | `8fe5926cec1396a05ed4ea52be751e48784329b7` |
| Shared candidate tree         | `df4e570212e6ef8a60f12f578b57c6d04455faa3` |
| Earlier key-bytes-only V1     | `900fd07ae417b013094b096f6919b436cd4f4b4e` |

The final three `r2-transfer-committed-oracle-*.json` reports bind the committed
candidate, exact parser/helper/WASM/lock file hashes and pinned archive hashes.
The runner rechecks source hashes after each complete corpus. Its SHA-256 is
`7044764e4eddf729101c01d0fbfabd059fa044447afa092e6166db15bbae91da`.
The native WASM binary, storage formats, worker counts and batch policies are
unchanged. The packaged runtime delta consists of
`js/dictionary/term-bank-wasm-parser.js` and
`js/dictionary/term-record-opfs-store.js`.

## Ownership and retained buffers

The producer publishes whole-chunk key and length views into its owned sidecar
before exposing the result. A module-private WeakMap records the exact producer
object and view descriptors. The copy operation checks those descriptors again;
foreign objects and replaced descriptors use the existing snapshot path. This
is an ownership witness, not a cached validation result or a claim that public
typed arrays are immutable. Current key boundaries still undergo admission
validation. Global expression/reading indexes remain independent copies so
arbitrary later splits retain their original fallback behavior.

The optimization applies when per-row byte lists are omitted, as in the
production worker pipeline. Explicit byte-list callers keep their existing
alias behavior. Tests exercise in-place changes, replaced descriptors, forged
public hints, heap reuse, ordinary/shared source buffers, structured-clone
transfer and detachment. Existing segmented native plans remain unchanged.

Active OPFS import sessions discard materialized row records after append. Some
other append paths retain row key subviews, which could otherwise keep an entire
lookup sidecar alive. The record-store change copies one tightly sized key arena
only for those retained-record paths. Two focused cache tests verify that the
stored row keys retain six key bytes rather than the full sidecar, including an
in-memory import session. This preserves the normal OPFS import's buffer reuse
while preventing the newly shared sidecar from outliving its useful contents in
the record cache.

## Exact whole-corpus results

All stable columns, content bytes and metadata, deduplication and preinterned
plans, prepared lookup bytes and media rows matched baseline exactly. The
production-shaped groups use the captured production group counts and the
worker's media/ownership policy; their bank membership was not separately
verified against browser telemetry.

| Corpus   |      Rows | Groups | Key bytes reused | Key-length bytes reused | Total copied bytes removed |
| -------- | --------: | -----: | ---------------: | ----------------------: | -------------------------: |
| JMdict   |   526,942 |     12 |        7,328,126 |                 973,654 |                  8,301,780 |
| Jitendex |   435,448 |     22 |        8,515,031 |               1,191,432 |                  9,706,463 |
| VNDB     | 6,648,310 |    170 |      182,245,874 |              20,345,712 |                202,591,586 |

These are copy-volume totals summed across independently owned results. They
are not simultaneously live bytes or resident-memory measurements. VNDB's
counted field-copy volume falls from 544,591,925 to 342,000,339 bytes. Faster
delivery can change pipeline overlap, so this accounting alone cannot establish
either an import-time improvement or a browser memory non-regression.

## Validation and retained failures

The final parser and lookup-boundary suites passed 234 tests; the final
record-store suite passed 195. Earlier runs of 7, 12 and 13 focused parser cases
and two focused retention cases overlap that coverage. They are retained as
development history, not counted as additional independent coverage. All-target
dry builds and the main TypeScript project passed. Scoped lint passed before
the final local const-alias narrowing correction. The complete test TypeScript
project was terminated with exit 137 and no TypeScript diagnostics; its empty
log and explicit tool-result receipt are preserved. The complete test-project
type gate remains a CI requirement. A later bounded check of the two changed
test files passed with the original strict test-project options, a narrowed
include list and explicit dependency type roots (8.7 seconds; 536,516 KiB maximum
resident set). This resolves the local changed-file type gap without treating
the earlier full-project termination as a passing gate.

The original small-JMdict smoke failed before parsing because the first research
runner assumed the dense ZIP directory reader always accepted the archive. The
runner now follows the ordinary ZIP-directory fallback when that reader
declines. The failed log and original runner are retained, along with the
successful smoke, V1 corpus oracles and pre-commit V2 corpus oracles. No timing
observation was retried. Final committed-source oracles reran all three corpora
to bind the final formatted parser and cache safeguard to their actual source
identity.

Two other corrected local setup gates remain in the archive: five lint
formatting diagnostics and two main-project TS18048 narrowing diagnostics after
making the local retained arena mutable. The latter was resolved with a const
alias after the optional copy. The final oracle and test logs are distinct files;
the earlier failures were not overwritten.

The bounded type check also preserves two setup failures before its successful
run: `/usr/bin/time` was unavailable, and the initial external config supplied
only `node_modules/@types`, omitting the bundled Handlebars, JSZip and Parse5
type declarations. The successful config includes both `node_modules/@types`
and `node_modules`. These were wrapper/configuration corrections, with no
additional product-source changes.

## Reproduction and archive

`retained-evidence.tar.gz` contains all retained transfer reports/logs, the three
runner revisions, final source snapshots and diff, and explicit validation
history. `manifest.json` lists every archive member's byte length and SHA-256;
`summary.json` records corpus results and backing-buffer accounting. The source
snapshot and commit mapping make the local and published identities reviewable.

After extracting the archive, build the baseline and candidate libraries with
their unchanged dependency lock, provide the locked archives, and use Node
22.22.0:

```sh
node --max-old-space-size=2048 runners/r2-parser-component.mjs oracle jmdict /path/to/baseline /path/to/candidate /path/to/JMdict.zip /tmp/transfer-jmdict.json
node --max-old-space-size=2048 runners/r2-parser-component.mjs oracle jitendex /path/to/baseline /path/to/candidate /path/to/jitendex-yomitan.zip /tmp/transfer-jitendex.json
node --max-old-space-size=2048 runners/r2-parser-component.mjs oracle vndb /path/to/baseline /path/to/candidate /path/to/vndb_characters_by_bee.zip /tmp/transfer-vndb.json
```

Use fresh report paths. The runner validates archive hashes, compares every
row's complete stable parser output using independent native modules, and
preserves partial reports on a runtime failure. It does not exercise the browser,
worker messaging, OPFS sink or UI completion boundary.

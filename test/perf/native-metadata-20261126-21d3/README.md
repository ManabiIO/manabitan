# Native metadata: complete-corpus component proof

The committed candidate preserves every compared parser output and native
lookup admission across all three locked dictionaries and the existing
2-, 3-, and 5-worker grouping policies. All nine fresh-process replays passed.
This is a sequential component proof; it does not measure complete browser
imports, parallel scheduling, stored artifacts, or process memory peaks.

The candidate uses seven 32-bit words per fused metadata row in place of 17,
plus five bounded recent full rows. The retained metadata and hash tables are
contiguous scratch space after their last use. Unused canonical-content and
interned-string tails supply additional scratch without growing the heap or
retiring live prefixes. The early attempts below demonstrate why output
parity alone was insufficient: two intermediate versions silently moved
lookup construction back to JavaScript.

## Frozen inputs and results

The baseline local commit `4efc41a8f516abf637777c6a23d6b7b3dd8cebd7` has the
same tree as published `439a1c9b6d40452061cda094b0727005553c1d1d`; its runtime
is unchanged from `0143e9596cd8f790d5e166d4ba6a2425fbc57f14`. The candidate
local commit `6ad7d0112a8dd1078a007952d2f5647162525cd9` has the same tree as
published `0e233538e975c7be11b2144974923e2bf6396254` in PR #961. The hosted
qualification shadow adds the identical benchmark receipt fix to that runtime.

Every report binds the Node version, source files, fixture lock, complete
archive size and SHA-256, native source, manifest, and both checked-in and
runtime WASM assets. The probe verifies those source hashes again after the
last group. It also hard-checks the original baseline WASM hash, preventing a
shared build asset from contaminating the control.

| Dictionary | Rows per arm and policy | Groups: 2 / 3 / 5 workers | Native segmented lookup segments: 2 / 3 / 5 |
| ---------- | ----------------------: | ------------------------: | ------------------------------------------: |
| JMdict     |                 528,299 |               8 / 12 / 20 |                                  15 / 0 / 0 |
| Jitendex   |                 436,555 |              22 / 22 / 22 |                                   0 / 0 / 0 |
| VNDB       |               6,648,310 |           170 / 170 / 170 |                                   0 / 0 / 0 |

Each policy covers 7,613,164 rows. Across the three policies, each arm processes
22,839,492 rows in 616 groups. Every group retains native lookup admission,
with zero scratch misses, fused parse fallbacks, or native lookup fallbacks.
The larger two-worker JMdict groups also exercise segmented native lookup.

The maximum buffer capacity of the **single native parser instance in each
three-worker grouping replay** was:

| Dictionary | Baseline bytes | Candidate bytes |
| ---------- | -------------: | --------------: |
| JMdict     |     43,384,832 |      41,353,216 |
| Jitendex   |     76,087,296 |      71,237,632 |
| VNDB       |     45,219,840 |      43,646,976 |

These are component WASM buffer capacities. They are not total browser memory
or sampled process peaks. Metadata byte totals in the reports sum allocations
across serial groups; they are not simultaneously retained memory. No elapsed
import times or speedup claims are derived from these records.

## What the probe checks

The byte-balancing algorithm matches the production 24 MiB target, with a
minimum of four groups per worker for plain sources or three for media-aware
sources. Worker count selects grouping only; groups execute serially in a
fresh Node 22.22.0 process for each corpus and policy.

Each compressed ZIP payload is independently inflated and CRC32-checked with
Node zlib before either native arm receives it. Both native inflators then
execute the production compressed-source transaction. The VNDB deferred CRC
path must finish before output publication, and its scanned plus reused bytes
account for all 4,267,992,967 source bytes. The production 1 GiB image-projection
and 128 MiB lookup-route gates are applied from the complete source size.

The digest compares every row's canonical content and metadata, semantic key
columns, every encoded lookup byte, prepared route filters, dedup references,
and owned media-row data. The probe separately compares native preparation,
scratch reuse, segmented lookup, fused parsing, and CRC counters. Completing
lookup indexes in JavaScript cannot conceal a loss of native admission.

JSON serialization of media-row diagnostics normalizes negative zero. The
separate literal `-0` native regression test uses `Object.is` against the
pristine baseline decoder; the component proof does not replace that test.
Browser worker leases, concurrency, complete media payload import, storage,
and whole-process memory remain separate qualification concerns.

## Preserved attempts and exact artifacts

`proofs.tar.gz` contains the nine successful raw JSON reports, all retained
failed or incomplete report checkpoints, and the exact measured replay source.
The gzip timestamp and tar ownership/time metadata are fixed. The archive and
all uncompressed member sizes and hashes are in `artifact-hashes.json.txt`.
`summary.json.txt` contains the compact comparison, and `attempts.json.txt`
records the complete attempt history and environment limits.

Two intermediate candidates failed native scratch admission: the first group
with the initial compact layout, then JMdict group 7 after adding the unused
string tail. Their semantic outputs matched only after JavaScript fallback.
A later attempt passed all JMdict groups but failed the final source identity
check because formatting changed during acquisition. None counts as a
completed proof. The nine accepted runs use the final committed source.

The exact measured replay SHA-256 is
`37c3e11594960afc7c35317f9a143a0db18c25696450610c0842e7877a992395`.
The checked-in `replay.mjs` adds two trusted-CLI import lint annotations and
object-property line breaks. Its parsed JavaScript AST was compared with the
archived source and is identical; `runner-equivalence.json.txt` records both
hashes. The unchanged measured probe remains available in the archive.

## Verify and reproduce

Verify the archive, every raw report, aggregate coverage, and every group gate:

```sh
python3 test/perf/native-metadata-20261126-21d3/verify.py
```

Prepare separate baseline and candidate worktrees at the published revisions,
install the pinned dependencies, and run `npm run build:libs` in each. Prepare
the locked archives with `node dev/perf/prepare-dictionaries.js jmdict jitendex
vndb` in this study checkout. Run each dictionary in a fresh process:

```sh
node --expose-gc test/perf/native-metadata-20261126-21d3/replay.mjs \
  --baseline-root /path/to/baseline \
  --candidate-root /path/to/candidate \
  --cache-dir /path/to/locked-dictionary-cache \
  --parser-workers 3 \
  --out builds/perf/native-metadata/workers-3-jmdict.json jmdict
```

Repeat for `jitendex` and `vndb`, and the registered worker counts `2` and `5`.
The probe refuses to overwrite an existing output. To reproduce the exact
measured script bytes, extract `measured-replay.mjs` from the archive into the
same `test/perf/native-metadata-20261126-21d3/replay.mjs` location in an isolated
study checkout before running it.

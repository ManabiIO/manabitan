# JMdict import experiments — 2026-11-19

## Scope and status

This experiment starts from develop commit
`d829f5b6e6a75ee8859d38d537d224ec33c4930e`. It uses the repository's pinned
JMdict, JMnedict, and Jitendex archives and Node 22.22.0. Product candidates,
rejected experiments, and measurement tooling are kept separate.

These are **component experiments**, not complete browser import measurements.
Chromium could not start in the executor because local sockets were unavailable;
the request for unrestricted execution was rejected. The measurements below do
not establish a browser, mobile, or complete-import speedup.

The combined component runner exercises production inflate/CRC, native parsing,
lookup preparation, content deduplication, Zstd, record/index encoding, and
finalization. Its storage adapter writes Node temporary files on close. Browser
workers and parallel compression, real browser OPFS, SQLite/journals, metadata and
media handling, backend adoption, and UI readiness are outside this boundary.
Internal phase counters overlap and must not be summed.

## Candidate: cached exact content matches

`DictionaryDatabase._findMatchingPersistedTermEntryContentMetaBatch` can prove a
primary match directly against the owned recent-source cache before calculating
rejection signatures or allocating collision/fallback bookkeeping. It still
compares every byte. A hash or sampled signature never establishes equality.

Fallback candidate lists and indexes are allocated only when at least one
descriptor needs them. Mixed waves retain ordered collision candidates, storage
reads, and error aggregation. Tests cover a mixture of cached and evicted matches,
an unequal primary whose sampled signatures collide, a cached secondary, a
missing primary, read failure alongside cached success, and unsupported codecs.

The full pinned JMdict workload contains 4,325 persisted exact comparisons, all
served by the 96 MiB recent-source cache. A dedicated preload compares the two
methods on those actual live database waves. Its timed calls are guarded against
storage, in-flight, and signature-update fallback. It checks returned metadata
identity and flags, then checks input/cache bytes and state outside timing.

Two 12-pair, 20-pass cohorts covered all 19 real waves and all 4,325 descriptors,
with no skipped wave. Median paired method-time improvements were 13.89% and
13.81% with the initial order reversed; the candidate won 10/12 pairs in each.
Median paired process-CPU improvements were 12.90% and 13.64%. An independently
loaded identical-code control showed a 1.28% apparent wall improvement and 0.64%
CPU improvement, with 6/12 wins.

The absolute effect is small: the medians for one complete set of waves were
3.488 → 3.055 ms and 3.606 → 3.112 ms. These are repeated hot-cache method calls,
not cold import phases. An earlier 100-pass run ended without a final report or
captured exit status; it is excluded. The cause is unknown. The 20-pass cohorts
completed with exit 0, complete state checks, and explicit coverage.

## Candidate: resolved record fields

`TermRecordOpfsStore._encodeArtifactRecordFields` selects the common resolved
reference shape once per synchronous call and loads each unique content index
once for both its offset and length. It retains the fixed-length precedence and
generic, legacy, and floating-score paths. It does not cache the shape across
calls or change the storage format.

The record benchmark checks every emitted byte on all 526,942 JMdict rows,
667,942 JMnedict rows, and 435,448 Jitendex rows. Its input model uses the production
parser, two-bank groups, actual prepared-run limits, and synthetic monotonic
20-byte reference slots. It measures record-field packing alone, excluding
global deduplication, storage, and worker scheduling.

Natural-GC cohorts were noisy. Identical-code controls produced substantial
apparent changes, so they are retained as evidence of uncertainty rather than
used to claim an import improvement. A separate, explicitly labeled diagnostic
performs major GC before each measured arm, outside wall and CPU timers. It uses
one full fixture pass per arm and retains the ordinary allocation work inside
the method.

| JMdict cohort                                                              | Median paired packing improvement | Faster pairs |
| -------------------------------------------------------------------------- | --------------------------------: | -----------: |
| Initial screen, 8 pairs × 5 passes                                         |                             6.82% |          8/8 |
| Reversed order, 12 pairs × 10 passes                                       |                             4.56% |         7/12 |
| Natural GC, 30 pairs × 1 pass                                              |                             3.76% |        21/30 |
| GC before arm, 30 pairs × 1 pass                                           |                             4.34% |        23/30 |
| GC before arm, source labels reversed, normalized per pair to product gain |                             4.01% |        26/30 |

The independently loaded identical-code GC control showed an apparent **2.17%
slowdown**, so small differences still need caution. The two GC product cohorts
showed 3.77% and 4.96% less process CPU for JMdict packing. JMnedict's corresponding
wall improvements were 6.81% and 5.16%. Jitendex CPU differences were effectively
flat. This supports a modest isolated packing improvement, not a whole-import
percentage.

## Candidate: omit the final source-cache copy

The source importer now sets an optional `isFinalTermChunk` flag only when the
current source range reaches the final active term file and ordered parser
progress has equal, positive, safe-integer chunk index/count values. Estimated
row totals do not establish finality. The database uses this flag only to skip
publication into the owned recent-source cache after canonical content metadata
has been published.

Earlier cache entries remain available. Canonical metadata, persisted content,
record/index output, source draining, and borrowed-buffer release follow their
existing paths. A later unexpected duplicate can still be compared exactly by
reading persisted content. Artifact and object-row fallback paths remain
conservative when the source proof is unavailable.

Focused coverage includes ordinary and final publication, intermediate parser
callbacks, invalid progress ordinals, source-bank exhaustion, earlier-cache
retention, a later exact persisted duplicate and unequal content, and borrowed
source release. Full-fixture copied-byte counts and reopened-row proof are
recorded in the qualification section below.

## Rejected: adjacent native key reuse

The native experiment reused the preceding expression or reading index when the
complete raw JSON token matched, while retaining the existing empty/equal-reading
special cases. It passed focused parser tests and exact pre/post output parity
across all three archives, but it did not produce a reliable benefit.

| Fixture  | Median paired elapsed change | Candidate faster |
| -------- | ---------------------------: | ---------------: |
| JMdict   |                       +0.77% |             5/12 |
| JMnedict |                       +7.93% |             3/12 |
| Jitendex |                       +2.43% |             6/12 |

Positive changes mean slower. The native product change is excluded. Its source,
generated artifact identity, focused tests, and screening evidence are retained
for reproducibility.

A plausible source-level explanation is that the existing interner already
avoids UTF-8 copying for repeated literals. The added path imposes metadata
loads, branching, and a token comparison before misses take the existing path.
This is an inference from the implementation, not a measured causal profile.

## Rejected: changing the recent-source eviction policy

A baseline semantics-v3 diagnostic trace, before final-chunk copy suppression,
records each publication and lookup in the actual ordered JMdict workload. The
copy and retention figures in this section describe its 20 publications. FIFO replay at the observed 96 MiB budget exactly reproduces
all live hits and resident-byte transitions. Each batch fits every tested budget,
so the smaller-budget replay does not depend on hypothetical admission behavior.

| Budget                  | FIFO hits | LRU hits | Extra hits |
| ----------------------- | --------: | -------: | ---------: |
| 24 MiB, diagnostic only |     2,027 |    2,112 |         85 |
| 48 MiB                  |     3,527 |    3,571 |         44 |
| 96 MiB                  |     4,325 |    4,325 |          0 |

The resident-lookup, valid-hit, and exact-match LRU simulations agree on this
trace; they are not equivalent policies in general. At 48 MiB, LRU avoids only
44 of 798 predicted misses and requires 3,571 cache promotions. At 96 MiB it adds work without improving hits. A cache miss is not
necessarily a physical read or decompression, because the block cache may satisfy
it. These counts cannot be converted directly into latency. The production
eviction policy remains unchanged.

The trace also rules out two tempting shortcuts:

- Packing gaps out of retained spans can remove only 916,307 bytes, 0.91% of the
  100,795,188 bytes copied.
- Retaining only content repeated within its source group would keep about
  29.92 MB of payload but cover only 26.0% of future distinct requested content records.

Only 849,678 distinct bytes are requested later from the copied batches. That is
an offline oracle observation; future reuse is unknown when publishing a batch,
so it does not provide a safe predictive admission rule.

## Compression settings

The compression preload retains the exact decoded blocks encountered during
exhaustive reopened-row verification. It compares all 106 production blocks,
containing 99,878,881 uncompressed bytes. At the current level `-1`, recompression
must reproduce every stored envelope and frame exactly. Every tested level must
decompress to the exact original bytes.

Each variant owns a compression context. Timings include the packaged wrapper's
input/output copies and integrity envelope, but exclude packing, storage,
verification, and UI work. Positions rotate and reverse across 12 rounds;
duplicate level `-1` contexts provide a same-code control. No compression default
has changed. Compressed-byte totals include the frames and their 106 integrity
envelopes; they exclude content-reference slots, records, and indexes. The size
percentages therefore do not describe total dictionary storage.

| Level                 | Compressed block bytes | Size change from -1 | Median round wall improvement | Median round CPU improvement |
| --------------------- | ---------------------: | ------------------: | ----------------------------: | ---------------------------: |
| -1, baseline          |             12,269,900 |                   — |                             — |                            — |
| -1, duplicate control |             12,269,900 |                  0% |                         1.37% |                        2.30% |
| -2                    |             12,580,195 |              +2.53% |                         0.80% |                       -0.68% |
| -3                    |             13,040,235 |              +6.28% |                         0.28% |                       -6.15% |
| -5                    |             13,908,123 |             +13.35% |                         6.85% |                        6.85% |
| +1                    |             10,740,429 |             -12.47% |                        -4.02% |                       -4.88% |

The faster negative settings do not offer a compelling measured import tradeoff.
Level `+1` merits a later browser experiment: it saves approximately 1.53 MB of
compressed blocks, while its CPU effect changed sign between cohorts. Reduced
writes may matter on slower storage. This component experiment cannot determine the net
browser effect or lookup latency.

A fresh reversed cohort reproduced every size and round-trip result, but timing
differences varied. Its duplicate control showed -0.26% wall improvement; levels
`-2`, `-3`, `-5`, and `+1` showed -7.21%, 9.54%, 14.54%, and 0.04%, respectively.
Level `+1` process CPU was 2.97% lower in that cohort versus 4.88% higher in the
first. The reliable result is the size tradeoff; the measurements do not justify
changing the import compression default.

Prepared Zstd dictionaries are another separate follow-up. The current module
exports `compress_usingDict` but not the CDict creation/free/compression APIs.
Testing reuse requires a pinned native rebuild and lifecycle handling per worker.
The old and new APIs should be compared within the same rebuilt module to avoid
confounding an API change with code layout or toolchain changes.
The [Zstd 1.5.7 API manual](https://meta.github.io/zstd/doc/api_manual_latest.html)
documents the prepared-dictionary APIs and their ownership requirements.

## Next experiments with a clear decision to make

1. **Browser qualification of the integrated changes.** Use the repository's
   normal import lane with the same pinned archives, cold/warm separation, both
   arm orders, a same-code control, and actual visible-ready completion. Include
   an eviction-heavy 48 MiB source-cache policy. Node component timings cannot
   replace this gate.
2. **Prepared Zstd dictionary reuse.** Build both APIs into the same pinned
   Emscripten module, preserve per-worker ownership and failure cleanup, and
   compare the old API against itself before comparing a reused CDict. Require
   complete decompression parity, stored-size and WASM-size checks, and an import
   memory measurement. The required pinned Emscripten toolchain was unavailable
   during this session, so there is no performance result for this idea.
3. **Level `+1` as an I/O tradeoff.** Compare complete import and subsequent lookup
   latency on slower browser storage before considering a setting change. Its
   measured block-size saving is reliable; its complete-import effect is unknown.

## Correctness and harness corrections

The reopened-row proof compares every persisted row with source JSON, including
expression, normalized reading, tags, rules, score, complete glossary structure,
sequence, term tags, and dictionary identity. New stores prevent reuse of
import-era caches. The full JMdict semantic SHA-256 is:

```text
8926122e434123d9823d867845ed8480734e0ada8381204e1857f88b216d8974
```

Three measurement details were corrected before interpreting combined results:

1. The importer estimates total dictionary rows from the first group's row/byte
   ratio. Passing only each group's row count selected different preallocation
   and record materialization paths. The initial profiled run is retained only
   as diagnostic and semantic-parity evidence.
2. Record descriptors and indexes contain random 16-byte generation IDs. The
   runner validates format/framing and matching descriptor/sidecar IDs, retains
   raw hashes, then masks only those audited fields for binary comparison.
   Every other persisted byte must match.
3. The runner mirrors worker lookup preparation on parser fallback, checks source
   and adapter identities before and after execution, and reports instrumented
   diagnostics separately from ordinary component timings.

## Reproduction

Run these commands serially from the integrated checkout, using **Node 22.22.0**
on `PATH`. The integrated code checkpoint is
`bf895be65695b7dabb93ed87a7564cc4634368c5`. The current component runner reports
`harnessSemanticsVersion: 4`, including explicit source/chunk finality and the
importer source identity. Use fresh output paths; the runners reject existing
reports.

### Setup and pinned fixtures

```sh
node -e 'if (process.version !== "v22.22.0") throw new Error("Use Node 22.22.0")'
jmdict_root="$PWD"
jmdict_baseline="$jmdict_root/../manabitan-repro-baseline"
jmdict_cached="$jmdict_root/../manabitan-repro-cached"
jmdict_cache="$jmdict_root/builds/e2e-dictionary-cache"
jmdict_out="$jmdict_root/results/reproduce-jmdict-20261119"
git worktree add --detach "$jmdict_baseline" d829f5b6e6a75ee8859d38d537d224ec33c4930e
git worktree add --detach "$jmdict_cached" f853fb4d4298ca24b5e0b2d1cc4b0f739316157b
for jmdict_checkout in "$jmdict_root" "$jmdict_baseline" "$jmdict_cached"; do
  (cd "$jmdict_checkout" && npm ci && npm run build:libs)
done
mkdir -p "$jmdict_out"
node --input-type=module <<'JS'
import {ensurePinnedDictionaryCache} from './dev/perf/dictionary-fixtures.js'
await ensurePinnedDictionaryCache('builds/e2e-dictionary-cache')
JS
jmdict_fixture="$jmdict_cache/JMdict.zip"
```

The helper verifies the archive sizes and SHA-256 values in
`test/perf/dictionaries.lock.json`, downloading missing or invalid files. It
prepares all three pinned fixtures; existing valid archives need no network.

### Paired component proof

```sh
node dev/perf/jmdict-component-benchmark.js \
  --baseline "$jmdict_baseline" --candidate "$jmdict_root" \
  --fixture "$jmdict_fixture" --dictionary jmdict --pairs 3 \
  --device-memory 8 --hardware-concurrency 8 \
  --output "$jmdict_out/component-paired.json"
```

This alternates arm order in fresh subprocesses and keeps exhaustive reopened-row
verification enabled. It checks semantic parity and canonical persisted-file
parity. For the other fixtures, change both `--dictionary` and `--fixture` to
`jmnedict` / `JMnedict.zip` or `jitendex` / `jitendex-yomitan.zip`, with new outputs.
These remain component proofs, not browser-import measurements.

### Record-field GC diagnostic

```sh
node --expose-gc dev/perf/term-record-fields-benchmark.js \
  --baseline "$jmdict_baseline" --candidate "$jmdict_root" \
  --cache "$jmdict_cache" --dictionary all \
  --pairs 30 --iterations 1 --warmup 10 --initial-order BA \
  --gc-before-arm --output "$jmdict_out/record-fields-gc-ba.json"
```

The forced collection is outside the wall, CPU, and page-fault counters. This is
an isolated warmed-method regime. For the source-label-reversed cohort, swap the
source paths, use `--initial-order AB`, and normalize each pair to the old-code
denominator when calculating product improvement. For a same-code control, use
a second, separately loaded baseline checkout with the same install/build steps;
passing the same checkout twice would share module instances.

### Cached exact-match diagnostic

Use the separate **`f853fb4` checkout**, not the integrated candidate: this
preload requires production dependencies and database code outside the one
target method to be identical.

```sh
MANABITAN_CACHED_CONTENT_CANDIDATE="$jmdict_cached" \
MANABITAN_CACHED_CONTENT_OUTPUT="$jmdict_out/cached-ab.json" \
MANABITAN_CACHED_CONTENT_PAIRS=12 \
MANABITAN_CACHED_CONTENT_PASSES=20 \
MANABITAN_CACHED_CONTENT_WARMUPS=1 \
MANABITAN_CACHED_CONTENT_INITIAL_ORDER=AB \
MANABITAN_CACHED_CONTENT_EXPECTED_DESCRIPTORS=4325 \
node --max-old-space-size=1400 \
  --import ./dev/perf/cached-content-comparison-preload.js \
  dev/perf/jmdict-component-benchmark.js \
  --source "$jmdict_baseline" --fixture "$jmdict_fixture" \
  --no-verify --output "$jmdict_out/cached-ab-component.json"
```

Repeat with `INITIAL_ORDER=BA` and two new output paths. For its same-code
control, set `CANDIDATE` to a distinct baseline checkout. The explicit 20 passes
and 4,325-descriptor assertion reproduce the completed cohort settings. This
instrumented run omits reopened-row verification; the separate paired proof
above supplies that correctness check.

### Compression diagnostic

```sh
MANABITAN_COMPRESSION_LEVEL_OUTPUT="$jmdict_out/compression-forward.json" \
MANABITAN_COMPRESSION_LEVEL_ROUNDS=12 \
MANABITAN_COMPRESSION_LEVEL_INITIAL_ORDER=forward \
node --max-old-space-size=1400 \
  --import ./dev/perf/jmdict-compression-level-preload.js \
  dev/perf/jmdict-component-benchmark.js \
  --source "$jmdict_baseline" --fixture "$jmdict_fixture" \
  --output "$jmdict_out/compression-forward-component.json"
```

Keep full verification enabled: it captures the exact production blocks and
checks stored baseline frames and decoded bytes. Repeat with
`INITIAL_ORDER=reverse` and new component/diagnostic output paths. The script
includes both `-1` controls and the `-2`, `-3`, `-5`, and `+1` variants; it does not
change the product default.

### Historical evidence and exact sources

The commands above use the current runner. To replay a historical cohort, select
the runner by the SHA-256 recorded in that raw report, and use its recorded
source identities and configuration. Restore snapshots to their original
`dev/perf/` filenames in a separate runner checkout so relative imports still
resolve. A newer linted runner must not be presented as the exact measured
source.

| Historical source                                                           | Measured SHA-256                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Component runner v3, used by completed cached-match and compression cohorts | `a38a46987c6b16f612afa2eeb69282444a0303997e2f7bdf3b82c23835b692ef` |
| Record-field runner, forced-GC cohorts                                      | `f8df0f6f873aecba9d9ff1da4451a7775429913b0621e51845572f36b0dc90b0` |
| Cached-match preload, completed 20-pass cohorts                             | `a5fae356ab5916a1f1378ddd8d5de584d5a4dcad56f0460e545cc4eb41ed546a` |
| Compression preload, forward/reversed cohorts                               | `f1799b69ac4b9f0a26b2dc48967918046138f76c756d951828df93e5faebfa71` |

The expected evidence archive is
`results/jmdict-20261119-evidence.zip`, containing raw reports, exact measured
source snapshots, the rejected native patch, `source-history.bundle`, and
checksums. Its final availability and verification receipt are recorded below.

## Qualification results

The final source/history tip is `d52bf929dbe8c70e39c244a9dfa27e86b8e65868`.
The integrated product was qualified at `bf895be`; subsequent changes were
ternary/test layout and a benchmark default of 20 repeats, matching the completed
measurement cohorts. The source-history bundle preserves these commits and the
original independently measured candidates.

### Complete regression coverage

- **13,693 unit assertions passed, 47 skipped, across all 616 expected files.**
  Four sequential shards were checked against Vitest's complete file inventory;
  there are no missing or overlapping shard files. An initial native CRC setup
  failure was resolved by adding the pinned Clang/LLD directories to `PATH` and
  rerunning that entire test file successfully. No failing assertion was omitted.
- **All four TypeScript projects passed.** The `main` and `dev` stages completed
  in the normal `&&` command chain. The test project initially exposed a missing
  `undefined` alternative in a metadata declaration, which was corrected. After
  a resource-limited combined run, `test` and `bench` completed separately with a
  1,400 MiB heap. Original failed attempts and successful receipts are retained.
- **ESLint passed** for all changed production, test, and benchmark JavaScript
  using the real repository rules and each file group's matching TypeScript
  project. Final formatting corrections do not change production behavior.
- **`npm run test:build` and the Chrome release build passed.**

### Integrated pinned-corpus proof

These fresh-process runs qualify correctness; their individual timers are not
replicated performance evidence. Persisted-byte comparisons mask only the
validated matching generation-ID fields documented above.

| Fixture  | Imported rows | Completed proof                                                 | Stored bytes in both arms |
| -------- | ------------: | --------------------------------------------------------------- | ------------------------: |
| JMdict   |       526,942 | Every reopened row against source JSON, plus all artifact bytes |                43,176,337 |
| JMnedict |       667,942 | Every reopened row against source JSON, plus all artifact bytes |                45,726,619 |
| Jitendex |       435,448 | All artifact bytes                                              |                61,741,548 |

Jitendex's independent source-JSON oracle stopped on pristine baseline at an
image: decoding converts source `width`/`height` into preferred dimensions while
actual dimensions remain zero without the omitted media-resolution stage. The
strict oracle was not weakened or reported as passing. A separate complete
`--no-verify` comparison proves baseline/candidate persisted-byte parity instead.
Record-field packing also independently has complete byte parity on all three
archives. Browser media handling remains outside this component runner.

### Final-copy and eviction coverage

With the 8 GiB hint and 20 source groups, JMdict cache copying decreased from
**100,795,188 to 95,334,332 bytes**, exactly **5,460,856 fewer copied bytes**.
Every earlier group's copied-byte count is unchanged, only the final group is
marked final, and all **4,325 recent-source hits** are preserved.

The real 4 GiB policy uses eight groups and a 48 MiB recent-source cache. Both
arms passed all 526,942 reopened rows and normalized artifact parity, retained
**2,871 recent-source hits**, and issued exactly **836 positive-length requests
in four persisted-content reader batches**. The audited preload counts only
active import calls and does not replace the detailed instance reader. These are
reader requests, not physical I/O or decompression counts. Copying decreased from
**100,661,232 to 87,388,702 bytes**, saving **13,272,530 copied bytes** in that
profile.

These are copy-volume reductions, not demonstrated peak-memory or complete-import
latency reductions. The cached-match method can still make an extra cache probe
on a miss; the eviction qualification proves correctness and unchanged reader
work, not a browser CPU non-regression guarantee.

### Package and remaining browser gate

The Chrome ZIP is **17,210,957 bytes**, versus **17,210,004 bytes** at baseline:
a **953-byte increase**. Exactly the three intended dictionary JavaScript files
changed. No packaged file was added or removed; all five WASM entries are
byte-identical. The measured stored artifacts have no size increase.

Chromium could not start under the executor's local-socket restriction, and
automatic approval review rejected the unrestricted launch. Browser workers,
real OPFS, SQLite, media resolution, visible-ready timing, and mobile peak memory
therefore remain unqualified. This work belongs in a draft PR until ordinary
browser qualification establishes the complete-import effect.

The [evidence archive](results/jmdict-20261119-evidence.zip) contains unchanged
reports, controls, qualification summaries and logs, exact measured script
snapshots, the rejected native patch, a source-history bundle, pinned fixture
identities, and a SHA-256 manifest for every payload. `qualification-summary.json`
is the consolidated receipt; `unit-qualified-summary.json` records the complete
file inventory and the resolved native setup failure.

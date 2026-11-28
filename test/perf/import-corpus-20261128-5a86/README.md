# Complete import corpus proof

This study compares the unchanged production parser with two isolated native
experiments over every term row in the three pinned dictionaries. It is a
correctness replay. It produces no browser latency, persistence, media-payload,
parallel scheduling, or process peak-memory result.

## Frozen source

| Arm                     | Commit                                     | Parser WASM SHA-256                                                |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| Baseline                | `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` | `8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee` |
| Composite string window | `2cdcc90241fa19221b7fc4e5d793eb70896c3258` | `6b327b4b5c85a973b1e2344276bb5476b6d036b197d87ab03b2a930ed50059eb` |
| Format-3 suffix reuse   | `38031a752b26c9b630e5f2f1d45e780786656c74` | `a9e15a67b2f72adf2288f4c981c0fb78362273953d94440706c41cf44515292f` |

The plan also fixes each tree and C source hash. Each arm loads its checked-in
module through the current native-artifact validator, checks the runtime copy
against that manifest, and verifies the source identity again after the last
group. JavaScript, dependency, fixture, grouping, and production admission
policies remain equal across arms. Separate browser studies own the pinned
compiler rebuild, complete-import timing, storage, exhaustive media, and sampled
process-memory gates.

## Complete coverage

| Dictionary | Rows per arm | Banks | Groups |  Source bytes |
| ---------- | -----------: | ----: | -----: | ------------: |
| JMdict     |      528,299 |    53 |     12 |   171,617,523 |
| Jitendex   |      436,555 |   219 |     22 |   538,927,310 |
| VNDB       |    6,648,310 |   665 |    170 | 4,267,992,967 |

Every arm processes 7,613,164 rows in 204 groups. Each dictionary has a fresh
Node 22.22.0 process. The existing 24 MiB byte balancer and the observed
three-worker grouping policy select boundaries; groups and arms execute
serially. This does not change the importer's worker count or source budget.
Only one compressed group and its bounded parser outputs are live at a time.
The full ZIP is read through a file-backed Blob and its SHA-256 and size must
match the unchanged fixture lock.

The original probe derives media scanning from actual archive image filenames,
native image projection from the existing 1 GiB source gate, and lookup routes
from the existing 128 MiB source gate. The existing projected-source worker
policy enables native escaped keys for VNDB; the replay reproduces that internal
choice. Ordinary user experiment flags and thresholds are not tuned.

## Output and work checks

Before either candidate runs, Node zlib independently inflates and CRC-checks
every compressed bank payload. All three native inflators then process the same
complete payloads with independent logical bank boundaries. Deferred CRC must
finish before the output callback runs.

The per-group digest covers every row's canonical content and its metadata,
semantic key plans, score and sequence byte columns, reading-equality flags,
every prepared lookup-index byte, route filters, dedup references and signatures,
and owned media-row output. Native lookup admission, scratch reuse, parser
fallbacks, allocation sizes, and media/normalization work counters are checked
separately. JavaScript lookup completion cannot conceal lost native admission.

The mask arm must preserve every recorded output and work counter. For the
suffix arm, the plan prospectively permits only four work counters to differ:
validated glossary reuse, scanned CRC bytes, reused CRC bytes, and reused CRC
glossaries. Validated/reused counters may only increase; scanned CRC bytes may
only decrease. For each deferred group, scanned plus reused bytes must equal
the complete source group. All other digests, counters, and admission checks
remain exact. These rules are fixed before any acquisition and are independently
implemented by the Python auditor.

The full output oracle preserves observable media and normalization effects;
it does not expose every internal parser metadata hint bit directly. Focused
actual-WASM tests remain necessary for those bits, malformed sources, truncation,
and escape boundaries. As in the original probe, JSON serialization of media-row
diagnostics normalizes negative zero; numeric column byte hashing and separate
negative-zero tests provide additional coverage.

## Provenance and failure policy

The upstream checked-in probe is preserved byte-for-byte as
`upstream-replay.mjs.txt`, from
[`61e3e059c95b208e2167141e70488add99e3b1a7`](https://github.com/ManabiIO/manabitan/tree/61e3e059c95b208e2167141e70488add99e3b1a7/test/perf/native-metadata-20261126-21d3).
Its SHA-256 is
`a16c19e1030c4f9e7681c063507017f3413f4b770299e7505b77ef4894666a7f`.
That upstream study retains the earlier measured probe with SHA-256
`37c3e11594960afc7c35317f9a143a0db18c25696450610c0842e7877a992395` and its
recorded AST-equivalence proof. This study binds the checked-in probe, the exact
adaptation patch, the executed replay, the plan, driver, auditor, and workflow
in `provenance.json.txt`.

The output path must not exist. Each group and each completed arm are saved
before comparison. A mismatch or process failure leaves a partial report and
raw logs; it is not retried, resumed, replaced, or counted as passing. The
workflow runs the independent auditor even after acquisition fails and retains
all available evidence. The auditor requires complete coverage and every
prescribed arm. Its small guard checks reject output drift, CRC gaps, decreased
reuse, changed mask work, native fallback, and media drift.

To audit a retained complete report with the exact study code:

```sh
python test/perf/import-corpus-20261128-5a86/verify.py /path/to/report.json
```

The hosted workflow prepares and builds the three frozen worktrees before
calling `replay.mjs`; it records the complete command and all identities in
`invocation.json`. `driver.py check` verifies that the study branch changes only
its declared correctness tooling. No product code is changed by this branch.

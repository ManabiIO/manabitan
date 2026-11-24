# Import optimization follow-up, 24 November 2026

This follow-up evaluates complete JMdict, Jitendex, and VNDB imports against a
frozen current baseline. It retains negative results and setup failures alongside
the successful checks. Diagnostic profiles identify work to investigate; their
elapsed times are not performance comparisons.

## Sources

The initial diagnostic baseline is
`698d685c21618a8e8dbdab7a49a8dcf0d30680eb`. It includes the catalog and media
changes from the previous round, integrated through PR #867, along with the
subsequent import-pipeline optimizations already merged at that point.

Before any new timed import completed, PR #824 merged immutable parser-slab
retention. Develop-based comparisons therefore use
`bbccabd520972cc351a65d9f545bd5369b6e9747` as the baseline. The separate VNDB
direct comparison uses the frozen PR #875 head documented below. The source
archives, package lock, and seven benchmark/harness files remain fixed within
every comparison.

## Completed earlier VNDB comparisons

The two formerly pending VNDB cohorts have completed and passed independent
audit. Both retain all 23 observations: three warmups, six balanced three-arm
blocks, and two exhaustive media diagnostics. A and C are identical baseline
builds; B is the candidate.

| Earlier candidate                            | B/A paired median | B/C paired median | Unchanged C/A control |
| -------------------------------------------- | ----------------: | ----------------: | --------------------: |
| UTF-8 continuation loop, PR #858             |           +0.539% |           +0.159% |               +0.826% |
| Guarded adjacent media reads, former PR #853 |           -0.624% |           -0.649% |               -0.590% |

Neither result establishes a complete-import speed improvement. The media
change has a separate verified logical-read reduction; that reduction must not
be presented as an equivalent latency reduction. Absolute times across these
two separately hosted studies are not comparable.

All exhaustive checks match the same 146,570 referenced VNDB images and
188,131,284 image bytes. See [the recovered audit and retained bundles](previous-vndb/README.md).
The original evidence commit remains unchanged.

## Experiments and decisions

### Move lookup-sidecar checksums into the existing writer worker

The current parser produces owned lookup sidecars which the importer then
checksums before sending to an existing ordered writer. The candidate keeps the
same private snapshot and moves the three required checksums into that writer's
ordered operation. It preserves the file format, ownership boundaries, write
order, queue budget, flush policy, worker count, and close/abort behavior.

The existing large-import eligibility rule controls this path; small imports
keep their local writer behavior. JMdict and Jitendex are therefore controls as
well as correctness coverage.

- Published candidate: `3439c2b17cb4d5245a2cee1177dec33fad2a7829`.
- Tested local revision: `e0a0e73cc44e82a03474885d3bf4aee6765b317d`.
- Exact shared tree: `adf9df739aab4f1d641d77cb9eee3331e37d9100`.
- Frozen study: `d6bcc194dbcbe97c1a7844f185db6faf0313bbfe`.
- [Hosted comparison](https://github.com/ManabiIO/manabitan/actions/runs/45462293621).

The completed comparison passes all 69 observations, including every semantic,
restart, and exhaustive-media check. The independent audit recomputes every
comparison from the raw observations.

| Dictionary | B/A paired median | B/C paired median | Unchanged C/A control |
| ---------- | ----------------: | ----------------: | --------------------: |
| JMdict     |           +0.138% |           -0.364% |               -0.280% |
| Jitendex   |           -1.905% |           +1.884% |               -1.801% |
| VNDB       |           -0.120% |           -0.055% |               -0.381% |

**Rejected for a performance PR.** VNDB favors the candidate in only three of
six pairs against each unchanged baseline. Jitendex's first candidate block is
28.7% slower than A and 40.0% slower than C; those observations remain included.
Its aggregate equal-work changes are +2.77% and +6.43%. No complete-import
improvement is established, despite the reduction in importer-thread work.

The [full independent audit](sidecar-screen/audit.json), indexed raw-report
bundles, and [validation attempts](sidecar-validation/README.md) are retained.
The original full local unit invocation had resource/setup failures. Targeted
retries with the pinned compiler and isolated Android helper suite resolved
those failures; that does not retroactively make the first invocation a pass.

### Project image paths without constructing whole glossary objects

The diagnostic VNDB profile identifies whole-glossary decoding and JSON object
construction in the parser worker's result-copy callback. The native candidate
projects only the quoted image-path tokens in one bounded batch, while retaining
the existing JavaScript collector as a whole-glossary fallback. It borrows
retired lookup scratch after the lookup bytes have been copied into owned
buffers; it does not add a retained arena.

The complete source-corpus oracle compares ordered path lists, copied chunks,
and the source/content/key/lookup buffers. It covers 7,613,164 rows, all 146,570
unique VNDB images, and all 236 referenced Jitendex images. Source qualification
and complete browser timing are separate gates.

- Published candidate: `1737c500a0e5cbf0109f1a30b031b1e43cfa0dae`.
- Tested local revision: `09a63d6ffad74d991269b20fc2a802b5a1c78706`.
- Exact shared tree: `5669adc07da2a15477615b4a7865b0c32354b340`.
- Frozen study: `6a04bbff4c5332d6c86f678455f36545a511abb5`.
- [Hosted comparison](https://github.com/ManabiIO/manabitan/actions/runs/45466141231).

The published follow-up `4432e81ed21ba9dba57c85f665712f494af0f28a` contains
only a test compiler include path and evidence formatting fixes. Its complete
`ext` and `dev/data/dictionary-wasm` trees are byte-identical to the timed
revision. The [validation receipt and all attempts](native-validation/receipt.json)
record the original failed invocations and successful targeted retries. Combined
coverage is 645 unit files, 14,528 passing tests, and 47 intentional skips; this
is explicitly not a clean initial full-suite invocation. All four TypeScript
projects, scoped lint, pinned native reproduction, and seven dry-build targets
pass.

Concurrent PRs #871 and #875 target the same work and are alternatives, not
independent changes to stack. The new study therefore also compares the batch
candidate directly against the single-image implementation in #875,
`fb71a03f4611bcfa71e135693bebd1fe778153bf`, using the same three-arm protocol on
VNDB. A and C are identical #875 builds in that cohort.

All 92 observations pass the independent audit. The completed comparisons are:

| Comparison                    | B/A paired median | B/C paired median | Unchanged C/A control |
| ----------------------------- | ----------------: | ----------------: | --------------------: |
| JMdict against develop        |           +0.111% |           -0.517% |               +1.246% |
| Jitendex against develop      |           +1.137% |           +0.576% |               -0.176% |
| VNDB against develop          |           -4.144% |           -2.032% |               +0.442% |
| VNDB against existing PR #875 |           +3.017% |           +3.206% |               -0.725% |

**Withhold a competing batch PR.** Although the batch version improves VNDB
against develop, the existing single-image implementation wins the direct
comparison. Batching is faster in only one of six pairs against either #875
control. Equal-work changes are +2.096% and +2.498%, also favoring #875. Every
VNDB image and the 609,553,611-byte OPFS total match. These separate hosted
cohorts must not be combined to calculate another speedup.

The [complete native comparison](native-screen/README.md) retains all four
cohorts and every observation. Aggregate result-copy intervals improve even in
the adverse direct comparison, illustrating why those overlapping intervals
cannot decide a complete-import performance change.

This relative comparison does not qualify PR #875 for release. Its separately
reported memory qualification is on hold, and its source remains a draft. The
comparison evidence should be read alongside that PR's current qualification
status, not as a replacement for its baseline or memory gates.

### Batch shared-span compression messages

The separate IPC candidate groups an existing admitted batch by its existing
worker assignment. Logical block promises, source-consumption barriers,
failure draining, output order, compressed bytes and private-source dispatch
remain unchanged. The exact runtime diff is two JavaScript files.

- Published candidate: `7d4e4979f9ad0f3ed1d0e61840e6e06212ad63d8`.
- Tested local revision: `97a1cb41705c30462c516ffe46b05b0522e5c669`.
- Exact shared tree: `29ef86aa6a72b3c14c9429a725a811254a2db46e`.
- Frozen study: `ce10e1782c6aa119d6bb19e5cf109d1fdfe8169d`.
- [Hosted comparison](https://github.com/ManabiIO/manabitan/actions/runs/45470393272).

The [validation receipt](ipc-validation/receipt.json) records a clean full unit
invocation: 645/645 suites, 14,506 passing tests and 47 skips. All four TypeScript
projects, targeted lint and seven dry-build targets also pass. Independent
reviews cover ownership, timeout accounting, acknowledgements and partial
failure draining. These correctness checks do not establish a performance gain.

All 69 browser observations pass the independent audit on the original hosted
attempts. No dictionary establishes a complete-import improvement:

| Dictionary | B/A paired median | B/C paired median | Equal-work B/A | Equal-work B/C |
| ---------- | ----------------: | ----------------: | -------------: | -------------: |
| JMdict     |           +1.498% |           +1.219% |        +0.403% |        +0.836% |
| Jitendex   |           +0.706% |           -0.700% |        +1.425% |        +0.535% |
| VNDB       |           +0.236% |           +0.404% |        +1.278% |        +1.371% |

**Rejected for a performance PR.** Mixed paired signs, unchanged-control
variation and positive equal-work changes provide no support for an improvement
claim. All tails remain, including VNDB's block-4 candidate at +7.041% against A
and +7.582% against C. The unchanged output checks, exhaustive media readback
and storage totals pass. The [complete IPC comparison](ipc-screen/README.md)
contains every observation, independent audit and original completion receipt.

### Compression levels and closed architecture leads

A separate fixed component study uses all 488 production-matching content
blocks from JMdict and Jitendex. Both titles use the same trained dictionary at
level -1. The study retains 64 measured observations and 128 excluded warmup
passes, with duplicate unchanged controls and exact per-block decompression,
envelope and repeated-output checks.

**Keep level -1.** Level -2 increases content-file size by 1.597% for JMdict and
1.954% for Jitendex without a dependable component gain. Level -3 saves about
8 ms of JMdict component work at the observed arm medians, increases its
content-file size by 3.958%, and increases Jitendex size by 7.486% while its
timing is inconsistent/adverse. No default change or browser-speed claim follows.
The [complete component proof](compression-level-study/README.md) contains every
observation and a byte manifest/regenerator for reproducible derived inputs.

Two additional source checks close other apparent opportunities:

- [Fused glossary scan/encode](native-fusion-architecture-review.md): ordinary
  encoding copies already-validated raw glossary bytes; there is no second
  grammar traversal. The text-normalization branch has zero activation in both
  locked corpora. Copy/hash fusion is already covered by PR #840 and its adverse
  or inconclusive browser evidence.
- [Earlier index-worker eligibility](index-worker-eligibility-audit.json): the
  1 GiB cutoff was added after a broad-worker comparison regressed JMdict by
  6.31%/7.17% against its controls and failed to establish a Jitendex gain.
  Current close costs vary substantially by host and do not reverse that result.

## Browser protocol

`dev/perf/import-screen-20261124.py` builds three independent release packages
before timing. A and C must have identical packaged file bytes. Every observation
checks its frozen source, package, harness, fixture, Node, and browser identity.

The six fixed orders are `ABC`, `CBA`, `BCA`, `ACB`, `CAB`, and `BAC`, following
one warmup for each arm. All 18 timed observations use fresh persistent profiles,
the normal release `chrome` build, Node 22.22.0, and Chromium 153.0.8010.12.
Tracing and profiling are disabled. The existing import timing boundary is
unchanged. Sampled full lookup responses and restart checks must match; separate
post-timing diagnostics read every referenced image for A and B.

The six-block comparisons are exploratory screens on individual runners. They
do not establish cross-device performance or peak memory use. All tails,
failures, raw reports, and storage-layout differences are retained. Importer,
parser-worker, and writer intervals overlap and must not be added together.

The three current studies retain 230 passing browser observations: 180 timed
imports, 30 excluded warmups and 20 excluded exhaustive-media diagnostics. This
count includes the native candidate's separate direct comparison with PR #875.
The recovered earlier VNDB studies and the compression-level component study
are reported separately and are not pooled into these browser results.

## Retained environment failures

The first local comparison stopped during its initial baseline warmup, before
any import. Chromium's persistent-profile singleton attempted a Unix socket
that the executor disallows (`socket() failed: Operation not permitted`). Its
logs, source/package identities, and failed summary are retained. The hosted
comparison is a new, explicitly identified cohort using the same production
browser flags; the failed local attempt contributes no timing observations.

The original diagnostic workflow also exposed a ShellCheck warning about an
intentional JavaScript template expression inside a shell single-quoted string.
The expression now uses ordinary string concatenation. The original successful
diagnostic observations were not rerun or replaced; the subsequent workflow
lint passed.

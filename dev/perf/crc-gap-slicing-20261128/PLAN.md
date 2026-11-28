# CRC gap slicing: frozen complete-import study

This study tests one native change: consume the suffix of `crc32_update_gap`
with at most one 8-byte slice and one 4-byte slice after its existing 16-byte
loop. The existing scalar loop then handles 0–3 remaining bytes. It uses the
current CRC tables and unaligned-safe 32-bit reader. Whole-buffer CRC, braided
CRC, source admission, glossary witnesses, parser scheduling, storage formats,
and JavaScript runtime behavior are unchanged.

No candidate timing has been acquired before this plan. The local work below
establishes exercised work and correctness only. This is an experiment branch;
publication of the branch does not imply a performance gain or a PR decision.

## Exact source boundary

Baseline A is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Control C uses the same
A source, package, flags, and runtime under a separate observation label.
Candidate B is the exact original push commit of
`perf/crc-gap-slicing-20261128`, with A as its sole parent. The workflow always
checks out that triggering commit; it does not follow a later branch head.

The native input and generated artifact are frozen as follows:

| Item                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| Baseline parser C         | `5a8257cb77d061694b6b2d247057aebb53ea2f49521d8d9893b3af175f145d8a` |
| Candidate parser C        | `eea3064cf869d880115dcd42055293784874c9d5092e962d4fea52284fe93a47` |
| Baseline parser WASM      | `8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee` |
| Candidate parser WASM     | `b362d9b0106c28e9cb495d66c650463c771e165cb8ebadc4a66adda973466fd9` |
| Candidate native manifest | `453d6b36b68f3c1b539ee2cb43fa476211d81a0315b90849b9b89edabc5347e8` |

The candidate parser module is 67,943 bytes, an increase of 284 bytes. A pinned
Clang/LLD 21.1.8 rebuild with a linker map preserves all 51 function names and
indices. Only function index 5, `crc32_update_gap`, changes: 538 to 822 body
bytes. Every other function body and every noncustom section except CODE are
byte-identical. Its baseline body SHA-256 is
`b1911c65c5b7c27c7fe8157a1d444177f0d6ead606937700011d742bbc8786ec`;
its candidate body SHA-256 is
`8d9de852419c77c5f948ce9fd2cd9c6586c0b14240909c323114a9f68bb86aa7`.
The guarded test export is absent from the production artifact. The canonical
scanner module is unchanged, and the native input count remains 14.

The exact packaged delta is two existing entries:

- `js/dictionary/wasm/term-bank-parser.c`
- `lib/term-bank-parser.wasm`

`verify-source.py` binds the five native/test changes and five study files,
rejects any additional source delta, verifies their checked-out bytes against
the commit, and checks the unchanged browser, memory, qualification, fixture,
and native build boundaries. No common observer or receipt validator is edited.

## Work census and correctness before timing

The counter-only census used all 665 pinned VNDB banks and all 6,648,310 rows.
It streamed exact compressed ZIP bytes, with full archive SHA-256 checks before
and after reading, through the production deferred-CRC preload path. The exact
current `partitionSourceBanks` and `getPartitionSourceByteLength` functions
produced all 170 current production groups. The effective large-media parser
flags were retained. No 4 GB raw corpus was materialized on disk.

The census recorded 6,648,975 gap calls, including one trailing gap per bank.
They contain 479,175,169 bytes, 26,847,114 existing 16-byte slices, and
49,621,345 serial tail updates. Bounded 8/4 slicing replaces 39,232,572 of those
serial dependencies, leaving 10,388,773. It executes 3,171,951 eight-byte slices
and 3,464,241 four-byte slices. Every byte still contributes to the CRC; the
79.0639% reduction refers to the serial tail dependency steps, not to verified
bytes, table contributions, or elapsed time. Additional branches and code size
can reduce or eliminate a performance benefit.

Independent reconstruction from actual row metadata and bank spans reproduced
every native counter. Original and counter-only modules matched full logical
outputs, verifier input hashes, witness arrays before and after verification,
CRC outcomes, and zero-fallback counts. The actual candidate then passed the
same complete production-input comparison against A, with the identical output
root digest
`0db8697f1394ceadf5e5698d63b913c54d1d0c85992a70b2c1ab83a750a2019d`.

The 30 focused CRC and source-reuse tests cover arbitrary initial CRC states,
every short length and alignment, update composition, larger lengths around
existing whole-CRC thresholds, exact physical-memory ends, mutations in every
16/8/4/scalar portion, and valid-JSON mutations outside glossary spans before
any rows are published. The local pinned native check and changed-test lint
also pass. The complete hosted correctness job remains a required separate
gate; these local checks do not substitute for it.

Local evidence is retained under `experiments/native-crc-gap-census` and
`experiments/crc-gap-slicing`, with independent census review under
`profiles/native-crc-gap-independent-review`. The first census harness failure
on intentionally omitted stable-plan columns, the first compiler-discovery
failure, sparse-worktree lint setup failures, and the corrected formatting
failure are preserved. None is a timing observation or was replaced by a
selected performance result.

## Frozen browser acquisition

There are six original comparison jobs: JMdict, Jitendex, and VNDB, each with
one initial-AB host and one initial-BA host. The reversed order is a separate
job and host allocation, not a second schedule on the first host. All use the
unchanged `dev/perf/import-qualification-20261125-a7f7.py` and its existing
browser/media/memory observers. Comparison jobs use `ubuntu-latest`; the
separate full correctness job uses `ubuntu-26.04`. The existing setup action
pins Node 22.22.0. Matching Chromium and its version identity are recorded.

Each cell retains the unchanged schedule:

- Two warmup pairs, four imports total, in original and reversed order.
- Twelve measured A/B pairs, alternating pair order, twenty-four imports.
- Four interleaved identical-code A/C pairs, eight imports, after every third
  measured pair using the qualifier's unchanged order rule.
- Two separate exhaustive-media imports, one for each arm, after timing.
- Four separately instrumented memory imports in the existing memory schedule.

That is 42 original complete imports per cell. No warmup, media, memory, or
instrumented duration enters the measured-pair performance statistic. Each
observation uses the existing complete-import endpoint and first real lookup
checks. The same locked archives and flags `{}` apply to both arms. VNDB uses
the prospectively fixed `--vndb-sah-allocation-units 37 37` policy.

The workflow performs no retries. Do not rerun jobs, replace failed or slow
observations, tune a threshold or implementation after results arrive, remove
outliers, subtract control drift, pool hosts, or substitute component timing.
Preserve the original attempt, all raw observations, packages, manifests,
stdout/stderr, and failures. A failed or incomplete gate prevents qualification.

## Existing-counter execution proof

The post-acquisition `audit-crc.py` only reads original reports. It neither
changes the timed observers nor adds metrics to the product. All 42 reports
must contain exactly one parser phase covering the full dictionary's banks,
with the frozen source volumes, parser group/worker policy, fused attempt
counts, and zero fallbacks recorded in the current source baseline.

Every original VNDB report, including A, B, and C, must retain:

| Existing metric                             | Required value |
| ------------------------------------------- | -------------: |
| Source CRC scanned bytes                    |    568,284,368 |
| Source CRC reused bytes                     |  3,699,708,599 |
| Reused glossary witnesses                   |      6,490,145 |
| Compressed term bytes                       |     86,850,424 |
| Uncompressed term bytes                     |  4,267,992,967 |
| Source banks                                |            665 |
| Parser groups / successful fused attempts   |            170 |
| Parser workers / pipeline groups per worker |          3 / 3 |
| Fused fallbacks                             |              0 |

These counts match the independently audited current browser trace and both
local complete-corpus parity passes. Together with the exact module hash and
single-function lowering change, they establish that the measured imports
exercise the intended CRC path. The current JMdict and Jitendex routes report
zero deferred-source CRC counts; no improvement is predicted for those routes.
Their existing source/group counts are also checked, and they remain full
correctness, memory, and latency guardrails. Missing or unexpected reports and
counts fail the audit; no diagnostic rerun can repair an original observation.

## Prospective decision rule

VNDB is the sole primary target. A review-worthy performance claim requires
all of the following on the original data:

1. **Both VNDB hosts** show at least a 2% reduction in the paired median of
   complete-import duration, and B is faster in at least 9 of 12 measured pairs
   on each host. Neither host can substitute for the other.
2. **Both VNDB hosts** have absolute identical-code A/C paired-median and
   equal-work changes no greater than 1% for each measure.
3. **Each JMdict and Jitendex guardrail cell** has absolute identical-code A/C
   paired-median and equal-work changes no greater than 3% for each measure.
4. Neither guardrail dictionary has a repeated slowdown greater than 3%:
   repeated means its paired-median B/A slowdown exceeds 3% on **both** original
   hosts. Report any isolated regression and every raw contrast as well.
5. All six cells pass exact source/package checks, complete semantic and first
   lookup receipts, exhaustive media checks, the unchanged memory screen and
   memory audit, and the existing-counter execution audit. The separate full
   correctness job must pass native rebuild, protocol tests, full unit suite,
   main and test types, scoped lint, and the all-target dry build.

Report per-host paired-median and equal-work changes, faster-pair counts,
descriptive bootstrap intervals, every identical-code control result, full
media/memory results, and every failure. These gates do not transform a
descriptive bootstrap into a different inferential claim. A failure, ambiguous
control result, incomplete observation set, or unsupported activation produces
no gain claim and no performance PR from this study. A passing result permits
root review for a PR; it does not authorize any further mechanism or tuning.

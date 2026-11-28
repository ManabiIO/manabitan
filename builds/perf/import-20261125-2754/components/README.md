# Component receipts and source identity

These receipts establish component output parity and preserve diagnostic work.
Browser timing and memory qualification are indexed separately. The archive
retains the supplied harnesses, original reports, available validation logs,
failed attempts, independent reviews, and exact committed asset identities.

## Frozen candidates and later validation heads

| Candidate                             | Frozen hosted source                       | Tree                                       |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| Native media-path projection          | `7a8b25a44a3fe165107ed816377cc72bb0fac67d` | `093a0be94fcf336ab5a0113b80fae7481855935a` |
| Native metadata publication preflight | `b2e816c4714f42f87cbb6a1ebc7fe1a2d2fd863b` | `be5b6a8d9c24915516d6edd8167a071e0449d793` |
| Contiguous source CRC verification    | `c2cf7647c67b02474301ed48e54a53205be0f027` | `074e622aec0c6537c7f0d8ac92725dd62c28b73b` |

All compare with baseline `7d1643e6147a10cb2165e9744cf0e63b59e46632`.
[source-identities.json](source-identities.json) binds every changed source
file and asset to its hash and records equivalent local commits.

The later media PR head `5afd2e97ec2707b150acfde61115aee688547a78` changes only
two test files; its product source and build inputs exactly match the frozen
media candidate. Later metadata validation head
`b273513dab4fa409a0213a2db470e52b4a0f559c`, tree
`dcaa01db1e3cb790275ea71543e1cd607cb46be9`, includes source formatting with a
retained exact normalized-AST proof and subsequent non-null test-fixture guards.
Metadata component and hosted measurements remain attributed to frozen
`b2e816c`; later validation logs retain their actual head labels. The CRC
annotation-only hosted head `2fe47fa3db04342d04eb4f309c5d74ef45eef9e3` (local
`a3b5ddf4bb676b06bd8a577c67f971907ddc30b2`) changes
one test JSDoc line and leaves all product/build inputs byte-identical to
frozen `c2cf7647`.

## Media projection

The complete VNDB oracle processes 170 production groups, 665 banks, and
6,648,310 rows. Legacy JavaScript and native projection outputs are deep-equal,
including content, key plans, prepared lookup routes, and media output. Owned
metadata is checked after subsequent native memory reuse.

All 146,725 media rows use the native single-path result, with zero projection
fallbacks. Whole-glossary JSON parsing falls from 146,725 calls over 84,398,732
bytes to zero; 2,391,178 path bytes are decoded. There are 146,570 unique image
paths. These are exact work counts and correctness observations, not timed
browser results.

Available final local receipts include 425 focused tests, source/test types,
scoped lint, the LLVM 21 pinned rebuild/check, all seven dry builds, and the
ordinary Chrome package comparison with exactly four changed members. Earlier
failed integration/test output and the dependency-symlink package mismatch
remain alongside the corrected receipts. `integration-snapshot` is pre-rebuild
scratch history, not the validated source-bound module. The rejected filename
arena experiment is retained with its patch and diagnostic receipt; it was
excluded from the product because retained catalog memory increased.

Independently fetched [CI run metadata](ci/media-run-45644262132.json) and
[all job summaries](ci/media-jobs-45644262132.json) confirm completed success
on source `5afd2e97ec2707b150acfde61115aee688547a78`: 15 jobs pass and four are
skipped. The passing jobs include full unit tests, the pinned WASM/build gate,
all type scopes, and full extension Chromium and Firefox end-to-end jobs.

## Metadata publication preflight

All three real corpora are compared through fake persistence and the production
record/index encoder, with a fresh metadata owner for each fixed group of four
banks. Exact content, records, indexes, and metadata are equal between native
and JavaScript validation paths:

| Corpus   | Rows      | Component groups | Native / JavaScript publication time |
| -------- | --------- | ---------------- | ------------------------------------ |
| JMdict   | 528,299   | 14               | 8.8907 / 65.9804 ms                  |
| Jitendex | 436,555   | 55               | 7.6811 / 47.1946 ms                  |
| VNDB     | 6,648,310 | 167              | 13.5044 / 29.3035 ms                 |

The timing column is a local component diagnostic with fake persistence. It
excludes the complete browser import and cannot be used as its speedup. The
canonical module hash is
`f17603b330f8d21f454681518db52a4fb02d07b0f16faec20d6a4f69e17a7acc`;
the parser remains baseline hash
`913da48a70eebfe8dfe8d96b60064cf0d472db3eccb2c12771686696cb78005c`.

Genuine later root-validation logs preserve passing lint, main/test types,
207 focused tests, and all seven dry builds at the later labeled head. The
initial 30 lint errors and eight fixture-nullability errors remain preserved.
The candidate owner's earlier test/rebuild outcomes had no saved raw log files;
this archive does not reconstruct those logs.

The later two-worker full unit run remains **failed**: 644 files and 14,561 tests
pass, 64 tests are skipped, one XXH32 offset-one test reaches its five-second
timeout, and the term-bank-memory-page suite reaches its ten-second compiler
setup timeout. These original failures and the passing pinned native check are
retained. A separate diagnosis runs exactly the two affected suites once on
baseline and once on the candidate, sequentially with one worker and their
original timeouts; each arm passes all 107 tests. The directly involved test,
runtime, and compiler sources are byte-identical to baseline. This diagnosis
does not replace the failed full run or establish a passing full-suite result.

The final read-only admission/phase audit is also retained. It binds the frozen
source and all 18 timed JMdict summaries to hashes, but records native publisher
call count as null because the existing reports do not measure admissions.
The observed production types and ownership are compatible with admission;
no concrete structural defect or corrective optimization was established.
Overlapping phase timers cannot establish a cause for the whole-import
regression. The hosted regression controls the hold decision.

## Contiguous source CRC

Production worker output parity covers all 201 groups and 7,613,164 rows across
JMdict, Jitendex, and VNDB. The final parser hash is
`183439d0b91d0f60c6a1a3823700b9e18a527238cb9b15f37a605027e3816c53`.
The bounded replays have different scheduling from a full parallel browser
import. The VNDB candidate's bounded result matches the earlier completed
parallel baseline; it does not qualify the failed concurrent candidate run.

Both exit-137 VNDB attempts retain missing candidate results. The diagnostic
failure receipt also preserves the first slower CRC prototype, setup/compiler
failures, filesystem and lint/type failures, and the test TypeScript heap-limit
failure. It distinguishes reported tool outcomes from saved raw logs. Final
focused/native validation and complete worker parity are reported with their
scope. Source-CRC counters are populated only for deferred validation;
baseline JMdict/Jitendex zero counters do not mean CRC checks were skipped.

Later genuine root-validation logs preserve the complete frozen-source unit
run: 647 files and 14,567 tests pass, with 47 skips, in 670.42 seconds. The pinned
native check and main types pass. The initial three test-type diagnostics and
the subsequent annotation-only fix are preserved; test types and scoped lint
then pass. All seven dry builds also pass; their original output is retained. These later logs
remain separate from the candidate author's earlier incomplete validations.

The [independent source review](crc-source-review.md) found no correctness
blocker and identifies the broader witness allocation as a reason browser
memory qualification remains necessary.

## Archive and replay

Final published PR/run/job snapshots and both later-head CodeQL failure
investigations are preserved. Metadata run `45647170330` at `b273513d` and CRC
run `45650131540` at `2fe47fa3` each complete all 89 query evaluations and SARIF
export, then fail after result upload starts. The complete logs do not identify
an explicit upload error or a more specific cause. Both gates remain failed;
the evidence does not classify them as source defects or harmless environment
failures. Workflows are unchanged and neither run was repeated.

At the recorded final snapshot, metadata's main workflow has six successful,
nine queued, and four skipped jobs, including both passing browser E2E jobs.
CRC has four successful, eleven queued, and four skipped jobs; Firefox E2E and
test build pass, while Chromium is queued. These pending source CI gates remain
unresolved. The independently confirmed passing media workflow is separate.

The archive manifest records all retained files, their exact hashes, source
roots, and four omitted compiled/historical binary payloads. Current production
WASM assets remain versioned in the frozen source commits. No fixture cache is
included. Earlier and later diagnostic files remain separate.

Verify or extract with the portable archive tool from the repository root:

```sh
python3 builds/perf/import-20261125-2754/tools/verify_text_archive.py \
  builds/perf/import-20261125-2754/components/archive-manifest.json \
  --extract /absolute/path/to/fresh-component-extraction
```

The original component harnesses are retained verbatim, including their source
layout assumptions. The media oracle accepts explicit repository, pinned ZIP,
and output paths. The metadata harness uses sibling `manabitan` and `jmdict`
checkouts and an `evidence` directory; that relative layout can be recreated
under any workspace root. The CRC worker harness retains its original arguments
and production-worker setup. Use the frozen commits, pinned fixture hashes,
Node 22.22.0, and original options recorded in each receipt when reproducing a
component. The source manifests and per-file hashes distinguish a reproduction
from the retained observation; repeated measurements do not replace failures.

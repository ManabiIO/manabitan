# Round 2 component evidence archive

This bundle preserves the local correctness, lowering, validation and exploratory
component-screen evidence for five separate import proposals. Source code is
available through the committed local/published identities recorded here. Raw
hosted browser campaigns and transfer-ownership component evidence are separate
bundles; this archive includes their small independent audit scripts/results so
the review method is preserved.

Historical component READMEs remain unchanged. Their tentative decisions predate
the completed hosted campaigns; consult the central handoff for final promotion
decisions. Component timings are not complete-browser import timings.

## Contents

| Archive directory      | Evidence retained                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inflate/`             | Full three-archive byte oracle; 12 raw screen arms, schedule, receipts and summary; focused tests, reproducible build and lint logs; both setup failures; inspected native lowering excerpts and scripts                                     |
| `crc-halves/`          | Full three-archive byte oracle; exact lowering receipts and assembly; focused tests and build checks; incomplete fixed screen with all three complete first-triplet arms, failed `02-C` log, failure/environment receipt and partial summary |
| `lookup/`              | Three full parser-output oracles; all 36 raw cold screen arms and complete-cohort receipt; native/segmented tests, build logs and initial timeout/lint failures; unstripped diagnostic identity receipt                                      |
| `flat/`                | Three full parser-output oracles and run receipt; all 36 raw cold screen arms and complete-cohort receipt; preflight identity; original/corrected focused-test and lint runs, build and rebuild logs                                         |
| `record-validation/`   | All 23 baseline/candidate serialized-sidecar/error comparisons, including committed-source oracle; focused tests, main/scoped types, dry build and lint logs; original wrapper/type-root/lint setup failures; replay scripts                 |
| `shared-parser/`       | Frozen full-output parser oracle/component runner, both earlier runner revisions, fixed scheduler/analyzer and original combined oracle accounting summary                                                                                   |
| `provenance/`          | Original and extended published runtime/blob manifests; publication and CI snapshots; branch ledger; current clean checkout/source identities for the baseline and five candidates                                                           |
| `independent-reviews/` | Native and transfer browser audit scripts/reports/logs, including original failed optional-frame audit and corrected version; all-observation memory audit script/report and observer/coordinator validation logs                            |
| `publication-updates/` | Verified before/after receipts, final bodies and manifest for four body-only PR updates; unchanged #812 snapshot and final CI receipt                                                                                                        |
| `packing/`             | Exact snapshot of the evidence freeze/verify utility used for this archive                                                                                                                                                                   |

`inventory.json` maps each selected original file to its staged archive path,
source location, byte size and SHA-256. Copies preserve original bytes, including
empty successful diagnostic logs. The outer `raw-members.json` also covers this
README and the selection inventory. Every outer archive member is independently
verified after compression.

## Source identities

| Proposal                           | Local source commit                        | Published source commit                    |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------ |
| Baseline                           | `5e1f8c12f7ff798ba407323aff675cb23b22af02` | Same commit                                |
| Native inflate SIMD copy / #812    | `efb21934f2f988813118b085b90a146933a4f519` | `5555f3efd3e0c8baa99e93b4c14e7f1889c30383` |
| CRC word halves / #817             | `c19478fdbdf1310c85b348915fcbcfa8df02d08a` | `4884b4bd93d45f152ec828bcca44990f18976a05` |
| Lookup initialization / #816       | `13701ea51befaf82211d23c5d47930c5ce2aac5b` | `3a4ef7ed11dd6b0509c12ad495ab8f591b68872b` |
| Flat glossary parsing / #818       | `4fca154e4e640929548068d7bdfddd3a86885ef3` | `524b41a112a1ba0b1ac31723da274c97d5525653` |
| Record-reference validation / #822 | `d0f9f604b873663ecf05a895b80e5be3326200fc` | `cf1e18d59d08da729d4b2fe45c7a07021f42360a` |

`provenance/checkout-identities.json` records tree hashes, tracked-diff hashes and
relevant source/production-WASM/lock file hashes. All six captured checkouts have
clean tracked status. Local and published commit IDs can differ while their
source trees are identical; the publication receipts preserve that mapping.
Both published-runtime manifests are retained because earlier independent
audits bind the original manifest's hash.

## Measurement scope and failures

The parser/lookup/flat local screens use fresh Node processes with four fixed
triplets per corpus: ABC, CBA, ABC, CBA. A and C use the identical baseline. The
complete lookup and flat screens therefore have 36 children each. Their boundary
is the serial component pipeline represented by the frozen runner; it excludes
browser startup, production worker messaging, OPFS persistence and UI completion.
There are no excluded warmup observations in those cold component screens.

The inflater/CRC runner has its own explicit warmup/measured corpus passes,
recorded in its plan and per-arm receipts. The inflate screen completed all 12
planned arms. The CRC screen stopped at arm `02-C` with signal 9 after the first
three complete arms. The partial log and failure/environment receipt remain
present. It has no complete-cohort performance conclusion and was not retried or
replaced.

All available initial failures are retained alongside corrected runs. These
include inflater harness buffer setup errors, the lookup test timeout and lint
failure, flat-glossary focused/lint failures, record-validator wrapper/type-root
setup failures, and the original browser auditor's overly strict next-frame
check. The corrected auditor accepts the harness's documented null next-frame
opportunity. None of these historical files was rewritten to imply a passing
original attempt.

The memory review retains both unqualified JMdict observations and cells. Its
qualified Jitendex/VNDB results describe sampled discovered Chromium-tree maxima
across startup/import/readback/restart. They are neither exact import peaks nor
timing evidence. Raw provider artifacts are preserved separately by the central
browser/memory evidence archive.

## Exclusions and reproduction

This bundle intentionally excludes dictionary ZIP payloads, `node_modules`,
toolchain installations, packaged extensions, generated WASM binaries, raw
browser/provider run trees, the existing transfer-ownership bundle and unrelated
first-round work. The small native assembly excerpts and CRC parser assembly are
retained because they are the evidence used for the stated lowering/opcode
analysis. The diagnostic unstripped WASM binary is omitted; its receipt records
the exact build command and proves that its noncustom sections match production.

No selected component log or failure receipt is known to be missing. The
committed code, exact fixture hashes, runtime identity, replay runners and
retained commands are sufficient to reconstruct inputs once the pinned fixtures
and build toolchain are supplied. There is no claim of a full-dictionary
record-store oracle: its 23-case replay is explicitly bounded. Final PR update
bodies are included after the publishing agent verified their readback and
released the completed directory; the later independent #822 hosted review is
consolidated separately.

Verify the outer bundle with the repository utility:

```sh
python3 dev/perf/import-r2-evidence-20261123.py verify builds/perf/20261123-r2-components
```

After extracting `raw-evidence.tar.xz`, the same verifier snapshot is available at
`components/packing/import-r2-evidence-20261123.py`. Each component's README or
runner contains its original reproduction command. Absolute scratch paths in
raw receipts are original provenance; substitute checked-out source and fixture
locations when replaying a runner, while retaining its pinned versions and
workload definition.

# Import optimization evidence: 23 November 2026

Report snapshot: **2026-11-23 21:23:32 UTC**. Browser status was observed at
21:23:25 UTC; hosted CI at 21:23:32 UTC. These isolated changes have verified
source identities and reduced specific work or retained backing storage. The
available measurements support **no import speed or peak memory claim**.

## Frozen sources and changes

All comparisons use develop `3d65e403c644b9a5a6be3128d72f9d30050b70e0`
(tree `c540375466fc921ab05a5526a6130bc2d48010d5`). Published trees match the
locally tested trees recorded in the [source index](import-screen-20261123-local/index.json).

| PR                                                                            | Published source                           | Verified tree                              |
| ----------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| [#852: filename arena](https://github.com/ManabiIO/manabitan/pull/852)        | `4737f9e05eb8600d926843bfc32675bd214a8bb1` | `0468c2768f18558b64c17d5f9e31e91f8a4b90f9` |
| [#853: adjacent media ranges](https://github.com/ManabiIO/manabitan/pull/853) | `2c604d0f0a252a7a2e223773292507921b19feaf` | `6b0b147b232e0baac7f412475b4e5a5084c0354e` |
| [#858: UTF-8 copy loop](https://github.com/ManabiIO/manabitan/pull/858)       | `cb9f241106ab1529fa21c112f1733849c188511c` | `655df9e9bd46fdd987a30473f2c3930007ce4e00` |

**Filename arena:** copying validated ASCII names into one owned arena releases
the central-directory backing allocation after construction. All 147,237 locked
VNDB catalog entries retain identical metadata and names. Filename backing falls
from 9,173,442 to 2,400,540 bytes: **6,772,902 bytes avoided** per completed catalog.
Both buffers coexist during construction; this does not establish lower process
peak memory. [Exact comparison and hashes](import-screen-20261123-local/pipeline-arena-comparison.json).

**Adjacent media ranges:** the final V3 guard uses tight reads only for at least
two selected entries with exact minimum-end adjacency. All 144 locked VNDB ranges
qualify. Source-range bytes fall from 205,086,922 to 195,649,882:
**9,437,040 fewer logical Blob bytes (4.601%)**, with the same 144 reads and all
146,570 compressed media payloads and metadata unchanged. These are not measured
disk-I/O bytes. A 1,024-entry archive with extra fields on every entry keeps one
original-size read; singleton and nonadjacent ranges also retain the original
path. An extra field only on the final member can still require one bounded retry.
[Final V3 evidence](import-screen-20261123-local/storage-v3-index.json).

**UTF-8 copy loop:** continuation validation and copying share one loop, removing
a second traversal while preserving rejection and fallback behavior. Pinned
LLVM 21.1.8 reproduces the WASM, which falls from 62,783 to 62,723 bytes.
The separate, larger width-specialization experiment was rejected and is retained
as negative evidence. [Native evidence](import-screen-20261123-local/native-index.json).

## Correctness and validation

The native independent oracle passed **7,613,164 rows across 937 banks**:
528,299 JMdict, 436,555 Jitendex, and 6,648,310 VNDB rows. Every compressed bank
was independently inflated and CRC/size checked; row fields and canonical content
were checked against JSON, with lookup bytes, references, hashes, and media
projections compared across arms. Its fixed four-bank partitions provide component
correctness coverage, not production-planner timing. [Full-corpus receipt](import-screen-20261123-local/parser-loop-all-parity.json).

Arena passed 110 focused tests, main/test types, scoped lint and all-target dry
builds. Its initial parallel type check encountered a transient generated-file
syntax error; the settled build passed. Final V3 passed 140 focused tests, types,
lint, all-target builds, and **641 suites / 14,419 tests**, with 47 skipped. A prior
storage invocation using a stale compiler wrapper was stopped and retained; the
successful run used a verified current wrapper.

The initial native full-unit invocation **did not pass**: 639 suites / 14,386
tests passed, two compiler-dependent suites failed to load, and one Android
helper timed out. With the corrected compiler, both affected native suites passed;
the first Android retry encountered two different five-second timeouts. An
unchanged-parent control and the final isolated candidate subsequently passed
22/22 Android tests at the unchanged timeout. Final types, lint, builds and WASM
reproduction passed. These targeted recoveries do not convert the original full
run into a pass. Original logs and recovery receipts remain in the native index.

## Complete browser cohorts

The [audit](import-screen-20261123-browser/audit.json) verifies retained hashes,
source/package identities, fixture locks, observation order, correctness checks,
and arithmetic. A and C are independent baseline builds; B is the isolated
candidate. Each complete cohort has three warmups, six balanced three-arm blocks,
and two untimed exhaustive-media diagnostics. Timed imports use fresh profiles
and production defaults. A/C package members match byte-for-byte; their ZIP
containers differ. Candidate package changes are confined to the intended files.

The following are **median paired elapsed-time changes**, not ratios of arm
medians. Negative values mean lower observed elapsed time.

| Current source / dictionary |     B/A |     B/C |     C/A |
| --------------------------- | ------: | ------: | ------: |
| Arena / JMdict              | +1.351% | +0.139% | +1.307% |
| Arena / Jitendex            | -0.005% | +1.347% | +0.291% |
| Arena / VNDB                | +1.086% | -0.881% | +0.761% |
| UTF-8 loop / JMdict         | -1.212% | -2.529% | +2.002% |
| UTF-8 loop / Jitendex       | -0.552% | -0.617% | -0.223% |

[Arena workflow](https://github.com/ManabiIO/manabitan/actions/runs/45262851083)
and [native workflow](https://github.com/ManabiIO/manabitan/actions/runs/45266391385)
use Chromium 153.0.8010.12. These exploratory single-runner screens do not
establish a reliable latency improvement: arena results track control variation,
and native JMdict C/A pairs range from -15.932% to +10.901%. Browser lexical
checks sample 12 terms / 72 production responses per observation; media
diagnostics are exhaustive. They do not replace the independent lexical oracle.
[Raw bundles and manifests](import-screen-20261123-browser/index.json).

### Superseded V2 observations

The historical `2da6e38c204e1bb22c5835f8f53f867e872b7296`
[media-ranges workflow](https://github.com/ManabiIO/manabitan/actions/runs/45263267064)
is separate from final V3:

| Superseded source / dictionary |     B/A |     B/C |     C/A |
| ------------------------------ | ------: | ------: | ------: |
| V2 / JMdict                    | -0.384% | +0.011% | -0.147% |
| V2 / Jitendex                  | -0.020% | -0.107% | +0.990% |
| V2 / VNDB                      | -1.495% | +0.156% | +0.656% |

JMdict and Jitendex fall below the large-Blob range threshold and serve as
negative controls. The V2 local component timing, its excluded contaminated
cohort, and rejected V1 observations remain in the local index. No V2 timing is
transferred to V3. V2 VNDB recorded OPFS byte totals of 609,553,611 or 609,561,803;
semantic lookup and exhaustive media digests matched. These physical-layout
diagnostics remain recorded without being treated as equality gates.

The snapshot preserves 184 browser observations: 115 on current arena/native
heads and 69 on the superseded V2 media head. Final V3 has no completed browser
cohort at this checkpoint.

## Pending at this snapshot

[Browser status](import-screen-20261123-browser/screen-status.json) still has
native VNDB and all three
[final V3 cohorts](https://github.com/ManabiIO/manabitan/actions/runs/45267017516)
pending. Partial cohorts are excluded from the tables.

The [CI checkpoint for these commits](import-screen-20261123-local/ci-final-code-heads.json)
records [arena CI](https://github.com/ManabiIO/manabitan/actions/runs/45262275453)
success: 15 jobs passed and four conditional jobs were skipped. Passing jobs
include 641 unit suites / 14,406 tests and Chromium/Firefox E2E.
[V3 CI](https://github.com/ManabiIO/manabitan/actions/runs/45266940839)
has Test Build passed; [native CI](https://github.com/ManabiIO/manabitan/actions/runs/45266339914)
has Test Build and Chromium E2E passed. Their remaining jobs, including hosted
unit suites, are queued or running. Skipped jobs are not successful validation.

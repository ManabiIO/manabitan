# Import optimization investigation — 2026-11-28 UTC

## Status and scope

This investigation targets JMdict first, with Jitendex and VNDB as required
cross-corpus checks. The original experiments use baseline
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Two separate completed browser
studies use current baseline `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`.

**No performance PR has been opened from this investigation.** The original
experiments and both current-baseline browser studies are complete and audited.
The single-pragma CRC variant is rejected: its Node component gain did not
translate to Chromium imports, and JMdict/Jitendex results were adverse. The
canonical checksum integration is held: its original small JMdict signal did
not repeat, despite a faster record-write phase. Neither current candidate
meets the bar for a performance PR. The recent-first glossary revision also
remains held. See the [independent final decision](final-decision/README.md).
This record makes no cumulative speedup claim.

All fixtures are the complete pinned archives in
`test/perf/dictionaries.lock.json`: JMdict 528,299 rows, Jitendex 436,555 rows
and VNDB 6,648,310 rows. They are not asserted to be the latest upstream
releases. The baseline package lock, fixture hashes, runtime source, native
binaries and measurement protocols are recorded with each study.

The work used isolated research/runtime branches and hosted CI. No browser
Work mode was used. Three delegated streams covered profiling and prior work,
candidate implementation, correctness, acquisition and independent review.
When the local executor became unavailable, existing measurements remained
frozen and subsequent analysis moved to an explicitly registered hosted
artifact-audit job. After the executor recovered, local re-audits independently
matched all three complete canonical reports and verified all original
archives. No timing observation was rerun during either audit.

## Completed decisions

Negative percentages mean less measured time. Component results and complete
browser imports have different scopes and must not be combined.

| Experiment                                            |    JMdict | Jitendex |     VNDB | Decision                                                                                                    |
| ----------------------------------------------------- | --------: | -------: | -------: | ----------------------------------------------------------------------------------------------------------- |
| CRC unroll disabled, current complete imports         |   +1.628% |  +2.368% |  −0.234% | Reject: browser results do not reproduce the component gain; JMdict/Jitendex are adverse.                   |
| Canonical checksums, current complete imports         |   +0.922% |  +0.167% |  −0.001% | Hold: no repeatable complete-import benefit; original JMdict signal did not confirm.                        |
| Native record-field encoding, complete imports        |   −0.442% |  +1.635% |  −1.142% | Hold: all descriptive intervals include zero; incomplete JMdict/VNDB memory acquisition.                    |
| Indexed score validation, complete imports            |   −1.112% |  −0.440% |  +0.358% | Hold: small/noisy effects, disagreeing estimators and controls; one corpus lacks qualified memory coverage. |
| Original prefix-first witness, warm component         |   −3.903% |  +1.394% |  +2.638% | Hold: JMdict signal accompanied by other-corpus and synthetic regressions.                                  |
| Recent-first glossary witness, warm component         |   −2.751% |  +2.405% |  +1.209% | Hold: other-corpus and long-unique regressions persist.                                                     |
| Canonical-module checksums, original complete imports |   −1.097% |  −0.398% |  +1.134% | Hold after the separate current-base confirmation failed to repeat the JMdict signal.                       |
| Disable CRC inner-loop unrolling, first owning pass   |   −4.149% |  Not run |  Not run | Rejected after the same single pragma failed current-base complete-browser qualification.                   |
| Separate-module native checksum, startup + component  |  −12.128% |  +4.236% | −40.249% | Mechanism evidence only; motivated a different canonical-module integration.                                |
| Chromium DecompressionStream, 64 KiB input slices     |  +42.366% |  Not run |  Not run | Reject: all six JMdict pairs slower.                                                                        |
| Chromium DecompressionStream, 1 KiB input slices      | +145.057% |  Not run |  Not run | Reject: all six JMdict pairs slower.                                                                        |

The current CRC and canonical rows, and the native record-field, score-validation
and original canonical-checksum rows, report complete-import paired medians. Both glossary-witness rows are warm sequential
component replays; their pair-index sums are descriptive complete-work totals,
not independent browser imports. The separate-module checksum component row
includes that helper's module startup and hashing work, not parser/storage/UI
or concurrent-worker import latency. The CRC first-owning-pass row reports summed component
work, not concurrent browser elapsed time; the separate current CRC row
reports complete browser imports. The DecompressionStream rows cover
inflation, source CRC, framing and copies into native memory; parsing and storage
remain outside those timers.

### Native record fields

[Full evidence and decision](record-browser/README.md) ·
[Original run](https://github.com/ManabiIO/manabitan/actions/runs/46102045293)

The 1,180-byte native encoder substantially reduces its field-writing phase,
but the six-pair whole-import cohorts do not establish a reliable practical
benefit. Exactly 78 original browser observations are retained. Their package,
output, storage, lookup/restart and exhaustive-media checks pass. JMdict and
VNDB fail parts of the separate memory-acquisition protocol; missing coverage
is neither a measured saving nor a measured regression.

The measured candidate is
`731c7374dc9e1e242142796f597be9939a3cda2c`.
A later lint-only repair remains separately attributed; the original lint
failure was not rewritten. The separate Float64-admission extension has
component correctness evidence but no demonstrated production need, and is
not promoted.

### Indexed score validation

[Full evidence and decision](score-browser/README.md) ·
[Original run](https://github.com/ManabiIO/manabitan/actions/runs/46106190962)

The two-line loop restoration passes the complete unit suite, all four type
projects, full JavaScript lint and all-target build validation. All 78 browser receipts
pass the output/package checks. JMdict's −1.112% paired median is accompanied
by +1.152% equal-work time and a −6.196% identical-code median. VNDB's
identical-code median is +8.832%. These discrepancies prevent a useful
complete-import claim; unfavorable observations remain included.

The measured runtime is
`79a9e1abbeff1a56bcc20cb958f03290c0fa0711`, tree
`4ecebc3a54f8ae865ae3f98943695fa9cbb8341d`.
The inspected runtime tree of another session's PR #978 is identical. This investigation
creates no duplicate PR; its held full-import evidence applies to those exact
runtime bytes.

### Original prefix-first glossary witness

[Full evidence and decision](prefix-component/README.md) ·
[Original run](https://github.com/ManabiIO/manabitan/actions/runs/46106527898)

JMdict glossary witnesses increase from 54,641 to 200,168 and full-content
reuse from 154,416 to 159,158. However, Jitendex and VNDB regress, as do the
enabled unique-input controls. Short unique glossaries are slower in every
pair: +7.824% paired median and +12.853% equal-work time. The favorable
synthetic fixture's large saving does not override these negatives.

The initial acquisition failed package identity before timing. Its failure
is retained separately from the corrected dependency staging. The independent
audit reconstructed all 5,661 ordered entries, including verification calls
excluded from timing; 242 edge-oracle comparisons include 175 matching
successes and 67 matching errors.

Only one follow-up was authorized: preserve recent probes first, then consider
the prefix witness after a miss when the preceding successful row's glossary
span in the same bank meets the existing 64-byte prefix width. No further
threshold sweep or dictionary-name routing was introduced.

### Native sidecar checksums

[Original component evidence](checksum-browser/README.md) ·
[Component run](https://github.com/ManabiIO/manabitan/actions/runs/46105941620)

Across 96 fresh-browser component observations, the startup-inclusive median
saving is 4.16 ms for JMdict, negative 0.98 ms for Jitendex, and 69.00 ms for
VNDB. These captures omit some actual worker options and content-dictionary
splitting, so they establish a mechanism opportunity rather than production
activation or complete-import benefit.

The follow-up places triple XXH32 in unused reserved space in the existing
canonical module. It avoids a new module startup or private arena, while
retaining authoritative validation and JavaScript fallback. Its original
runtime and full-import cohort are separate from the component experiment.
A separate session's growing-memory SIMD module is an alternative at the
same checksum endpoint, not an additive optimization.

### DecompressionStream

[Full evidence and decision](decompression-stream/README.md) ·
[Original run](https://github.com/ManabiIO/manabitan/actions/runs/46108692453)

Both fixed streaming variants lose clearly on all JMdict data. The smaller
input slices reduce the pinned browser implementation's conditional active
decoded-payload bound but increase measured inflation/CRC/copy work. No production
hook or additional slice-size variant is pursued.

All 36 original arms, source identities, conformance observations and failures
are retained. Chromium passes 171 format/source checks. Node feasibility
failures remain failures; its ordinary output equality does not establish
eligible error behavior. The ordinary 459.3 ms source-inflation counter
already includes immediate source CRC and begins after JavaScript allocation
and compressed-input copying. The 166.852 sampled CRC milliseconds come from
a separate traced observation, whose source-inflation counter is 402.1 ms.
Neither addition nor subtraction between those different observations is a
valid decomposition; summed worker samples are not elapsed import latency.

## Completed original studies and current-base qualification

### Canonical-module checksum integration

[Original run](https://github.com/ManabiIO/manabitan/actions/runs/46112170828) ·
[JMdict audit](hosted-audit/canonical-jmdict/independent-audit.json) ·
[Jitendex audit](hosted-audit/canonical-jitendex/independent-audit.json) ·
[VNDB audit](hosted-audit/canonical-vndb/independent-audit.json)

The original runtime is `570ccc3968046269cb00d2053e49d3c32367031a`.
Every original package, source, output, storage, lookup/restart and media receipt
passes: 42 observations per corpus, 126 total. Ordinary timing uses 12 balanced
pairs, four interleaved identical-code pairs and four retained warmups; media
and memory observations are separate.

| Corpus   | Complete-import paired median | Equal-work change | Faster pairs | Descriptive 95% interval | A/A median | Median paired difference |
| -------- | ----------------------------: | ----------------: | -----------: | ------------------------ | ---------: | -----------------------: |
| JMdict   |                       −1.097% |           −1.458% |        10/12 | [−2.416%, −0.535%]       |    +1.639% |                 −7.60 ms |
| Jitendex |                       −0.398% |           −0.684% |         7/12 | [−2.584%, +0.810%]       |    −0.961% |                 −6.60 ms |
| VNDB     |                       +1.134% |           +0.186% |         5/12 | [−2.610%, +4.320%]       |    +1.511% |                +59.25 ms |

JMdict's original small full-import signal warranted one independent,
opposite-order confirmation on the current baseline. It did not repeat in
that completed confirmation below. Original Jitendex and VNDB were inconclusive.
The record-write diagnostic, which includes hashing and other write work,
has paired medians of −32.009%, −24.993% and −4.392%, respectively. These
overlapping work counters are not added to elapsed import time. Jitendex's
unmodified field-encoding control also moves strongly, reinforcing the need
to judge complete imports and controls together.

All four JMdict memory observations and all four Jitendex observations qualify.
VNDB B2 fails the original 250 ms maximum-coverage-gap rule with
281.402405 ms. Its semantic receipts remain valid, but that memory pair stays
unqualified; no value is imputed and no replacement observation is substituted.

The original candidate passes 15,147 tests in 670 files, with 47 skipped.
Its original static lane fails two unsafe-assignment lint diagnostics.
The separate two-JSDoc-line correction,
`ee903e032650430839468fef391b8d820196e61d`, passes its
[source gate](https://github.com/ManabiIO/manabitan/actions/runs/46119597739):
complete JavaScript lint, all four type projects, pinned native reproduction,
all-target build dry run and JSON formatting. Removing exactly those two
comments recovers the original scanner bytes. The failed original source
gate and unchanged measured runtime remain separately attributed.
[Source follow-up records](hosted-audit/source-followup/retention-manifest.json)
retain the complete decoded job log and API metadata. The small source-gate
artifact archive itself has not been independently rehashed.

The implementation writes triple XXH32 into unused reserved space in the
existing canonical scanner. It introduces no new module, arena growth,
storage format, worker policy or batching policy. Current-arena checks and
ordinary private typed-array/intrinsic/alias guards precede the append-only
native path; validation and JavaScript fallback remain authoritative.
Read, reopen and repair paths retain their JavaScript behavior.
The [activation source review](hosted-audit/source-followup/activation-source-review.md)
supports correct wiring but does not claim a measured activation census.

The current-base composition is
`dcbbab6d1bfcebede50969f6d4b23e4f09561aa3`, tree
`fc90894e914a29de988753bbe4b062bb2f617f93`, sole parent `dcfc02a0`.
All six copied affected JS/C/native files and the original twelve-case test
are byte-identical to the corrected previous candidate. The generated manifest
reflects all 14 current native inputs. Its canonical module is unchanged at
6,206 bytes, SHA-256
`631a1c430f50579f2ca7227f05ee3793a508d3e5c2ab988024b1616e1f7b8896`.
The parser remains the current baseline module; the CRC pragma is absent.
The current composition passes its [complete local gates](canonical-current-source/local-gates-summary.json):
670 files, 15,151 tests passed and 47 skipped; full JavaScript lint, all four
type projects, pinned native reproduction, all-target build dry run and JSON
formatting. There were no retries or source edits. The [complete log bundle](canonical-current-source/local-gates-evidence.zip)
retains that execution separately from hosted qualification.

[Confirmation run 46128439514](https://github.com/ManabiIO/manabitan/actions/runs/46128439514)
is bound to study `07307bed49e6fd80ec28c37e0313a6bff402b66f`, tree
`f18eaa4af84d68086a7fcfe0e7215a742cf55a79`. It keeps the algorithm,
3,072-byte admission threshold, guards and protocol unchanged, starts BA,
and evaluates each corpus on a separate host. It neither replaces the original
VNDB failure nor pools cohorts. Both hosted source/unit prerequisites and
Actionlint pass. The complete current hosted unit suite has the same 670
files, 15,151 tests passed and 47 skipped. The [source artifact audit](canonical-current-source/hosted-source-audit.json)
independently binds both runtimes and all eight qualification source files to
their published Git objects; it verifies the pinned native checks and seven
build targets. The build check is a dry run, not emitted release archives.

#### Completed current-baseline confirmation: hold

[JMdict raw audit](current-browser/canonical/jmdict/local-independent-audit.json) ·
[Jitendex raw audit](current-browser/canonical/jitendex/local-independent-audit.json) ·
[VNDB raw audit](current-browser/canonical/vndb/local-independent-audit.json)

All 126 original package/source/output/storage/media receipts pass. Local
frozen audits reproduce the complete original hosted reports without
substituting local output for original artifact members.

| Corpus   | Whole-import paired median | Equal-work change | Faster pairs | Descriptive 95% interval | A/A median | Median paired difference |
| -------- | -------------------------: | ----------------: | -----------: | ------------------------ | ---------: | -----------------------: |
| JMdict   |                    +0.922% |           −1.486% |         5/12 | [−1.579%, +1.987%]       |    −0.727% |                 +9.65 ms |
| Jitendex |                    +0.167% |           +0.238% |         6/12 | [−1.061%, +1.472%]       |    +2.843% |                 +2.70 ms |
| VNDB     |                    −0.001% |           −0.484% |         6/12 | [−3.035%, +2.271%]       |    −0.679% |                 ≈0.00 ms |

JMdict's original −1.097% median with 10/12 faster pairs did not repeat:
the current cohort is +0.922%, with 5/12 faster. Its favorable −1.486%
equal-work figure remains reported, including pair 12, A=1,307.8 ms and
B=1,067.2 ms (−240.6 ms). That single pair exceeds the magnitude of the
complete −193.1 ms sum of paired differences and explains the estimator
disagreement; no trimmed or replacement result is used.

The record-write diagnostic improves in all twelve JMdict and all twelve
Jitendex pairs: −25.588% and −33.495% medians, respectively.
That diagnostic includes checksum and other append/write work. JMdict's
identical-code write diagnostic has a −18.644% median; it is neither subtracted
from the candidate nor presented as isolated checksum savings. Jitendex's
whole-import identical-code pair 1 moves +361.5 ms; all controls remain.
VNDB's write diagnostic likewise improves in all twelve pairs, with a
−10.408% median and −78.85 ms median paired difference; its
complete-import median remains effectively zero.

The integration adds 390 product-line insertions, 407 regression-test lines
and 4,582 uncompressed canonical-WASM bytes, with additional ABI, admission and arena
lifecycle responsibilities. A faster diagnostic alone does not justify that
maintenance cost without a repeatable practical complete-import benefit.
No new threshold, combined variant, replacement cohort or PR is proposed.

Current memory screens pass for JMdict and Jitendex. VNDB B1 and A1 exceed
the unchanged 250 ms maximum-coverage-gap limit at 328.369735 ms and
373.125723 ms, respectively; A2 and B2 qualify. All 466 raw scans and all
semantic receipts remain. Aggregate memory metrics are null; no value is
imputed and no acquisition is replaced. The original-baseline VNDB memory
failure remains a separate observation.

### Recent-first glossary witness: hold

[Full decision](hosted-audit/prefix-local-review/DECISION.md) ·
[Original run](https://github.com/ManabiIO/manabitan/actions/runs/46114428610)

The runtime is `1a935bddf29c4d87606d2facd4b168af7e1a40f1`.
The reconstructed auditor first reproduces the original prefix-first known
answer, then accepts all three recent-first artifacts and all 5,661 ordered
journal entries. The complete source/native identities and package-member maps, 242 oracle
comparisons per corpus, controls and failed/error cases are retained. Those
original artifacts did not include release ZIP payloads, so the prefix audit
does not claim an independent rehash of those missing package containers.

JMdict improves −2.751% median and −2.364% equal-work, with all six treatment
pairs faster; its A/A median is −1.104%. Jitendex regresses +2.405% median and
VNDB +1.209%. The long unique-prefix control regresses +12.699% paired median, with all six
pairs slower; common-prefix/different-middle input regresses +3.631% median,
with five of six pairs slower.
The existing-width gate removes the earlier short-only slowdown but leaves
the long-unique miss cost. There is no further threshold sweep, runtime
variant, rebase or full-browser study for this candidate.

Recorded native heap capacities agree, which is not a total-process memory
pass. VNDB's 26 synchronous Float64/fallback groups are capture-option
diagnostics, not production admission counts.

### Single-pragma CRC screen and current-base browser study

[Component evidence and complete raw audit](crc-component/README.md) ·
[Original component run](https://github.com/ManabiIO/manabitan/actions/runs/46120623371) ·
[Current-base browser run](https://github.com/ManabiIO/manabitan/actions/runs/46127721419)

The original component changes only `#pragma clang loop unroll(disable)`
on the existing eight-lane CRC loop. The 64-byte group, table, threshold, fold,
tail and import policy remain unchanged. The uncompressed production parser module shrinks
1,021 bytes. Reduced register-stack traffic motivated the experiment; the
pragma also changes state-array memory operations, so codegen counts alone
do not establish a throughput cause.

All six first-pass treatment pairs improve: −4.149% paired median,
−4.061% equal-work and −7.1834 ms median paired difference. The separate
second pass improves −4.069% median and −4.069% equal-work, with all six pairs
faster and −5.7959 ms median difference. First-pass A/A is −0.652% median;
second-pass A/A is +0.0237%. All controls and unfavorable observations remain.

The timer measures allocation, compressed copies, inflation, immediate CRC
and wrapper work across all 12 JMdict groups. It is summed component work
from 24 fresh Node 22.22.0 processes with three private instances each,
not concurrent elapsed browser-import time. No first/second pass is pooled.

The original archive is independently rehashed and all 327 members are
retained. The raw audit checks 27 frozen source files, 837 CRC vectors, 157
production source cases, all 53 banks/528,299 rows/171,617,523 decoded bytes,
576 timed groups and every verification/arm journal. Native capacities agree;
this does not replace a browser process-memory screen.

The separate current-base runtime is
`19db774b564064a7e339d3c3a79ea8da04ab48b5`, tree
`6f6c0ba610392f6ae6aa6df5c826e3d677f6f1af`, sole parent `dcfc02a0`.
The pinned production build reproduces both current modules. Candidate parser
SHA-256 is `91774a3c167689211fe49e75b68eb0f91bed42c319bf83e01325dfcf976d0fc3`,
68,047 bytes versus 69,068 baseline bytes. All current CRC vectors, production
source cases and complete JMdict source groups pass again. Removing the
pragma recovers baseline C exactly; 49 other parser assembly functions agree.

[Current local source gates](crc-current-source/local-gates-summary.json)
pass full JavaScript lint, all four type projects, all-target build dry run,
JSON formatting and 15,139 tests in 669 files, with 47 skipped. The initial
full unit attempt failed two compiler-discovery checks; correcting only PATH
to expose the pinned versioned default linker resolved them and enabled 21
additional tests. The first failed full run, both failed compiler probes and the successful
corrected probe remain in the [complete gate bundle](crc-current-source/local-gates-evidence.zip).

Registered study `477fb271ef25fac533fb1faf737a5dab898190e3` uses the same
42-observation protocol per corpus, exact package/source binding, three
workers, interleaved controls and independent media/memory observations.
It requires native correctness and full source/unit predecessors. Only the
parser C and WASM package members may differ. Immediate whole-bank CRC is
inside inflation; deferred `parserSourceCrcMs` belongs inside parsing.
Neither counter is added to elapsed import time. Both hosted source/unit
prerequisites pass, including the complete current source oracle and the same
669-file/15,139-test unit suite. Actionlint also passes.

#### Completed current-baseline browser study: reject

[Complete CRC decision and receipts](current-browser/crc/README.md) ·
[JMdict audit](current-browser/crc/jmdict/local-independent-audit.json) ·
[Jitendex audit](current-browser/crc/jitendex/local-independent-audit.json) ·
[VNDB audit](current-browser/crc/vndb/local-independent-audit.json)

All 126 original package/source/output/storage/media receipts pass, and all
three frozen local audits match the original hosted reports.

| Corpus   | Whole-import paired median | Equal-work change | Faster pairs | Descriptive 95% interval | A/A median | Median paired difference |
| -------- | -------------------------: | ----------------: | -----------: | ------------------------ | ---------: | -----------------------: |
| JMdict   |                    +1.628% |           −0.496% |         4/12 | [−0.525%, +2.850%]       |    +0.483% |                +14.90 ms |
| Jitendex |                    +2.368% |           +2.089% |         3/12 | [−0.090%, +3.349%]       |    −0.683% |                +27.50 ms |
| VNDB     |                    −0.234% |           −1.028% |         6/12 | [−2.297%, +1.805%]       |    −3.298% |                −11.60 ms |

JMdict's equal-work estimate is favorable while its median and 8/12 pairs
are adverse. Pair 10, A=1,117.7 ms/B=918.6 ms, remains included; it explains
much of that discrepancy. Jitendex's inflation-plus-immediate-CRC diagnostic
is slower in all twelve pairs, with a +10.234% paired median. The earlier
fresh-Node owning-phase improvement therefore cannot support a Chromium
throughput claim. VNDB's small favorable median is mixed and sits within
larger identical-code variation; its −600.5 ms pair 7 is also retained.

Jitendex and VNDB pass all four separate memory observations each. JMdict B1
fails the original 250 ms maximum-coverage-gap rule at 349.048089 ms after a
process-tree change and an unreadable discovered process. All four JMdict
memory benchmark processes exit successfully and their semantic receipts
pass, but memory pair 1 remains unqualified. Pair 2 qualifies (sampled PSS
+0.833%, private +0.871%); aggregate memory metrics remain null. This is a
coverage failure, not a measured memory regression or saving.

The one-pragma variant is rejected. Its uncompressed WASM shrinks 1,021 bytes
(69,068 to 68,047), while the compressed WASM member grows 55 bytes and the
release ZIP grows 74 bytes. This does not supply a download-size saving or
outweigh the missing complete-import improvement and adverse Jitendex phase.
No alternate unrolling factor, lane count or further cohort is pursued.

### Bounded inflater follow-up: no new candidate

[Source and profile review](inflater-followup/README.md) ·
[Retained processed profile inputs](inflater-followup/retained-profile-inputs.json)

The native decoder remains substantial work in the traced JMdict observation,
but the reviewed opportunities do not identify a new removable cost. The
implementation already reuses its per-instance decompressor and fixed
Huffman tables, inflates into parser-owned output, and preserves all twelve
JMdict groups as independent bank spans without a decoded-bank joining copy.
It already selects the wide native decode/copy path reviewed in PR #664.

The retained top-frame samples bound the named table-builder function at
approximately 8.2 sampled milliseconds; that excludes header bit decoding
in the main decoder and is not an elapsed-import saving estimate. Dynamic
table caching would add preserved state or copying to the current union
layout without a measured repetition census. The separate SIMD history-copy
proposal in PR #812 also failed to replicate a complete-import gain. No
new implementation or timing cohort was justified by this bounded review.

The retained ZIP contains original processed summaries, mapping helpers,
named and production modules, and the current capture manifest. It is not
the complete original raw browser trace and cannot replay trace acquisition.
The named module's non-custom sections are independently byte-identical to
the exact profile-baseline production module.

### Completed audit and preservation

The [combined hosted audit](https://github.com/ManabiIO/manabitan/actions/runs/46122561920)
reproduces the prefix known answer and all six original corpus audits,
and preserves the original CRC artifact. Its failed job conclusion retains
the original VNDB memory-gate failure; there are no acquisition, auditor or
retention failures. The CRC component's separate raw audit supplies its
correctness and arithmetic verification.

The root's independent local audits produce complete canonical reports equal
to the hosted reports. Before publishing the earlier original-cohort evidence
commit `d32c3f68aa86c5b7fa97864cc9fbc4dda10af0a2`, the root rehashes 101 files,
checks 104 registered tree entries, compares all four verbatim component
archives and verifies every byte of all 313 retained original members per
original canonical corpus. Only the exact two package ZIP
members are omitted from the durable reduced canonical archives, after the
full original-package audits pass; complete original member maps and outer
digests remain. The reduced archives cannot alone repeat the full package
audit. No original timing observation or failed memory scan is replaced.

The same original-first process covers all six completed current browser
artifacts: full original ZIP size/digest and member census, full frozen
source/package/output audit, then compact retention of every member except
the exact package-A/package-B ZIPs. Original hosted reports and local audit
reports remain distinct. The root independently compares fetched Git objects
to the local files and checks every retained member against its complete
original artifact before advancing the evidence branch. Full current source
and unit artifact ZIPs and all decoded job logs are retained separately.
The final review does not infer speedup from successful source or CI gates.

## Baseline advanced during the investigation

At the independent ref check at 07:57 UTC, `develop` had advanced to
`dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16` by merging
[PR #972](https://github.com/ManabiIO/manabitan/pull/972). That change reuses
scalar token ends and fast-paths compact structured glossary lists. It is
separate work; none of its results are claimed as this investigation's gains.

The merged code directly overlaps the cost that the glossary witness tries
to avoid. The checksum runtime files are unchanged. The complete C prefix
containing CRC, inflation and source verification is byte-identical, but the
full parser module and its layout have changed; no generated-code equivalence
is inferred from unchanged C functions.

All original observations remain relative to `9e10d3b`. Any candidate worth
advancing must be reviewed and qualified against the then-current develop
baseline before a performance PR. Historical component percentages cannot be
transferred to that new combination.

## Measurement and retention rules

- Fresh browser profiles, actual parser-worker counts and pinned fixture work
  are recorded in the complete-import studies.
- No measurements were trimmed, replaced, control-subtracted or pooled across
  hosts. Timing, exhaustive-media checks and memory sampling are separate.
- Nested phase counters do not add up to elapsed import latency. Large
  component percentages are not claimed as complete-import gains.
- A successful CI process is not evidence of speedup. Source correctness,
  package identity, output/storage behavior, timing and memory qualification
  are reviewed separately.
- Failed acquisition, source checks, malformed-input cases, unfavorable
  controls and outliers remain available.
- Verbatim component ZIPs are retained in Git. Browser receipt archives retain
  every original observation and a complete original-member census, omitting
  only explicitly listed reproducible package ZIPs after their full byte
  audit. Original package hashes and the limits on later re-auditing are
  documented.
- Original and corrected sources have separate immutable identities.
  Later lint or acquisition fixes do not relabel earlier observations.

Individual directories contain exact commands, source hashes, native hashes,
plans, audits and failure records. No cumulative percentage or combined
candidate has been inferred from these separate experiments.

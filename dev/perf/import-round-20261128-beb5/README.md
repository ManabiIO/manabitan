# Import optimization investigation — 2026-11-28 UTC

## Status and scope

This investigation targets JMdict first, with Jitendex and VNDB as required
cross-corpus checks. The frozen baseline is
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.

**The completed experiments below do not yet justify a new performance PR.**
The canonical-module checksum integration, recent-first glossary revision and
one-pragma CRC screen remain separately attributed pending final audit or
execution. This report is an investigation record, not a cumulative speedup
claim.

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
artifact-audit job.

## Completed decisions

Negative percentages mean less measured time. Component results and complete
browser imports have different scopes and must not be combined.

| Experiment | JMdict | Jitendex | VNDB | Decision |
| --- | ---: | ---: | ---: | --- |
| Native record-field encoding, complete imports | −0.442% | +1.635% | −1.142% | Hold: all descriptive intervals include zero; incomplete JMdict/VNDB memory acquisition. |
| Indexed score validation, complete imports | −1.112% | −0.440% | +0.358% | Hold: small/noisy effects, disagreeing estimators and controls; one corpus lacks qualified memory coverage. |
| Original prefix-first witness, warm component | −3.903% | +1.394% | +2.638% | Hold: JMdict signal accompanied by other-corpus and synthetic regressions. |
| Separate-module native checksum, startup + component | −12.128% | +4.236% | −40.249% | Mechanism evidence only; motivated a different canonical-module integration. |
| Chromium DecompressionStream, 64 KiB input slices | +42.366% | Not run | Not run | Reject: all six JMdict pairs slower. |
| Chromium DecompressionStream, 1 KiB input slices | +145.057% | Not run | Not run | Reject: all six JMdict pairs slower. |

The first two rows are medians of complete-import paired ratios. The prefix row
is a warm sequential component replay; its pair-index sums are descriptive
complete-work totals, not independent browser imports. The native checksum row
includes that helper's module startup and hashing work, not parser/storage/UI
or concurrent-worker import latency. The DecompressionStream rows cover
inflation, source CRC, framing and native input copies; parsing and storage
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
projects, full JavaScript lint and all-target builds. All 78 browser receipts
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
decoded-payload bound but increase CPU/copy/stream overhead. No production
hook or additional slice-size variant is pursued.

All 36 original arms, source identities, conformance observations and failures
are retained. Chromium passes 171 format/source checks. Node feasibility
failures remain failures; its ordinary output equality does not establish
eligible error behavior. The 459.3 ms source-inflation profile already includes
source CRC; sampled CRC time must not be added to it.

## Final frozen studies awaiting disposition

| Study | Measured runtime | Original run | Outstanding item |
| --- | --- | --- | --- |
| Canonical-module checksums | `570ccc3968046269cb00d2053e49d3c32367031a` | [46112170828](https://github.com/ManabiIO/manabitan/actions/runs/46112170828) | Full artifact audit; VNDB retained complete timing but failed a separate qualification gate. |
| Recent-first glossary witness | `1a935bddf29c4d87606d2facd4b168af7e1a40f1` | [46114428610](https://github.com/ManabiIO/manabitan/actions/runs/46114428610) | All jobs complete; reconstruct controls and timings from original artifacts. |
| Disable CRC inner-loop unrolling | Applied only to an artifact source copy from the baseline | [46120623371](https://github.com/ManabiIO/manabitan/actions/runs/46120623371) | Exact native reproduction, correctness and fresh-worker component timing. |

The canonical candidate passes 15,147 tests in 670 files, with 47 skipped.
Its original static lane fails on exactly two unsafe-assignment lint
diagnostics. A separate two-JSDoc-line correction,
`ee903e032650430839468fef391b8d820196e61d`, has its own
[source gate](https://github.com/ManabiIO/manabitan/actions/runs/46119597739).
Removing those two comments recovers the original source byte for byte; the
original measured package and failed lint result remain attributed correctly.

The CRC screen changes one compiler pragma while retaining eight lanes, the
64-byte group, table, threshold, fold and tail. Reduced TurboFan register-stack
traffic is a hypothesis, not a timing result: the loop also materializes state
array accesses and can impose cold/Liftoff overhead. Earlier paired-32-bit and
lane-count experiments were reviewed and not repeated.

The [combined artifact audit](https://github.com/ManabiIO/manabitan/actions/runs/46122561920)
is analysis only. All six original corpus artifacts are locked by run, source,
job, artifact ID, byte count and SHA-256. It reproduces the earlier prefix
known answer before accepting the recent-first calculation. The canonical
auditor is reused verbatim. Optional CRC preservation is not presented as an
independent correctness or performance audit.

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

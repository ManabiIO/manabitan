# Manabitan import component evidence — 2026-11-28 UTC

This branch preserves reproducible evidence for two small product proposals
against baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
The bundles support component improvements; neither establishes a complete
browser-import speedup. Product changes are on separate branches.
Both product PRs remain held drafts. The completed browser results below retain
the adverse timings and failed memory-coverage checks.

| Proposal                                                                                                                                            | Product commit                             | Measured scope                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Restore indexed compact score-key validation](https://github.com/ManabiIO/manabitan/commit/b15bad43acdfd54d541895cac1109c0e5ba51b2f)               | `b15bad43acdfd54d541895cac1109c0e5ba51b2f` | Approximately 1.57–1.60 ms saved per complete warm validation of 12 actual JMdict field buffers / 528,299 rows                         |
| [Use existing CRC tables for eight- and four-byte gap tails](https://github.com/ManabiIO/manabitan/commit/5909db31ebe859fce1cc4b38324271ddf9f3dd59) | `5909db31ebe859fce1cc4b38324271ddf9f3dd59` | 6.82–8.65% lower summed CRC phase in two complete sequential VNDB parser cohorts; the direct verifier interval includes no improvement |

## Evidence bundles

Read the component README before interpreting a timing result:

- [Score restoration scope, validation and reproduction](score-restoration-README.md)
- [CRC scope, weaker controls and reproduction](crc8_4-README.md)

Each `.tar.gz` has an external `.manifest.json` listing every member's exact
size and SHA-256 and binding the entire archive. The `.sha256` file binds the
archive and manifest. Extract into a new directory; original workspace-relative
paths are preserved. The retained packager verifies the archive without
extracting it.

The archives include frozen scripts, source identities, observations,
correctness checks, failed attempts and negative controls. Score's small actual
numeric inputs are included. Large dictionary ZIPs, source captures and build
dependencies have explicit hashes and reconstruction instructions rather than
being duplicated here. The CRC README discloses the missing exact-driver binding
for one early rejected slicing32 exploration.

## Hosted qualification

- [Score restoration study, run 46106456744](https://github.com/ManabiIO/manabitan/actions/runs/46106456744)
- [CRC study, run 46107723369](https://github.com/ManabiIO/manabitan/actions/runs/46107723369)

Both exact product-source validation jobs passed before publication. At package
preparation, the complete browser timing/restart/media/storage/memory matrices
were queued. The archived receipts state their observation time; future job
completion does not retroactively change those snapshots.

The larger enclosing Node timing changes are not attributed to these
components. The score loop's owning phases were flat, and CRC's unchanged
inflation phase also moved. Rejected CRC variants remain visible. Do not add
component timings to overlapping worker phases or apply their percentages to a
whole import.

## Held score-cache investigation

The [complete cache experiment readout](cache-held-README.md) preserves both
source revisions, all actual numeric inputs and all fixed observations. V2's
warm JMdict encoder improvement did not pass its predeclared common-path
criterion: all four upper bounds exceeded +5%, and the all-in-range control
showed a positive slowdown against both identical baselines. There is no cache
product PR. The conditional first-use study was never implemented or run.

The cache archive, external member manifest and checksum file are stored here
as `score-cache-held-evidence-20261128-1b47.*`. Its archive SHA-256 is
`3a2ef15ec420b06bcff2db905b69454520c291479ac6a20a6af1344b0788acda`.

## Other experiments and preserved failures

The [session investigation readout](session-held-README.md) covers the pipeline,
checkpoint, compression, inflater, glossary-reuse and parser experiments. Its
sealed archive preserves the status snapshot at 2026-11-28 06:32:35 UTC, including
all selected raw observations, controls, scripts, source bindings and failures.
Later browser results are identified separately; they do not rewrite the sealed
snapshot.

The session archive, external member manifest and checksum are stored here as
`import-session-held-evidence-20261128-1b47.*`. Its archive SHA-256 is
`eed792a9c77ffcdc65fcffa2106157b365dc8a56369a06bcd640d1b6ba060f8b`.

## Completed browser results through 06:46:37 UTC

The [browser-results addendum](browser-results-addendum-README.md) preserves the
later checkpoint JMdict/Jitendex and pipeline VNDB cohorts, including all raw
reports and 1,052 memory scans. The checkpoint candidate did not establish a
whole-import gain and is closed without a PR. Pipeline VNDB is a flat control
that does not activate the proposed overlap.

The immutable addendum archive, member manifest and checksum are stored here as
`browser-results-addendum-20261128-1b47.*`. Archive SHA-256:
`76b1ae9451052684192902916b5cdeb1e812ff806b064d0773e6d2bdf242ec98`.

## Complete checkpoint and pipeline data through 06:58:33 UTC

The [completed-browser raw-data addendum](completed-browser-raw-addendum-README.md)
adds pipeline JMdict and supplies the original raw members missing from the
earlier compact pipeline Jitendex and checkpoint VNDB audits. Together with the
preceding browser archive, it preserves all 156 reports, 156 canonical receipts
and 2,077 memory scan rows across the six completed cohorts.

The targeted JMdict pipeline route executed, but whole-import timing remained
flat. Its separate source-lifetime audit found no lost early-consumption signal;
route counters do not establish a useful overlap duration. Both the pipeline
and checkpoint experiments are closed without a product PR. Memory-coverage
failures remain visible and no failed observation was replaced.

The archive, member manifest and checksum are stored here as
`completed-browser-raw-addendum-20261128-1b47.*`. Archive SHA-256:
`f89e9cfcf6c20a65a248555dbf13150838404db326aaf389d517850fac7a9c30`.

## Score-restoration JMdict browser result

The [score JMdict browser addendum](score-jmdict-browser-addendum-README.md)
preserves all 26 completed reports and 250 memory scan rows, with the actual
packaged runtime bound to PR #978. Its paired median is -0.960%, with a
descriptive interval spanning zero and a more favorable identical-code control.
This does not establish a whole-import gain.

All recorded semantic checks pass. Candidate memory observation B2 exceeds the
fixed sampling-gap limit (252.093481 ms against 250 ms), so the complete memory
comparison remains unqualified. The separate 1.57-1.60 ms warm-validator saving
is unchanged. This addendum's cutoff predates the remaining two score cohorts,
whose completed results appear below.

The addendum also preserves a later read-only cross-file verification for the
seven completed cohorts and the reviewed auditors prepared for later results.
Preparation of an auditor is not a completed compression or CRC measurement.

The archive, member manifest and checksum are stored here as
`score-jmdict-browser-addendum-20261128-1b47.*`. Archive SHA-256:
`5d400949b03587909a973cac958b4276ddfe5adf6318427b01782e0fb044b4b0`.

## Completed score results across all three dictionaries

The [remaining-score browser addendum](score-remaining-browser-addendum-README.md)
preserves Jitendex and VNDB separately: 52 raw reports, 52 canonical receipts
and 846 memory scan rows. Both pass their original semantic and memory gates,
but neither establishes a whole-import gain.

Jitendex has an unresolved adverse signal: five of six candidate pairs are
slower, with +0.900% paired median and +3.387% equal-work timing. The complete
+17.679% fifth pair remains included. VNDB's paired median is -1.019%, with an
interval spanning zero and a more favorable identical-code control. Those
results do not cancel Jitendex's adverse evidence or JMdict's coverage failure.

PR #978 remains a held component-only draft. Its small warm-validator saving is
not a browser non-regression or merge-readiness claim. The addendum also explains
why the metric named `termRecordValidationMs` does not time the changed loop.

The archive, member manifest and checksum are stored here as
`score-remaining-browser-addendum-20261128-1b47.*`. Archive SHA-256:
`3153e88443f1712e78d2ed500585b81baa738ff3e651c50b228e5f48257d06b8`.

## Completed CRC browser results

The [CRC browser addendum](crc-browser-addendum-README.md) preserves all three
cohorts: 78 reports, 78 canonical receipts and 1,118 raw memory scan rows.
JMdict and Jitendex are flat inactive-path controls with passing original gates.

The active VNDB result is unfavorable on complete-import time: +4.643% paired
median, +6.423% equal-work change and a retained +19.351% sixth pair. Baseline A2
also exceeds the fixed memory sampling-gap limit, leaving that comparison
unqualified.

An added secondary analysis finds -4.049% median summed worker CRC-phase time,
with identical work counts; its identical-code controls also improve. This is
separate mechanism evidence, chosen while the cohort was running, and does not
replace primary timing or qualification. PR #979 remains a held component
proposal without a browser non-regression or merge-readiness claim.

The archive, member manifest and checksum are stored here as
`crc-browser-addendum-20261128-1b47.*`. Archive SHA-256:
`84d5ae1f80c2a5ccfb2981c71eb335b4320d09ec19c649884fb512e5a561d8c5`.

## Why JMdict gains stayed small

The [technical assessment](jmdict-technical-assessment.md) explains the measured
headroom, work shifted between phases, the narrow unmeasured overlap window,
and the failed score-cache/common-path tradeoff. It cites the frozen evidence
and distinguishes the separate scheduling proposal in PR #977.

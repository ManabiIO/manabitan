# Two frozen JMdict native component hypotheses

This is a diagnostic campaign, not a performance qualification or a proposed
production change. Baseline production JavaScript and dictionary fixtures remain
at `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The branch adds only this bundle and
its workflow. An unpublished three-candidate draft was withdrawn after finding
that its hint-local hypothesis already had equivalent production work under
separate qualification (product `486330b7`, run `46105416073`). That duplicate is
excluded; original draft bytes and every local observation remain retained. The two native source/module overlays are independent variants of
that baseline, not cumulative changes.

## Hypotheses and completed prerequisites

1. `recent-signature-prefilter`: a four-lane SIMD negative filter can skip the
   existing four-entry recent-signature search. Positive signatures still use the
   unchanged newest-first exact token comparisons; hash collisions do not dedup.
   The first four rows retain the scalar path. Production function 36 changes and
   the module grows 40 bytes. Focused production-parser probes passed 3,649 assertions
   across 398 observations. JMdict's untimed work census removes 1,466,996 scalar
   signature checks while adding 481,775 vector checks. That is work shape, not a
   latency estimate.
2. `equality-bounded-tail`: replace only the final zero-to-seven-byte equality
   loops with bounded 4/2/1-byte comparisons. Existing 8-byte and 32-byte loops
   remain. No load passes either valid span. Six existing callers grow, totaling
   811 bytes; no new helper appears. Exact production-body probes passed 3,588,886
   assertions over 859,932 cases. JMdict removes 2,494,234 individual comparison
   operations; early mismatches can read additional bounded bytes. Extra guards,
   reads and module size may offset the saved loop work.

Both variants passed full actual-worker output parity on all 7,613,164 rows
of the locked JMdict, Jitendex and VNDB archives. Separate instrumented modules
established work counts; only the uninstrumented production variants are timed.
Candidate source/module/build-receipt hashes are fixed in `protocol.json`.
Each hosted job rebuilds both modules with LLVM/LLD 21.1.8 and baseline
manifest arguments, requiring exact equality to the frozen module bytes.

## Fixed independent-host protocol

Two independently allocated hosted runners execute both candidates. One uses
the listed candidate order and six balanced `ABC/BCA/CAB/CBA/ACB/BAC` blocks. The
other reverses the candidate order and each complete 18-observation schedule.
`A` and `C` are identical baseline modules; `B` is that cohort's candidate.
There is one live Node 22.22.0 child at a time. Each child completes two excluded
full-corpus warmups, one timed full-corpus pass and one subsequent exhaustive
verification, then exits before the next child starts. Node defaults and empty
`NODE_OPTIONS` are required. No explicit GC or tiering options are used.

All plans are frozen before acquisition. Each cohort has 18 children and 72 full
passes; each host has two cohorts. Every failure and observation remains. A
failed cohort is never resumed or replaced; the other previously registered
cohorts are still attempted. There are no result-dependent sample counts,
candidate substitutions, parameter sweeps or retries. Local screens remain
separate observations and are not pooled with or replaced by this campaign.

## Boundary and interpretation

The frozen server executes actual production parser-worker transactions on
resident compressed term banks. It includes inflate/CRC, grammar/content/dedup,
lookup preparation, ownership copies and media-path projection. It excludes
archive loading, process/module startup, real IPC, concurrent parser scheduling,
compression, DB/OPFS storage, media-payload import, UI and lookup readiness.

Worker wall time and current-thread CPU are primary. Process CPU and all existing
internal phase wall timers are secondary. Phase sums may overlap; they must not
be added or called CPU time. Report every host/candidate separately, including
all B/A, B/C and identical C/A observations and tails. Movement in unchanged work
is evidence of host effects, not extra work removed by a candidate. These results
alone cannot establish a complete-import or memory improvement.

Every warmup, measured and verification pass has identical common work counters
and transfer bytes. Verification-only encoded-byte totals are compared only
between exhaustive passes. The subsequent verification digest covers every
output in the production worker boundary. Runner, source, module, fixture and
Node hashes are bound at admission; the campaign verifies frozen inputs before
and after every cohort. `summarize.py` rereads all raw child reports and rechecks
their hashes, observation flags, parity counters and copied measurements before
aggregating all prescribed ratios.

The artifact retains complete context, compiled modules, source identities,
individual logs, all child reports, complete or failed cohort records and strict
summaries. Promotion requires further complete-import qualification and normal
repository validation if these independent component results justify it.

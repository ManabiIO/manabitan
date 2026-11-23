# Further import qualification, 2026-11-23

This campaign compares frozen current develop
`467067650653c37c1f7d6b05d6737d070e1259cd` with shared owned content plus consumed
compression-reference release at `e0cde0e1e387606f4c9f1f970c738c42fb986484`.
The hypothesis is that passing immutable, independently owned shared content to
compression workers removes the main-thread packing copy without retaining a
materially larger process footprint. Runtime identity, all three packaged-file
differences, fixtures, schedule and criteria are frozen before acquisition.

The source snapshot already contains the qualified large-import index worker and
exact source CRC reuse, strict native row parsing, bulk metadata publication,
consecutive reference validation, coalesced source reads and current VNDB media
validation. Earlier results against older baselines are not pooled into this
campaign. The updated JMdict and Jitendex fixtures also differ from the earlier
round; VNDB archive bytes are unchanged.

## Acquisition-budget revision, frozen before candidate results

The original unchanged discovery is retained at
<https://github.com/ManabiIO/manabitan/actions/runs/45215444963>. No candidate
performance output from that campaign was opened or used to select this revision.
The independently completed baseline diagnostic showed that exhaustive VNDB
readback costs approximately 373 seconds per observation, including only about
8 seconds of actual import. Twelve or twenty-one such observations exceed the
original 45-minute job budget. The original campaign may time out before artifact
upload; its original job logs and any surviving partial artifacts remain evidence,
not substitute performance observations.

This separate, prospectively declared acquisition revision preserves all runtime
code, fixtures, timing boundaries, schedules, controls, metrics and promotion
criteria. JMdict/Jitendex retain complete media verification after every import.
VNDB verifies all 146,570 images on the first A and first B warmups of each cell;
the C warmup and every measured import verify exactly the same 64 deterministic
images spanning the sorted complete source list through the existing benchmark
sample mode. Complete counts, restart checks and sampled full public responses
remain mandatory on every import. Both full and sampled media digests are
independently derived from the complete source before acquisition. Each job has a
60-minute budget. Failed or partial original observations are never pooled into
this revised campaign.

## Fixed timing protocol

| Stage          | Excluded warmups | Measured triplets            | Imports per corpus |
| -------------- | ---------------- | ---------------------------- | -----------------: |
| Discovery      | A, B, C          | ABC, BCA, CAB                |                 12 |
| Confirmation 1 | A, B, C          | ABC, CBA, BCA, ACB, CAB, BAC |                 21 |
| Confirmation 2 | C, B, A          | BAC, CAB, ACB, BCA, CBA, ABC |                 21 |

A and C use the identical baseline package; B uses the frozen candidate. Every
observation imports the complete locked archive in a fresh persistent Chromium
profile, then verifies public lookups and restarts the browser. The authoritative
boundary is file-input change through post-UI import completion, using the
browser's monotonic clock. Builds, downloads, reference derivation, restarts and
readback are outside timing. No tracing, process sampling, experimental import
flags, headed fallback or security bypass is enabled. Node is exactly 22.22.0 and
Chromium follows the identical dependency lock.

Discovery advances only with at least one corpus having median paired B/A and
B/C changes of at most -5%, improved equal-work totals against both controls and
at least two of three faster pairs against each. A material regression in another
corpus blocks promotion pending independent confirmation. Discovery alone cannot
support a production speed claim.

Confirmation uses two independent jobs per corpus, retaining every predeclared
observation. Both replications must independently retain at least 5% median gains
against A and C, favorable equal-work totals and five of six faster pairs against
each in a benefiting corpus. No corpus/replication may retain a 5% median
regression. Report the C/A identical-code controls separately; never subtract
control drift or pool runners into a preferred point estimate.

Every warmup, tail, failure and partial schedule remains in the original artifact.
No retries, replaced observations, result-dependent extensions or metric changes
are allowed. A failed command stops its cell, and an incomplete cell cannot pass.

## Correctness and provenance

The complete package-member maps must have exactly the frozen differences in
`config.json`. Every arm receives the same measurement overlays. Source and
package identities, browser versions, fixture bytes and sizes, host snapshots,
raw reports, logs, source copies and every acquisition are retained. Both source
trees must match the frozen dependency and timing files.

All row/media counts must match before and after restart. Twelve deterministic
source-derived terms retain complete public exact-lookup responses before and
after restart. Every response field must match across restart, arms, warmups and
observations, with no empty lookup or degraded dictionary availability. Existing
six-pass lookup receipts must hash those same full responses. These are sampled
semantic checks, not exhaustive all-term browser readback. Stable same-package
physical probes are required; across packages only encoded-reference offsets,
raw previews and their independently recomputed preview counts may differ.

The current production benchmark's exhaustive media verification is retained
for every Jitendex import and each cell's first A/B VNDB warmups. All 236
referenced Jitendex images and all 146,570 VNDB images are compared byte-for-byte
to the locked original ZIP after restart in those designated observations. Before any observation,
an independent Python reader traverses every term bank to prove that the exact
selected image set equals all source references, verifies unused-image exclusions,
checks total bytes, reads every original image and computes the same framed
path/size/SHA-256 digest. The browser receipt must match that independent source
full or sampled digest according to the frozen observation schedule. JMdict's
zero-image set is also validated. This strengthens the earlier
campaign's five-image VNDB sampling. All media work is outside import timing.

The source media byte counts are 0 / 4,992,155 / 188,131,284 for JMdict, Jitendex,
and VNDB. The row counts are 528,299 / 436,555 / 6,648,310. These remain bound to
exact SHA-256 values in the fixture lock.

## Separately frozen memory requirement

The earlier shared-buffer candidate had a measured memory cost. This revision
requires a separate process-tree study before promotion, with no memory sampling
in the timing cohort. Its prospective schedule is two independent jobs per
corpus: ABBA in replication 1 and BAAB in replication 2. All eight imports per
corpus use fresh profiles, producing four fixed adjacent A/B pairs; there are no
warmup exclusions, replacements or adaptive extensions.

The observer measures Linux process-tree PSS and private bytes in an explicit
window from immediately before file-input dispatch through observed UI completion.
It starts discovery before that window and retains coverage evidence around both
boundaries. Sampling waits 25 ms between non-atomic scans. Browser seeds are
identified by executable path; every discovered descendant is included regardless
of process title. PID/start-time/parentage and metadata must be stable around each
scan. Unreadable live address spaces and identity coverage failures fail closed.
Only the previously reviewed exact single-thread exited-zombie exception may be
used; failures and original records remain retained, without invented zero values.

Each observation requires at least five fully covered scans within the window,
no gap above 250 ms between qualified scan midpoints or either boundary, and
qualified bracketing scans ending before start and beginning after completion
within 250 ms. Invalid coverage produces null maxima and cannot qualify a pair.
Every observation must qualify. Each replication's median paired maximum sampled
PSS and private-byte increases must be at most 5%, with no individual pair above
10% on either measure. All maxima, pairwise changes and tails are reported.
These limits are prospective screening criteria; sampled maxima are not true or
atomic peaks and cannot establish exact peak-memory nonregression. Any failure
blocks promotion rather than triggering reruns to obtain a preferred result.

## Run

The dedicated study workflow launches on `perf/import-*-study-20261123-72c24`.
The memory observer is a separate workflow and evidence stream, implementing the
prospective protocol above. Ordinary baseline diagnosis was separately frozen at
`b34633bc4f4211491cbc651c29c27a5ca1bc30a4`; traced diagnostics never enter timing
qualification. Local browser startup is blocked by socket permissions, so hosted
Actions provide actual browser execution without a security bypass.

```sh
node --test dev/perf/import-study-20261123/verify.test.mjs
python3 dev/perf/import-study-20261123/test_media_reference.py
python3 dev/perf/import-study-20261123/run.py --matrix
```

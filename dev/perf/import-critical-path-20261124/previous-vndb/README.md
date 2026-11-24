# Recovered VNDB results and current PR survey

Recovered on 24 November 2026. No product changes, GitHub writes, reruns, or new
performance cohorts were made during this audit.

## Completed VNDB cohorts

Both previously pending cohorts completed the original 23-observation protocol:
three warmups, six balanced A/B/C blocks, and separate exhaustive media checks
for A and B. Both pass the unchanged independent auditor, including source,
package, harness, fixture, observation-order, timing-boundary, lookup, restart,
and media checks. A and C are unchanged baseline builds; B is the candidate.

| Candidate                            | B/A paired median | B/C paired median | Control C/A median | A/B/C arm medians     |
| ------------------------------------ | ----------------: | ----------------: | -----------------: | --------------------- |
| UTF-8 loop, PR #858                  |           +0.539% |           +0.159% |            +0.826% | 4432 / 4448 / 4428 ms |
| Guarded media ranges, former PR #853 |           -0.624% |           -0.649% |            -0.590% | 6458 / 6446 / 6446 ms |

Neither cohort establishes a meaningful import-speed improvement. The UTF-8
candidate is neutral relative to control variability; these data also do not
establish a material regression. The media change retains its verified logical
read reduction, but its complete-import difference overlaps the control change.
Do not compare absolute times across the two independently hosted cohorts.

Every exhaustive diagnostic reads all 146,570 referenced VNDB images,
188,131,284 bytes, with the same digest:
`ea94d392bc833baf0bee7b3d6becc3d3517eee84ee314a44986438ac6d5217cb`.
Native observations have two recorded OPFS byte totals, 8,192 bytes apart;
semantic/media results match. Raw storage layout is retained as a diagnostic,
not treated as an equality gate.

Original GitHub ZIP SHA-256 values match the artifact API digests. The two
deterministic bundles in `bundles/` retain all complete per-observation JSON
summaries and raw phase reports byte-for-byte, with member manifests. The bundle
audit also passes. `completed-vndb-audit-missing-baseline.json` preserves the
first setup failure when the fresh clone lacked the historical Git objects;
fetching the exact baseline resolved that prerequisite without changing inputs.

## Current repository state

The surveyed develop head is
`698d685c21618a8e8dbdab7a49a8dcf0d30680eb`.

The earlier catalog and media changes are already integrated through merged
PR #867. Their original PRs #852/#853 were closed. Also merged since the previous
baseline: #851 (packing overlap), #866 (deferred speculative warming), #849
(direct record columns), #857 (media preparation objects), #860 (source group
activation), #861 (source-window policy), and #844 (active index budget).

`pr-map-20261124.json` records all 26 open proposals and recent closed/merged
proposals. `open-pr-files.json` retains their exact file lists and available
patches. Important occupied areas include parser key/sequence micro-optimizations,
native journal/scanner counters, worker media projection, content ownership,
parser admission, record-field runs, and media path/requirement allocations.

No surveyed open PR touches `_createLookupIndexChunk`, vectored lookup-sidecar
appends, or the header/payload/record-fields concatenation. The sink agent's
proposal to remove this copy is distinct from #764/#820/#854/#855, which touch
other record-store paths. This is a scope finding, not a performance result.

## Diagnostic direction

`vndb-phase-medians.json` reports all six measured observations per arm from both
historical cohorts. In the media study's baseline A, median term-record field
encoding is 573 ms, full record encoding 753 ms, record writing 650 ms, and lookup
index encoding 823 ms. Worker result-copy intervals sum to 2966 ms. These are
larger targets than the roughly 117 ms media-resolution phase.

The intervals overlap across workers and the ordered sink. They are neither
CPU time nor additive critical-path time. Current develop has additional merged
optimizations, so fresh profiling must confirm the opportunity before choosing
or claiming a new optimization.

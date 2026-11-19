# Temporary escape-hint confirmation

This branch is a follow-up to the frozen hosted study tree at local commit
`673cb061874bfd18c6939ce5e84ce0729fad71c4` (remote study commit
`93610119ac4e05b113bd33d3b2304030ab5a3fcd`). It reuses the exact existing escape-hint native bytes, measurement
runners, validator and analysis helper. It changes no product optimization.

Only branch `perf/jmdict-hints-confirm-20261119` triggers the temporary workflow.
The job runs on Ubuntu 24.04. It has a 25-minute job limit and stops starting work
at minute 22 to reserve time for artifact retention. This worktree is prepared
for review; it has not been published or run locally.

## Fixed component plan

Each row runs in a fresh process, with 6 pairs, 6 fixed warmup pairs, 5 complete
passes per arm, and flags `{}`. Each report retains the full before/after byte
oracle, all raw groups, and all observations. The first row is an unchanged-code
control. The remaining cells cross source role and initial group order.

| Cell | Source A | Source B | Initial order | Candidate arm |
| --- | --- | --- | --- | --- |
| control | baseline-a | baseline-b | AB | none |
| hints-b-ab | baseline-a | escape-hints | AB | B |
| hints-a-ba | escape-hints | baseline-a | BA | A |
| hints-a-ab | escape-hints | baseline-a | AB | A |
| hints-b-ba | baseline-a | escape-hints | BA | B |

Runner summaries retain their original B/A convention. For candidate-in-A cells,
normalize individual paired ratios to candidate/baseline before combining cells;
do not negate a percentage or invert an even-sample median summary. The index
records both source roles and candidate arm explicitly. Keep the original study
screen separate from this confirmation. A failed noise control or disagreement
between cells makes the confirmation inconclusive.

## Fixed browser plan

Build only `baseline-a`, `baseline-b`, and `escape-hints`, before any timing.
Run a fresh-browser A/A comparison followed by the escape-hint comparison. Each
uses four pairs in order `A1 B1 B2 A2 B3 A3 A4 B4`, one import per observation,
production defaults, the pinned JMdict archive, and fresh browser profiles.
No native compilation or optimization-source changes occur in the workflow.

## Evidence and failure handling

The workflow retains every command and log, frozen source snapshots, candidate
native files, package entry hashes, actual packages, full component reports,
independent group validation, fixed-seed paired analyses, browser reports and
status/error records. Component evidence uploads before browser work, and the
full upload runs even after failures. Each phase driver is also saved with `tee`.
Only prepared worktrees are measured, and identities are checked before and after
observations. The original hosted-study branch is unchanged.

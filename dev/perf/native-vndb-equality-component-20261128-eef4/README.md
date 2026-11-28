# Frozen VNDB equality-tail component diagnostic

This prospective study tests one unchanged native hypothesis on the complete
locked VNDB term corpus. It was prepared before observing the pending JMdict
hosted campaign. It does not repeat that campaign or modify its source, jobs,
conditioning, observations or interpretation.

The production baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The only
candidate replaces the final zero-to-seven-byte remainder loops in two equality
helpers with bounded 4/2/1-byte comparisons. Existing 8-byte and 32-byte loops,
read bounds, lookup/content semantics, cache policies and JavaScript are fixed.
Its source SHA-256 is
`9570174624c1076825ed3ad569730371f9c75fd6d28d0032d4cf42db5013ea32`;
its shipping module SHA-256 is
`a921cc6b71fb5fc59d22ab769416db6fbe9a6a5e5cedfa705ae3cace16ffefe7`.

## Motivation and completed prerequisites

The retained untimed VNDB census removes 61,315,043 individual byte-comparison
operations, reducing 103,926,153 byte comparisons to 42,611,110 bounded word/byte
comparisons. The same implementation removes 2,494,234 in JMdict. These counts
are not time estimates. There are 14,231,639 zero-tail encounters; early
mismatches can compare 2,359,040 extra byte positions per operand. Added width
guards, bounded wider reads, and 811 additional module bytes may offset the
saved loops. Corpus-verification durations are not interpreted as performance.

Exact production-body probes passed 3,588,886 assertions across 859,932 cases.
Actual production-worker parity passed all 7,613,164 rows across JMdict,
Jitendex and VNDB. The isolated source commit also passes 65 new public-API
regressions, 118 existing key regressions, scoped repository lint, narrow test
types, the pinned rebuild, all 670 unit-test files (15,200 tests passed and
47 existing skips), and the all-target dry build. The public regressions use
existing exports and cover physical memory ends, every short tail width,
unequal keys, current hash collisions, content-signature collisions and native
fallback. `prerequisites.json` binds the retained proof and source receipts.

Only the uninstrumented frozen module is measured. Each host rebuilds it with
LLVM/LLD 21.1.8 and the baseline manifest arguments and requires byte equality.
The published branch contains only this diagnostic bundle and its workflow;
production JavaScript, libraries, policy and dictionary lock remain at baseline.

## Fixed schedule

Two independent hosted jobs run forward and reverse schedules. Each runs exactly
six balanced blocks: `ABC/BCA/CAB/CBA/ACB/BAC` in forward order. Reverse means
reversing the complete 18-observation sequence, including both the block order
and the order within each block. A and C are identical baseline modules; B is
the single equality candidate. There is one live child at a time.

Every fresh Node 22.22.0 child completes two excluded full-corpus warmups, one
timed full-corpus pass, then one exhaustive verification pass before it exits.
Each host therefore has 18 children and 72 full passes. Node defaults and empty
`NODE_OPTIONS` are required. No GC/tiering overrides, retries, replacements,
extra observations, adaptive stopping or source/parameter changes are allowed.
Every original failure and observation remains in the uploaded artifact.

The complete fixture has 6,648,310 rows and a 291,705,969-byte archive, SHA-256
`da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`.
The expected full-output digest is
`fa7435ef7e6f3583e3f06e971c889d02122f899a92ec438d313edbd5a889b3cf`.
The existing three-worker grouping policy produces 170 groups; the component
executes them serially within the actual production worker implementation.

## Admission and retained evidence

`preloaded-worker-server.mjs`, `run.py`, `summarize.py`, and `campaign.py` are
byte-identical to the already registered JMdict bundle. The preparer changes
only the old two-variant assertion to require the single equality candidate.
Its existing dictionary binding is generic. Runner, source, module, build
receipt, fixture, Node executable and baseline source identities remain bound
before and after the cohort.

The protocol additionally records the exact five ordinary work counters, seven
verification counters, transferred-byte total, group count, grouping metadata
and hash of the complete bank grouping from the retained untimed VNDB baseline
proof. These are independent offline audit admissions. The unchanged controller
already compares the complete work/transfer values across every warmup, timed
and verification pass; the separate artifact auditor also binds them to these
preregistered values. The grouping hash is SHA-256 over compact UTF-8 JSON of
`grouping.groups`, with no newline; all bank names are ASCII.

The artifact retains context, compile logs, exact modules and sources, frozen
plans, original build/source receipts, every child report/log, complete or
failed campaign records and strict summaries. No existing campaign or source
commit is replaced.

## Boundary and interpretation

This is the actual production parser-worker component with preloaded compressed
banks: inflate/CRC, grammar/content/deduplication, lookup preparation, ownership
copies and media-path projection are included. Archive loading, process/module
startup, real IPC, concurrent worker scheduling, DB/OPFS, compression,
media-payload import, browser UI and lookup readiness are excluded.

Worker wall time and current-thread CPU are primary; process CPU and all
existing internal phase wall timers are secondary. Phase timers may overlap
and are not CPU measurements. Report each host independently with every B/A,
B/C and identical C/A observation and tail. No local screen or other-host
result is pooled into this campaign. A component result alone does not
establish complete-import speed or peak-memory improvement; those require
independent browser qualification if this fixed diagnostic warrants it.

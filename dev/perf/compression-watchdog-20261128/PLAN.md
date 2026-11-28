# Compression watchdog browser screen

## Frozen source and scope

A is the unchanged original product baseline
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. C uses the exact A package,
runtime, flags, and source under a separate observation label. B is the exact
pushed workflow commit, recorded as `github.sha` before acquisition, and has A
as its sole parent. The only changed packaged entry is
`js/dictionary/zstd-term-content.js`.

The candidate changes one compression-pool alarm for each dispatched job into
one alarm for a continuously busy pool epoch. Each job keeps an immutable
deadline measured from dispatch, with the original 60-second timeout duration.
When the alarm fires, the pool checks the earliest remaining deadline and either
fails the entire pool or re-arms for that original deadline. Completing an
earlier job does not extend a surviving job's deadline. A source-consumed
acknowledgement leaves the terminal deadline active. Pending-empty and disposal
paths invalidate the alarm owner before cancellation, fencing stale callbacks
across later idle reuse. Dispatch and timer-allocation failures retain source
and completion rejection/drain behavior.

Worker count, scheduling, compression inputs and bytes, messages, readiness
timeouts, cancellation polling, source-consumption ownership, persisted formats,
and the public completion boundary retain their current behavior. The runtime
has no experiment flag or extra measurement counter. No timeout duration, size
threshold, worker policy, or corpus-specific branch is tuned.

The runtime SHA-256 is
`a2fa0c8eb60aa4701d9ee93822654bb553309e43f8247e4be0da1879cf7e0de8`;
the focused test SHA-256 is
`49dbb06e215c094dd23acd50165656bc192a3351ccf80ef235d87eed32aaef63`.
`verify-source.py` checks the exact five-file source boundary, sole parent,
frozen runtime/test bytes, and unchanged qualification and observer sources
before every hosted job. The common qualifier independently builds A and B and
checks the exact one-entry package delta.

## Local correctness and work-count evidence

All 40 focused tests pass, including 11 new watchdog behavior cases and the
existing pool, drain, and packed-dispatch suites. The new cases cover
out-of-order completion, immutable deadlines after the first job finishes,
early alarm firing, stale callbacks after idle reuse, first and later dispatch
failure, first and re-arm timer allocation failure, source-consumed semantics,
and disposal. Scoped lint passes. Independent source review found no blocker.
Full units, main and test type checks, and all-target dry build are required
hosted gates, not claimed local results.

One untimed complete current-source JMdict import through the production-parser
and compression-worker sink adapter matched the retained clean baseline:
528,299 rows, 103 actual compressed frames, 362,032 unique reference columns,
finalized content/record/lookup output, and 15 live lookups. Only the existing
documented random generation field was normalized for the finalized record and
lookup-file comparison. The adapter uses in-memory SQLite and file-backed OPFS;
it is not a browser timing experiment.

That import dispatched 103 jobs over 12 busy epochs, with peak pending depth 10.
The candidate installed 12 alarms, cleared 12, fired none, and left none
outstanding. The retained raw browser events contain 103 installs plus 103
clears for the byte-identical original pool class, consistent with the current
baseline's 103-job output census. This schedule removes **182 timer API calls**.
The candidate adds **115 monotonic-clock reads**: 103 dispatch deadline captures
and 12 alarm-delay calculations. It creates 12 small alarm-owner objects and
performs no deadline scan unless an alarm fires. These counts are a hypothesis
about work reduction; they are not a speed measurement. Historical timer sample
weights are not used to estimate a speedup.

The original tests-first baseline run had four expected failures and five
passes; the original lint attempt reported restricted direct clock access and
missing documentation annotations. Those attempts and every subsequent local
test, lint, and replay log remain preserved with source-bound receipts in the
session evidence. No failed observation was deleted or replaced.

## Frozen hosted acquisition

Keep `dev/perf/import-qualification-20261125-a7f7.py`, its receipt and memory
validators, the browser observers, setup action, package lock, and fixture lock
unchanged. Use production defaults with no flags or worker-policy override.

This screen has exactly two independent `ubuntu-latest` comparison jobs:

| Dictionary | Initial order |
| ---------- | ------------- |
| JMdict     | AB            |
| Jitendex   | BA            |

Each job uses the existing unchanged qualifier schedule:

- Four warm-up imports, two per arm in opposite orders.
- Twelve paired A/B observations with alternating order.
- Four interleaved A/C control pairs, with C identical to A.
- Two separate exhaustive-media imports after all timed observations.
- Four separate memory observations using the existing ABBA or BAAB order.

Use pinned Node 22.22.0, lockfile-matched Chromium, independently built exact
packages, fresh browser profiles, and strict production runtime verification.
The primary endpoint is the existing complete import interval from file-input
change through completed import UI, including initialization and publication.
Lookup/restart, content, metadata, storage, exhaustive media, and whole-process
memory checks remain gates. The distinct correctness job on `ubuntu-26.04`
runs the complete unit suite, main and test type validation, changed-source
lint, and the all-target dry build.

Retain every warm-up, measured pair, control, media and memory observation,
including incomplete and failed attempts, together with all raw output,
packages, source identities, and logs. Use only the original push run. Do not
rerun, replace, discard outliers, tune the candidate, subtract controls, pool
hosts, or substitute instrumented timing. A failure leaves the planned cell
unqualified; it does not authorize a replacement observation.

## Prospective nomination policy

This screen can nominate a dictionary target for independent confirmation; it
cannot support a product PR. A target is nominated only if all of these hold:

- Complete-import paired-median change is at most **-2%**.
- B is faster in at least **9 of 12** measured pairs.
- Absolute identical-code A/C paired-median change is at most **1%**.
- Absolute identical-code A/C equal-work change is at most **1%**.
- All source, runtime, correctness, exhaustive-media, and existing memory gates
  for that cell pass, and the separate correctness job passes.

Report all paired ratios, equal-work ratios, identical-code controls, and the
qualifier's descriptive bootstrap intervals even when a gate fails. The A/C
limits govern escalation only; they do not modify the common qualifier, remove
observations, or adjust the measured effect. A result below the fixed benefit
gate or with unstable controls is retained without nomination.

Any nominated target needs a newly frozen, independent full six-cell
confirmation covering JMdict, Jitendex, and VNDB in both initial orders, with a
prospective target and regression policy. This two-cell screen will not be
pooled with that confirmation, treated as a replication, or used to open a PR.

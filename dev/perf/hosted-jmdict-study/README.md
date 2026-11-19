# Temporary browser confirmation

This follow-up starts from frozen local study commit
`673cb061874bfd18c6939ce5e84ce0729fad71c4`, corresponding to remote study commit
`93610119ac4e05b113bd33d3b2304030ab5a3fcd`. It reuses the exact native source,
manifest, WASM artifacts, lockfiles and browser harness. No optimization changes
or native compilation occur.

Only `perf/jmdict-browser-confirm-20261119` triggers this workflow. It runs on
Ubuntu 24.04 with a 20-minute job limit and 17-minute command deadline, reserving
three minutes for artifact retention.

## Fixed plan

Build only baseline-a, baseline-b, numeric-spans and bounded-key-reuse, before
starting any measurement. Run these comparisons in the declared order:

| Comparison | Source A | Source B | Pairs |
| --- | --- | --- | --- |
| Fresh A/A control | baseline-a | baseline-b | 4 |
| Numeric spans | baseline-a | numeric-spans | 8 |
| Bounded key reuse | baseline-a | bounded-key-reuse | 8 |

For pairs 1–4 the observation order is `A1 B1 B2 A2 B3 A3 A4 B4`. The two
candidate comparisons append `A5 B5 B6 A6 B7 A7 A8 B8`. Each observation runs
one import in a fresh browser process/profile, with production defaults, strict
runtime qualification, and the locked JMdict input. There is no component timing.

Full UI completion time and worker import time remain separate measurements.
The original selection screen is not pooled into the confirmation. Retain every
observation and failed attempt; do not replace slow observations or subtract GC.
A failed control or inconsistent candidate pairs limit the conclusion.

## Identity and evidence

The proven study driver checks frozen input hashes, native source/manifest/WASM
identities, complete package entry differences, fixture identity and actual
package hash before/after each observation. All four packages are built before
any browser work. The two baseline packages must have identical entry bytes;
only parser WASM and its C source may differ in a candidate package.

The final artifact always retains preparation state, exact sources/packages,
all browser reports, command identities, host metadata, stdout/stderr logs,
partial indexes and failures. The internal deadline records later commands as
not started instead of silently truncating the plan. Phase-driver logs use tee.
The original study and escape-hint confirmation branches remain unchanged.

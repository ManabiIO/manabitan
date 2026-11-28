# Write-side lookup checksum qualification

## Frozen candidate and control

The original product baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
The measured A control is **`5ac6a79d9bcf99673922df2c39174078dccbb62d`**,
an asset-only child of that baseline. Its tree is
`9dbe15e3ffaf95fabd1c819db07ee905ff9c2874`, identical to the locally tested
asset-control commit `374d11a508acb2bd59c51ff48e5c4233fa948af5`.

A adds the inactive checksum helper, C source, recorded WASM artifact, and build
registration. Every pre-existing extension source and manifest remains identical
to the original baseline. In particular, A has the original store and database
files, with no import edge to the new helper and no checksum module fetch,
compilation, instantiation, or native checksum call. This packaging-equivalent
control is necessary because the unchanged qualifier requires identical package
member names. It does not charge any candidate initialization work to A.

B is the exact pushed workflow commit, recorded as `github.sha` before any run.
It descends from A and integrates the immutable helper into import sessions.
The eight A asset/build files must remain byte-identical in B. The only changed
packaged entries between A and B are:

- `js/dictionary/term-record-opfs-store.js`
- `js/dictionary/dictionary-database.js`

The eventual product diff against develop includes the helper, C source, and
WASM asset. A passing experiment is not permission to present A as the original
baseline commit. `verify-control.py` proves the complete source boundary before
each hosted cell; the existing qualifier independently builds both packages and
checks the exact member set and changed-entry allowlist.

## Runtime behavior

The candidate changes only write-side checksums for the base lookup index,
derived lookup index, and authoritative record fields. The persisted algorithm
remains XXH32 with seed `0x811c9dc5`. Read-side checksums, parser hashing,
compression, and persisted formats retain their existing implementations.

The new standalone SIMD artifact is 581 bytes, SHA-256
`8a72dd1c196cd1d108340990c5bfe5cb175fba6046dc25f0859f930d192c7e81`.
Both pre-existing native artifacts retain their original hashes. The native
source manifest covers fifteen C/header inputs and all three targets.

An import starts optional asynchronous initialization without awaiting it.
Only the compiled module is cached across imports. Each import receives its
own private instance and memory, bounded by 16 MiB of input scratch plus two
64 KiB pages. Each synchronous call copies the current exact byte view before
hashing; no checksum is reused across mutable-buffer handoffs. Pending or failed
initialization, unsupported SIMD, oversized inputs, shared buffers, unusual
views, or failed growth retain the existing JavaScript checksum path. The size
cap bounds memory and was not selected by tuning corpus timing.

Session identity rejects late initialization after end, abort, reset, or a later
import. Successful finalization retains the instance through final flush and
disposes it in `finally`. Rollback invalidates it before cleanup awaits. No new
await, worker ownership, file publication, or rollback boundary is introduced.

## Prospective hosted acquisition

Keep `dev/perf/import-qualification-20261125-a7f7.py`, its canonical receipt
validator, all existing browser observers, and the fixture lock unchanged.
Use the existing production defaults with no flags or worker-policy override.

For each of JMdict, Jitendex, and VNDB, acquire independent `AB` and `BA` cells on
separate `ubuntu-latest` hosted jobs. Each cell uses the existing schedule:

- Four warm-up imports, two per arm in opposite orders.
- Twelve paired A/B observations with alternating order.
- Four interleaved A/C control pairs, with C using the exact A package.
- Two separate exhaustive media imports after all timed observations.
- Four separate memory observations with the existing `ABBA` or `BAAB` schedule.

Use pinned Node 22.22.0, lockfile-matched Chromium, exact independent package
builds, fresh browser profiles, and strict production runtime verification.
VNDB prospectively uses `--vndb-sah-allocation-units 37 37`, matching the current
baseline cohort; exact storage equality remains required. Every completed,
failed, and incomplete observation is retained. There is no selective rerun,
outlier deletion, cross-host pooling, or substitution of instrumented timing.

The primary endpoint remains file-input change through completed import UI,
including initialization and final publication. Existing lookup/restart,
content, metadata, storage, media, and whole-process memory checks remain gates.
The separate correctness job runs on `ubuntu-26.04` and requires the pinned
Clang/LLD rebuild check, complete unit suite, type validation, changed-file
lint, and all-target dry build.

## Actual-path witness

The candidate records three counters in existing bulk-finalization debug
details: `termRecordLookupChecksum.nativeCalls`, `nativeBytes`, and
`javascriptCalls`. They count the actual three checksum calls for each written
lookup chunk. The counter work and optional module startup remain inside the
measured candidate. The unchanged browser observer reads those existing debug
details only after timing ends.

`audit-activation.py` reads the original `run-1.json` from every scheduled
observation. Every B import must report positive native call and byte counts;
all fallback calls are reported and retained. A/C must have absent or zero
native counters. The total checksum call count must be divisible by three.
An all-fallback candidate run fails path qualification; it is not dropped or
replaced. A separate diagnostic run cannot stand in for activation in a timed
run. The existing canonical receipt comparison includes semantic outputs, not
bulk-finalization diagnostics, so these added counters do not weaken or alter
cross-observation correctness checks.

## Prospective publication decision

VNDB must improve by at least **2% paired median** and be faster in at least
**9 of 12 pairs on each host**. Both hosts must support that conclusion, with
the identical-code controls, equal-work ratios, and bootstrap intervals
reported alongside it. Component speed alone does not satisfy this gate.

JMdict and Jitendex must have no repeatable paired-median regression above 3%.
Any unexplained regression or contradictory host/control behavior holds the PR
for review of the evidence. All correctness, actual-path, and existing memory
gates must pass. If the whole-import benefit is too small or uncertain, retain
the experiment and do not open a product PR.

## Evidence available before acquisition

Local complete sidecar reconstruction through the actual writer and standalone
module reproduced every byte and final SHA for JMdict (528,299 rows, 12 chunks)
and VNDB (6,648,310 rows, 192 chunks): 612 native checksum calls, zero fallback.
The 53 focused tests cover artifact binding, independent unsigned hash vectors,
unaligned views, SIMD tails and memory boundaries, mutable input reuse, shared
and unusual views, growth/load failure, optional initialization, stale session
completion, final-flush lifetime, and existing compact-score validation.

The earlier copy-inclusive kernel screen found approximately 69.5 ms of warmed
VNDB CPU savings and 3 ms for JMdict. Those are component observations on a noisy
shared host, not browser import claims. Relative to the available diagnostic
Node import walls, the saved time is only about 0.65% and 0.3%, respectively.
The loader comparison measured a real cold cost: tiny-module import plus
file-backed initialization had median 1.69 + 4.48 ms, while the parser-helper
alternative had 9.47 + 5.34 ms. Cached private-instance initialization was
0.088 versus 0.113 ms. The tiny module's first checksum chunk was slower than
the parser alternative in that cold diagnostic (3.22 versus 2.32 ms). These
limits motivate the explicit hosted decision gate and the absence of a PR now.

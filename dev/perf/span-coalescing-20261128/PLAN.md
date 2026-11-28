# Bounded compression span coalescing

## Frozen scope and attribution

Baseline A is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Candidate B is the
exact workflow commit. Control C uses A's source, package, runtime, and flags.
The only expected changed packaged entry is
`js/dictionary/term-content-block-store.js`.

This isolates the compression descriptor coalescing from
[PR #764](https://github.com/ManabiIO/manabitan/pull/764), specifically source
commit
[`1e82e1a237410c5a850661c1c361c444fa624546`](https://github.com/ManabiIO/manabitan/commit/1e82e1a237410c5a850661c1c361c444fa624546).
That prior stack combined several changes and did not complete a browser
qualification of this mechanism. Its metadata publication, native read
checksum, and cache changes are excluded here.

The original coalescing policy remains unchanged: at most 4,096 runs, with a
run capacity of `floor(originalSpanCount / 4)`. The planner merges adjacent
source spans only within an existing compression block. It abandons the
compact descriptor columns when the run budget is exhausted. The two
temporary offset and length columns together are bounded by 32 KiB.

The original row block indexes, block lengths, row references, compression
level, dictionary, worker count, worker ownership barriers, and fallback
source descriptors remain unchanged. Workers receive fewer descriptors for
the same bytes, reducing their metadata copy and repeated span validation
work. No speedup has been established by the local checks.

## Eligibility and ownership review

The port establishes a local eligibility witness before either public span
entry point performs validation or selection. Source and metadata views
must have ordinary typed-array prototypes, the correct intrinsic element
kind, and no shadowed length, buffer, byte offset, or byte length properties.
The metadata buffers must pass the intrinsic private ArrayBuffer check.

Shared metadata, subclasses, forged element kinds, accessor-backed views,
and shared buffers with replaced prototypes retain the original descriptor
path. Checking before validation prevents a self-removing accessor from
making mutated metadata appear ordinary later. Both private shared append
methods default to an ineligible witness when called directly. The witness
is consumed by the planner synchronously, before an await. Ordinary
resizable ArrayBuffers cannot resize concurrently without JavaScript
execution in that interval.

The source slab remains subject to the existing immutable-until-consumed
contract. No new release, asynchronous overlap, or retained source ownership
is introduced. Compression failure uses the original row plan and original
descriptors.

## Local correctness evidence

The source and test hashes are frozen in `source.json`. The original source
attribution, raw diagnostic receipts, and failed attempts are preserved under
`evidence/`. These are Node component checks using production grouping,
parser workers, actual compression workers, in-memory SQLite, and a
file-backed OPFS adapter. Their instrumented durations are not browser
benchmarks.

- All 158 focused tests passed. Coverage includes the original #764 tests,
  exact frame/reference parity, zero lengths, oversized entries, alignment,
  fragmented fallback, the run budget, source consumption and slab reuse,
  forged views, self-removing accessors, and direct private calls.
- Scoped runtime and test ESLint passed separately. An earlier combined
  invocation was killed with exit 137; its log is retained.
- Full current JMdict: 528,299 rows in 12 production groups. Descriptors
  decreased from 362,032 to 3,940; transported offset/length bytes decreased
  from 2,896,256 to 31,520. All 103 actual compressed frames, totaling
  12,326,040 bytes, matched. All 362,032 unique content-reference columns
  matched, and complete finalized content and generation-normalized row and
  lookup payloads matched across all 528,299 rows.
- Additional Jitendex evidence: the candidate completed 436,555 rows in 22
  groups, reducing 363,243 descriptors to 404 across 385 blocks. Its complete
  content and generation-normalized row/lookup payloads match an earlier
  retained clean-baseline receipt with the identical pinned fixture and
  group row counts. The diagnostic harnesses differ. A newly attempted
  baseline was killed with exit 137, so this is comparison against retained
  output evidence, not a completed new paired replay. Both source receipts,
  grouping hashes, fixture identity, and the killed attempt are preserved.

Full unit, main/test type, and all-target build validation are required in
the hosted correctness job. There is no native source or binary change.

## Prospective browser qualification

The unchanged `dev/perf/import-qualification-20261125-a7f7.py` runs six
separate jobs: JMdict, Jitendex, and VNDB, each with AB and BA initial order.
Each job uses a fresh hosted runner, Node 22.22.0, the matching pinned
Playwright Chromium, locked dictionary archives, production import defaults,
strict runtime verification, and no headed fallback.

Each cell runs the existing fixed schedule:

1. Two warmup pairs.
2. Twelve measured candidate pairs, alternating order.
3. Four interleaved identical-code A/C control pairs.
4. Two separate exhaustive media checks, one per arm.
5. Four separate instrumented memory observations.

The browser package is independently built for each source. The qualifier
must verify that the only changed packaged entry is the block-store module.
All existing benchmark, observer, receipt, fixture, dependency, and setup
files stay byte-identical to the baseline. The source preflight verifies this
boundary before acquisition.

VNDB explicitly uses the prospective active SAH allocation range of
37–37 units, each 4,096 bytes, for both arms. No observation changes that
range. The existing memory observer coverage and semantic gates remain
unchanged, including the 250 ms covered-gap rule. Both paired memory
observations must qualify, with each measured memory metric's median
increase at most 5% and maximum increase at most 10%.

JMdict is the primary target. Both hosts must independently show at least a
2% paired-median reduction in complete visible import time, with B faster
in at least 9 of the 12 pairs. Jitendex and VNDB must show no repeatable
regression above 3%. Correctness, exhaustive media, memory, source identity,
unit, type, lint, and dry-build gates must all pass. Control variation and
the equal-work ratio accompany the paired median; hosts are not pooled and
instrumented durations are excluded.

Stop on the first failed timed observation and retain all completed and
failed evidence. A later media or memory failure leaves any completed timing
descriptive; it does not qualify the cell. There are no replacement
observations, relaxed gates, or automatic reruns. Evidence-only edits do not
trigger another cohort. Any materially revised candidate needs a new frozen
plan.

This branch is an experiment. A product PR is considered only after the
fixed complete-import qualification establishes a worthwhile gain.

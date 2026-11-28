# Parser-worker image paths: prospective hosted qualification

## Frozen comparison

Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
Candidate: `a8194e107c741dc1fd7e38cd9602e1aaacfc95ee`.
Candidate tree: `51030cc9641b3f7689e8e26d2471c20cf478a570`.

The only changed packaged entries are `js/dictionary/term-bank-wasm-parser.js`
and `js/dictionary/term-bank-wasm-parser-worker.js`. The third product-commit
file adds regressions to `test/term-bank-media-projection.test.js`. Parser WASM,
fixture lock, dependency lock, import harness, source planner, worker counts,
budgets, compression settings and storage formats remain unchanged.

This is qualification of a contained path-projection CPU optimization. The
previous fixed full-VNDB component screen passed: 146,725 actual media rows in
170 production planner groups; all projected tokens were unescaped ASCII;
median CPU saving 25.47% against A and 24.46% against identical C, or 83.10 and
77.94 ms per complete projection corpus. Six of six comparisons were faster.
The corresponding controls differed by 1.92% CPU and 2.28% wall. Component
receipt SHA-256: `294fdad7cd4e052737597cc422f2d6ee0527cc48f5f067d58f5e56e2efe87c34`.
That result is not a whole-import, full-copy or peak-memory claim.

## Acquisition

Use the unchanged repository runner
`dev/perf/import-qualification-20261125-a7f7.py`. Each of JMdict, Jitendex and
VNDB receives two independent hosted jobs, with opposite initial orders AB
and BA. Each job has four excluded warmup imports, twelve fixed alternating
A/B pairs, four interleaved identical A/C pairs, separate exhaustive media
verification and the existing separate four-observation ABBA/BAAB memory
protocol. Every import uses a fresh browser profile, production flags `{}`,
the pinned Node 22.22.0 runtime and lockfile Chromium, and exactly three parser
workers. Runtime packages are built independently and their complete entry
hash maps must differ only at the two declared paths.

All six jobs are retained independently; do not pool hosts. No replacement
observations, reruns of a failed measurement job, post hoc truncation, added
pairs, threshold changes or treatment of traced/instrumented runs as ordinary
timing is allowed. A setup or validation failure remains recorded and must be
distinguished from a failed acquired observation.

Before browser timing, run scoped ESLint, main/test TypeScript checks, the full
unit suite and the all-target dry build. The candidate's complete actual-worker
VNDB copy parity oracle is also required for any review recommendation; it
compares all result columns, prepared routes and media paths while the native
source is live. No product instrumentation is used in authoritative timing.

## Current storage validation policy

The generic runner's historical VNDB SAH range of 129-131 pages predates this
baseline. All three fresh frozen-baseline observations from Actions run
46102820124 have one active 151,552-byte file (37 pages) and seven empty
4,096-byte files. Register the same plus/minus-one-page tolerance around this
current baseline as `--vndb-sah-allocation-units 36 38`, before any candidate
observation. This changes the validation oracle only. Evidence is preserved in
`vndb-sah-baseline-policy.json`, including the original artifact identity.

## Prospective decisions

Correctness requires complete source/package/fixture identity, every scheduled
observation, matching lookup and restart receipts, all-media verification and
all existing corruption/format checks. The separate memory protocol must pass
unchanged: valid process-tree measurements, median increase at most 5%, every
paired increase at most 10%, and no missing/invalid slots. Memory observations
remain outside all latency comparisons.

For each host, unchanged A/C median drift must be within 5%. The non-regression
screen requires the paired B/A median and equal-work changes at most +3%, with
the descriptive bootstrap interval's upper endpoint at most +5%. All three
dictionaries must meet this screen on both hosts before considering a phase
CPU improvement for review. Failure prevents a review recommendation for this
candidate; it is not repaired by subtracting control drift.

A whole-import speedup claim has a stronger, separate gate on VNDB, on both
hosts: paired median B/A improvement at least 5%, B's median time at least 5%
below the identical C observations' median, at least 10 of 12 faster A/B
pairs, negative equal-work change, and a negative upper endpoint of the
descriptive paired-median bootstrap interval. A passing non-regression screen
alone never establishes a whole-import speedup.

If all correctness, memory and non-regression requirements pass but that
stronger latency gate does not, a review decision may be based only on the
previously qualified, explicitly scoped projection CPU saving and the code's
complexity. The PR, if any, must say that no reliable whole-import improvement
was established. No PR is automatic, and failed or inconclusive results stay
in the record.

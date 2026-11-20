# JMdict yield study, 2026-11-19

This independent study tests overlap between import sink work and its existing
MessageChannel task turn. The tooling branch does not apply the runtime change.

Protocol and results are tracked in [PR #767](https://github.com/ManabiIO/manabitan/pull/767).
The earlier source-copy/prefetch study is [PR #765](https://github.com/ManabiIO/manabitan/pull/765).

| Arm | Source                                     | Role                                     |
| --- | ------------------------------------------ | ---------------------------------------- |
| A   | `d829f5b6e6a75ee8859d38d537d224ec33c4930e` | Baseline                                 |
| B   | `52a0108053837ff7a504c256606570e397ab93b0` | Yield candidate                          |
| C   | `d829f5b6e6a75ee8859d38d537d224ec33c4930e` | Independently packaged baseline control  |
| D   | `52a0108053837ff7a504c256606570e397ab93b0` | Independently packaged candidate control |

`candidates.bundle` preserves the candidate commit with the baseline as its
prerequisite. `yield.patch` is its readable two-file product/test diff. Only
`ext/js/dictionary/dictionary-importer.js` changes in the packaged extension.
The source tree, dictionary, dependency lock, vendored WASM and shared inputs
are pinned in `manifest.json`.

## Runtime hypothesis and correctness boundary

The first native chunk retains its original task scheduling. For each later
chunk, the candidate starts its task turn before sink processing and waits for
both owners to settle. Sink errors retain priority. When the last actual
callback completed successfully with overlap, a terminal turn also fences
successful or rejected parser completion before source release, the next bank
or publication. Cancellation
checks and the terminal fence include empty trailing parser groups.

Zero- and one-callback reads keep their original task behavior. Multi-callback
reads add a terminal turn while allowing the existing per-chunk turns to overlap
asynchronous work. Parser grouping, workers, ownership, cache limits, source
prefetch and compression policies are unchanged. Every arm must report zero
initial source prefetches. A smaller internal sink or parser phase alone cannot
establish a whole-import improvement.

## Frozen protocol

The four Linux cells are Chromium forward/reverse and Firefox forward/reverse.
Each uses a fresh hosted runner and executes observations sequentially. The
workflow permits at most two cells at once. Do not pool arms, browsers or order
replications, or combine this study with the earlier ZIP/prefetch study.

Preparation builds all four packages before timing. A/C and B/D must each have
identical ZIP entry contents. B/D may differ from A only at the declared
importer path. All arms receive one identical generated legal page. The
existing Chromium observer, official-Firefox helper and runtime bootstrap are
unchanged from tooling commit `a4a2ee2b29fce97f6e22c65f7e4bb497bec342ee`.

Two excluded warmups per arm precede 24 measured blocks. Forward block orders
are `ABCD`, `BDAC`, `CADB`, `DCBA`, repeated six times. Reverse cells reverse
each order. Position and directed within-block adjacency counts are balanced.
Each observation uses a fresh helper/browser process and profile: 96 timed
observations plus eight warmups per cell, within a 35-minute measurement
deadline. The individual observation timeout is 180 seconds.

A failed warmup prevents measured observations. A failed measured observation
invalidates its cohort while subsequent declared observations continue within
the deadline. Preserve every attempted observation, failure, timeout and tail.
There are no retries, appended samples, selected exclusions or post-hoc sample
extensions. Failed or incomplete cohorts produce no comparison statistics.

## Measurement and acceptance

The authoritative interval remains the browser's monotonic file-input change
through the current operation's post-UI completion signal. Package installation,
launch, probes, hashing and host diagnostics occur outside that interval. There
is no in-timing CPU profiler, screenshot or process sampler.

Chromium uses the lockfile-selected Playwright executable and verifies content
after a complete browser restart. Firefox uses one official Mozilla Developer
Edition archive, verified once and shared by both Firefox cells, with pinned
geckodriver 0.37.1. It runs headed under Xvfb and verifies content after an
extension reload from a neutral tab; that reload is not a browser restart.

Every observation must verify the pinned 526,942 term rows, title, revision,
real OPFS storage, source-derived content probes, exact compressed source work,
zero native/fused fallbacks and clean final publication. Per-cell content
digests must agree across every arm and observation. These digests cover the
verified probes and storage samples, not every persisted dictionary byte.
Firefox compares the twelve expected expression/reading/full-glossary tuples;
Chromium checks bounds and readable content previews for twelve source terms.
Browser/runtime, source,
package and fixture identities are checked and retained with the raw reports.
Untimed RSS snapshots and WASM heap maxima are diagnostics, not peak-memory
qualification.

## Interpretation and local checks

Report the two separate same-source controls **C/A** and **D/B** alongside
**B/A** and **D/A**. The latter share A within each block and are correlated;
the two copies of the candidate are not pooled. Do not subtract control noise.
Retain every paired change, its median, equal-work aggregate, favorable-pair
count, worst pair and the seeded 10,000-resample descriptive bootstrap interval.
That interval does not correct time dependence or multiple comparisons. A
qualified optimization needs consistent independent cells, acceptable controls
and the required correctness/memory gates.

```sh
python3 dev/perf/jmdict-yield-study/run.py validate-plan
python3 -m unittest discover -s dev/perf/jmdict-yield-study -p 'test_*.py'
npx prettier dev/perf/jmdict-yield-study/README.md --check
npm run test:json:types -- --maxWorkers=1
```

The branch-scoped workflow has read-only repository permissions, uses Linux
only and performs no deployment or release mutation. Commits marked
`[study-report]` skip the optional study while ordinary CI still runs. Existing
observations remain bound to their original tooling commit and manifest; a
runtime or protocol change requires a separately declared run.

# JMdict import study, 2026-11-20

This study qualifies import candidates against current develop at
`bde55dfbee1451edc32051f8bf51e8a870d5c72c`. It does not reuse measurements from
the older baseline. The tooling branch does not apply candidate product changes.

The prior [source-copy/prefetch study](https://github.com/ManabiIO/manabitan/pull/765)
and [task-turn study](https://github.com/ManabiIO/manabitan/pull/767) found no
repeatable complete-import gain. Their Firefox observer, runtime bootstrap and
failure policy are reused here; their observations are not combined with this study.

## Sources and controls

| Arm | Source commit                              | Role                                                 |
| --- | ------------------------------------------ | ---------------------------------------------------- |
| A/C | `bde55dfbee1451edc32051f8bf51e8a870d5c72c` | Baseline and independently packaged baseline control |
| B   | `9b947eb6130020bdd2986787cb42df3a7eb72d73` | Resolved-reference run validation                    |
| D   | `025596858e4e176d92c8f7f016057317c60c2793` | Paired compressed-content checksum                   |

The frozen `manifest.json` declares every source commit, tree, product path and
comparison pair. A/C are independently packaged copies of the baseline. B/D
contain either two separate candidates or two copies of one candidate, selected
before any browser measurement. A D/B same-source control is required only when
B/D have the same commit and tree; the driver rejects a D/B control between
different candidates. C/A, B/A and D/A are always reported separately.

`candidates.bundle` preserves candidate commits with the baseline as a
prerequisite. Readable patches accompany the bundle. Package preparation verifies
that candidate extension entries differ only at their declared product paths.
A/C package entry contents must match exactly; B/D must also match when they are
declared as duplicate candidates. All packages receive the same generated legal page.

The fixture, dependency lock, vendored WASM, source inputs, observers and workflow
are hashed in the manifest. Product worker, cache, compression, source-lead,
batching and durability policies must remain unchanged. An internal phase timer
alone cannot establish a complete-import improvement.

## Fixed observations

Four separate Linux cells cover Chromium forward/reverse and Firefox
forward/reverse. Each uses a fresh hosted runner and executes its observations
sequentially. At most two cells run concurrently. There are no macOS jobs.

Two excluded warmups per arm precede 24 measured blocks. Forward block orders are
`ABCD`, `BDAC`, `CADB`, `DCBA`, repeated six times. Reverse cells reverse each
order. Position and directed within-block adjacency counts are balanced. Every
observation uses a fresh helper/browser process and profile: 96 timed observations
and eight warmups per cell, within a 35-minute measurement deadline. Each
observation has a maximum 180-second timeout.

A failed warmup prevents the measured cohort from starting. A failed measured
observation invalidates its cohort while later declared observations continue
within the deadline. Preserve all attempts, failures, timeouts and tails. There
are no retries, appended samples, selected exclusions or post-hoc extensions.
Incomplete or failed cohorts produce no performance comparisons.

## Timing and correctness

The authoritative interval is the browser's monotonic file-input change through
the current operation's post-UI completion signal. Installation, launch, probes,
hashing and host diagnostics remain outside it. No profiler, screenshot or
process sampler runs inside the measured interval.

Chromium uses the lockfile-selected Playwright executable and checks persistence
after a full browser restart. Firefox uses one verified official Mozilla
Developer Edition archive, shared between both Firefox cells, and pinned
geckodriver 0.37.1. It runs headed under Xvfb and checks persistence after an
extension reload from a neutral tab. That reload is not a browser restart.

Every observation must pass the pinned 526,942 term rows, title, revision, native
OPFS path, compressed source-work counts, zero native/fused fallbacks and clean
publication. Content digests must agree across all arms and observations within
each cell. Firefox compares twelve source-derived expression/reading/full-glossary
tuples; Chromium checks bounds, readability and previews for twelve source terms.
Neither samples every persisted dictionary byte. Untimed RSS snapshots and
reported WASM heap maxima do not establish peak process memory.

## Analysis and reproduction

For each declared comparison, retain all paired changes, their median,
equal-work aggregate, favorable-pair count, worst pair and the seeded
10,000-resample descriptive bootstrap interval. The interval does not correct
temporal dependence or multiple comparisons. B/A and D/A share A within each
block. Do not pool candidates, browsers, hosts, order replications or attempts,
and do not subtract control noise. Qualification requires consistent independent
cells, acceptable same-source controls and the relevant correctness/memory gates.

```sh
python3 dev/perf/jmdict-validation-study/run.py validate-plan
python3 -m unittest discover -s dev/perf/jmdict-validation-study -p 'test_*.py'
npx prettier dev/perf/jmdict-validation-study/README.md --check
npm run test:json:types -- --maxWorkers=1
python3 dev/perf/jmdict-validation-study-analyze.py \
  /path/to/chromium-forward /path/to/chromium-reverse \
  /path/to/firefox-forward /path/to/firefox-reverse \
  --output /path/to/new-analysis.json
```

The workflow verifies the frozen protocol before resolving its runtime. It has
read-only repository permissions and performs no deployment or release mutation.
Evidence uploads include hidden configuration files. Commits marked
`[study-report]` skip optional new measurement cohorts while ordinary CI still
runs. Every observation remains bound to its exact measured tooling commit and
manifest; a changed source or protocol requires a separately declared run.

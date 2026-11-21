# JMdict native configuration study v2, 2026-11-20

This separately versioned diagnostic examines immutable native canonical-scan configuration
snapshots against current develop at
`bde55dfbee1451edc32051f8bf51e8a870d5c72c`. It reuses the frozen observer and
protocol from [PR770](https://github.com/ManabiIO/manabitan/pull/770), whose measured
tooling commit is `007f16306b9f8036a9930b653fbffca3c750068e`. Earlier study
observations remain separate. The tooling branch does not apply candidate product
changes.

## Version 1 preparation failure and this correction

Version 1 at tooling commit `5e2dea241ac11ef7b75c407c2ee1c878e1fd4091`
([run 44727365554](https://github.com/ManabiIO/manabitan/actions/runs/44727365554))
failed package-map validation in all four cells before any warmup or import.
Normal extension packages contain the native C source as well as its compiled
WASM. The version 1 declaration omitted the changed C entry. All original
artifacts, command logs, manifests and failures are retained; there are zero
browser import measurements from that attempt.

Version 2 corrects the declaration to exactly two entries:
`js/dictionary/wasm/term-content-canonical-scan-v1.c` and
`lib/term-content-canonical-scan-v1.wasm`. It uses the same source commits, four
cells, order schedule, sample counts, runtime identities, timing boundary and
failure policy. There is no source or performance tuning in this correction.
The version 1 files remain unchanged, and this version uses a separate workflow,
manifest, evidence namespace and analysis entry point.

`package-map-fixture.json` preserves the full 538-entry A/B maps from the original
Chromium forward artifact, with source-file and original ZIP hashes. A regression
test reproduces the version 1 rejection and confirms that the corrected map still
rejects any unrelated addition, removal or changed entry. The same full-map
preflight runs before runtime preparation; each hosted cell also compares its
actual independently built A/B/C/D entry sets before any observation.

## Why this diagnostic proceeds

This is an **unqualified diagnostic**, not confirmation of a passed component
performance gate. The fixed native resolver screen retained all 104 observations
and passed every output, work and source-identity oracle. Its median candidate
contrasts were about -6.07% for B/A and -4.53% for D/A, while the unchanged-source
controls moved -5.11% for C/A and +1.15% for D/B. Both candidate descriptive
intervals crossed zero. These measurements establish neither a repeatable gain
nor a regression in that component cohort.

The candidate removes eleven repeated hot-loop configuration loads, preserves
the native ABI/publication ordering, and passes 166 focused correctness tests.
Those facts motivate one fixed browser-engine and complete-import diagnostic.
The component result did not cause a source, timing, schedule or sample-size
adaptation. All four declared cells are retained, with no retries or extensions.
No optimization is qualified or recommended for product adoption by this setup.

## Sources and controls

| Arm | Source commit                              | Role                                                              |
| --- | ------------------------------------------ | ----------------------------------------------------------------- |
| A/C | `bde55dfbee1451edc32051f8bf51e8a870d5c72c` | Baseline and independently packaged control                       |
| B/D | `19b13a550d9b7f2a53f37d74aa36b2ee9c3e7472` | Native configuration snapshots and independently packaged control |

The frozen `manifest.json` declares every source commit, tree, source difference,
packaged difference and comparison pair. A/C are independently packaged copies
of the baseline; B/D are independently packaged copies of the same native
candidate. Report C/A and D/B controls, and B/A and D/A candidate comparisons,
separately. Do not pool arms or subtract control noise.

`candidates.bundle` preserves the exact candidate commit with the baseline as a
prerequisite; `native-config.patch` is its complete readable binary patch. The
preparation driver verifies the full tracked source difference, including tests
and generated native artifacts, against `sourcePaths`. Package entry comparison
uses a separate `packagePaths` list: exactly
`js/dictionary/wasm/term-content-canonical-scan-v1.c` and
`lib/term-content-canonical-scan-v1.wasm` may differ. A/C and B/D package contents
must respectively match exactly. All packages receive the same generated legal
page.

The native C source, vendored canonical WASM and native manifest differ by source.
Their exact bytes are checked for each arm before and after every observation.
The parser WASM, compiler recipe, dependency lock, fixture, observers, workflow,
and shared product policy inputs are fixed. Clang/LLD 21.1.8 regenerates native
artifacts before candidate freeze; ordinary hosted package builds only verify and
copy the committed artifacts. Worker, cache, compression, source-lead, batching
and durability policies remain unchanged. An internal phase timer alone cannot
establish a complete-import improvement.

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

Chromium uses the locked Playwright Chrome for Testing 153.0.8010.12 executable,
whose binary SHA256 is fixed in the manifest, and checks persistence after a full
browser restart. Firefox reuses official Mozilla Developer Edition 161.0b5 and
geckodriver 0.37.1 from artifact `14621448317` of run `44720953991`; no latest
release is resolved. Before hosted download, metadata must match the fixed source
run, tooling commit, artifact size and archive digest. Before installation, the
extracted runtime receipt must match its predeclared byte hash, and archive
hashes must agree with that receipt and the included official checksum record.
The installer verifies Firefox binary, libxul, application.ini and geckodriver
identities. The receipt byte hash was reconstructed from the original successful
bootstrap log using its exact serializer and is confirmed against the downloaded
file before any use. Firefox runs headed under Xvfb and checks persistence after
an extension reload from a neutral tab. That reload is not a browser restart.

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
python3 dev/perf/jmdict-native-config-study-v2/run.py validate-plan
python3 dev/perf/jmdict-native-config-study-v2/run.py validate-package-map
python3 -m unittest discover -s dev/perf/jmdict-native-config-study-v2 -p 'test_*.py'
npx prettier dev/perf/jmdict-native-config-study-v2/README.md --check
npm run test:json:types -- --maxWorkers=1
python3 dev/perf/jmdict-native-config-study-v2-analyze.py \
  /path/to/chromium-forward /path/to/chromium-reverse \
  /path/to/firefox-forward /path/to/firefox-reverse \
  --output /path/to/new-analysis.json
```

The workflow verifies the frozen protocol before reusing its runtime. It has
read-only repository permissions and performs no deployment or release mutation.
Evidence uploads include hidden configuration files. Commits marked
`[study-report]` skip optional new measurement cohorts while ordinary CI still
runs. Every observation remains bound to its exact measured tooling commit and
manifest; a changed source or protocol requires a separately declared run.

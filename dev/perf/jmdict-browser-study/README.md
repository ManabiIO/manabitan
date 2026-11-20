# JMdict browser study, 2026-11-19

The [draft qualification PR](https://github.com/ManabiIO/manabitan/pull/765)
tracks the declared runs, evidence and interpretation.

This study measures two independent changes against the same pinned source.
It does not apply either runtime change to this tooling branch.

| Arm | Source                                     | Change                                                       |
| --- | ------------------------------------------ | ------------------------------------------------------------ |
| A   | `d829f5b6e6a75ee8859d38d537d224ec33c4930e` | Baseline                                                     |
| B   | `98b25cbce108b7c63ffe318f06186dadd26d476c` | Use typed-array construction for owned ZIP payload copies    |
| C   | `d829f5b6e6a75ee8859d38d537d224ec33c4930e` | Independently packaged, identical baseline control           |
| D   | `2ae43ece52ab621fa1af763bf65635f1bedc0fad` | Start one bounded compressed source read during import setup |

`candidates.bundle` preserves both candidate commits and requires the baseline
commit already present in the checkout. `rawzip.patch` and `prefetch.patch` are
readable product/test diffs with zero context (use `git apply --unidiff-zero`
when applying them). The original B commit also contains an unrelated
manual-workflow change; that workflow is never executed by this study. Package
entry comparisons permit only the declared product JavaScript changes.

## Frozen protocol

The source identities, input hashes, workload, schedule and deadlines are in
`manifest.json`. Freeze it before observing any timings. Do not resume, append
to, retry, or selectively extend an attempted cohort.

There are four separate Linux cells: Chromium forward/reverse and Firefox
forward/reverse. Each cell uses a fresh hosted runner. Results are analyzed per
cell; do not pool browsers or subtract the control's observed change.

Each cell first prepares all four packages. A and C must have identical ZIP
entry contents. B and D may differ from A only at their declared product paths.
The dependency lock, vendored WASM, fixture lock, instrumentation and browser
runtime are frozen. Every arm receives one identical generated legal page;
its hash is recorded and no other tracked product modification is permitted.

Two excluded warmups per arm precede 24 measured blocks. Forward block orders
are `ABCD`, `BDAC`, `CADB`, `DCBA`, repeated six times. Reverse cells reverse
each order. This balances each arm's position and all directed within-block
adjacencies. Each observation uses a new helper/browser process and profile.
The total is 96 timed observations and eight excluded warmups per cell.

A failed warmup prevents the timed cohort from starting. A failed measured
observation invalidates the cohort, but subsequent declared observations still
run while the fixed deadline permits. Every attempted observation, failure,
timeout and tail is retained. No failed cohort produces comparison statistics.

The authoritative interval is the browser's monotonic clock from the actual
file-input change through the current import's post-UI completion signal.
Browser launch, package installation, probes, persistence checks, hashing and
host diagnostics are outside that interval. No CPU profiling, screenshots or
process sampler runs during measurement. Production parser, cache, compression
and worker policies remain unchanged.

## Browser runtime and correctness gates

Chromium uses the repository's lockfile-selected Playwright executable and
existing import observer. Its validation includes a complete browser restart
and persisted-content probes.

Firefox uses a single official Mozilla Developer Edition archive resolved once
for the entire workflow. Its immutable release URL, official SHA512 checksum,
archive identity, application build, executable and `libxul` hashes are recorded.
Both Firefox cells extract that same verified artifact and use pinned
geckodriver 0.37.1. There is no Playwright-Firefox fallback. Firefox runs headed
under Xvfb, matching the ordinary Selenium CI approach.

The Firefox helper validates all 526,942 term rows, exact title and revision,
real OPFS storage, twelve source-derived expression/reading/full-glossary
probes, content-span bounds and complete source-work counters. It then issues
one `AddonManager.reload()` from a neutral browser tab in the privileged chrome
context, verifies a changed background `performance.timeOrigin`, and repeats
the probes without reimporting. This is an extension reload, not a full browser
process restart. Operation and cleanup failures are recorded separately.

Both browsers must execute the native compressed path without fused/native
fallbacks, publish successfully and retain the pinned row/source-byte counts.
D must report one initial prefetched source with a 3,226,520-byte decoded-size
estimate; A/B/C must report zero. Per-cell validation digests must match across
all arms and observations. Firefox's semantic and storage digests are separate;
Chromium's existing digest includes sampled stored spans.

## Interpretation

Report C/A alongside B/A and D/A. B/A and D/A share A within each block and are
correlated comparisons. Preserve paired changes, median change, equal-work
aggregate change, favorable-pair count and worst pair. The seeded bootstrap
interval is descriptive; it does not correct time dependence or multiplicity.
Independent order replications and the same-source control matter more than a
single point estimate. A small result inside same-source variation is not a
qualified optimization.

The raw ZIP change retains exact owned copies. Its reader-only speedup is a
component result and does not establish a whole-import win.

The prefetch change overlaps archive I/O with setup. It charges any new whole
Blob materialization plus the larger of compressed/decoded first-bank sizes
against the existing prefetch cap. The pinned JMdict charge is 18,813,552 bytes,
within the lower 24 MiB policy. It does not alter worker counts, grouping, cache
sizes or compression. Its earlier read can reduce an internal source timer
merely by moving work before that timer; only whole-import elapsed time decides
the performance outcome.

Untimed Firefox RSS snapshots and reported WASM heap maxima are diagnostics,
not peak-import-memory measurements. A promising candidate still requires a
separate memory diagnostic and relevant correctness gates before promotion.

## Local verification

```sh
python3 dev/perf/jmdict-browser-study/run.py validate-plan
python3 -m unittest discover -s dev/perf/jmdict-browser-study -p 'test_*.py'
npx vitest run test/firefox/jmdict-import-observation.test.js --maxWorkers=1
```

Actual browser qualification runs only in the branch-scoped, read-only
Linux workflow. It does not use macOS runners, secrets, deployment steps or
release-workflow modifications. Evidence includes the exact tooling snapshot,
manifest, package-entry hashes, commands, raw reports and failure logs.

Commits marked `[study-report]` update documentation, schema registration or
retained analysis without launching another optional measurement cohort.
Ordinary repository CI still runs. Runtime or measurement-protocol changes
require a separately declared run; existing observations remain bound to their
original diagnostic commit and manifest.

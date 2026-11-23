# Dictionary import allocation and browser comparison

Supporting evidence for [runtime PR #801](https://github.com/ManabiIO/manabitan/pull/801)
and [optional VNDB benchmark PR #803](https://github.com/ManabiIO/manabitan/pull/803).
This directory is on a separate evidence branch; the production changes are in
the two PRs.

## Findings

The runtime change removes unused parser scratch allocation, defers generic
deduplication buffers until needed, and releases original entry/presentation
references from deferred media requests. Full-corpus component comparisons show
matching output with less allocated scratch. The browser comparisons establish
successful complete imports and restart readback. They do not establish an
elapsed-time improvement or a reduction in peak process memory.

| Dictionary |      Rows | Canonical scratch before |       After | Allocation removed |
| ---------- | --------: | -----------------------: | ----------: | -----------------: |
| JMdict     |   526,942 |              7,137,008 B | 2,921,472 B |    **4,215,536 B** |
| Jitendex   |   435,448 |              6,381,056 B | 2,897,472 B |    **3,483,584 B** |
| VNDB       | 6,648,310 |             54,449,392 B | 1,262,912 B |   **53,186,480 B** |

These are cumulative capacities of the measured scratch arrays over all
production-planned groups using the recorded five-worker policy. Groups are
processed sequentially through the real native parser and a fresh canonical
resolver. They are not simultaneous heap totals or a persistent-storage
benchmark. All per-group parser/content/media/lookup and canonical-output
digests match. Native canonical calls match, with zero fallbacks.

The [allocation package](allocation/README.md) preserves all six raw receipts,
the original runner, source and binary hashes, a portable reproduction runner,
and an independent verifier. A new full JMdict candidate run reproduced every
record exactly using the portable runner.

## Browser results

[GitHub Actions run 45102744757](https://github.com/ManabiIO/manabitan/actions/runs/45102744757)
completed 22 observations for each dictionary: two warmups, two A/A control
pairs, six alternating AB/BA pairs, and two more A/A control pairs. Every
observation uses a fresh profile and the pinned archive bytes. No observations
were removed or selectively retried.

The timer spans the original file-input change through post-UI import
completion. Validation and browser restart occur outside that timer. Both arms
use the same harness, dependencies, browser and packaging procedure.

| Dictionary | Median paired time change | Candidate faster pairs | A/A control changes | Persisted media rows |
| ---------- | ------------------------: | ---------------------: | ------------------: | -------------------: |
| JMdict     |                    -1.21% |                    4/6 |    -2.64% to -0.39% |                    0 |
| Jitendex   |                    +0.25% |                    3/6 |   -17.21% to -0.33% |                  236 |
| VNDB       |                    -0.84% |                    3/6 |    -2.78% to +7.72% |              146,570 |

Negative changes mean less elapsed time. The median is calculated from the six
paired percentage changes, not the ratio of the two arm medians. The small,
mixed differences relative to the identical-package control variation do not
support a speedup claim. This is a Linux Chromium comparison, not a
cross-device latency guarantee.

All 66 observations validated exact term/media counts before and after browser
restart, twelve content probes, and matching sampled-content digests between
arms. Counts and sampled content readback do not constitute exhaustive image
payload readback. The runtime unit tests separately cover exact payload
batching, missing-file errors and frozen serialized targets.

[browser/summary.json](browser/summary.json) contains the independently checked
aggregate. Each dictionary subdirectory preserves every observation, the
original result summary, the schedule, both package manifests and source
identities. The full per-observation reports and logs are in the workflow
artifacts, with their archive checksums in
[browser/artifacts.json](browser/artifacts.json).

## Source identity

- Baseline: `5e1f8c12f7ff798ba407323aff675cb23b22af02`.
- Measured runtime candidate: `f8dae7026d57488d4097caba942783bc1bbef6d4`.
- Runtime PR head after a test-only formatting correction:
  `1e235059a4c05c2509e8757fccba43a2d60222df`.
- Fixture tooling: `4e568fcde29fb93df9a856eab5d177b741d99bce`.
- Browser comparison harness:
  `e0dd57a40819bc3ed199dd98d0d3f7c513222307`.

The baseline and candidate packages differ only in these four files:

- `js/dictionary/dictionary-database.js`
- `js/dictionary/dictionary-importer.js`
- `js/dictionary/term-bank-wasm-parser.js`
- `js/dictionary/term-content-canonical-scan.js`

Their packaged hashes were checked against their declared Git revisions. The
latest runtime PR head contains byte-identical production source; its follow-up
commit only reformats a test. Dependency locks match, and each observation's
package hash and source revision match the planned arm.

## Validation

- Runtime [CI run 45103268007](https://github.com/ManabiIO/manabitan/actions/runs/45103268007): passed.
- Tooling [CI run 45102711683](https://github.com/ManabiIO/manabitan/actions/runs/45102711683): passed.
- Complete runtime unit suite: 628 files, 14,010 tests passed, 47 skipped,
  both locally and in CI.
- Chromium and Firefox full-extension E2E, restart interruption, all TypeScript
  projects, lint and build checks passed.
- Focused allocation/worker/rollback tests: 378 passed.
- Focused media tests: 48 passed.
- Focused fixture/benchmark tests: 164 passed, plus three lock schema tests.

The first runtime CI attempt found test object-property formatting errors.
The test-only follow-up fixed them; the latest complete CI run passed. Local
full Chromium startup was blocked by the execution environment's profile
socket permissions, so the actual browser comparison ran in GitHub Actions.

## Reproduce

The allocation package has complete independent verification and reproduction
commands in [allocation/README.md](allocation/README.md).

For browser reproduction, use a fresh checkout of the harness revision above
on Linux with Node 22.22.0 and run the same setup as the
[workflow](../../../../.github/workflows/import-memory-study-20261122.yml).
From that repository root:

```sh
npm ci
npm run build:libs
npm run license-report:html
npx playwright install --with-deps chromium

git fetch origin 5e1f8c12f7ff798ba407323aff675cb23b22af02 f8dae7026d57488d4097caba942783bc1bbef6d4

study_browser_temp="$(mktemp -d "${TMPDIR:-/tmp}/manabitan-browser-study.XXXXXX")"
export PERF_BASELINE_SHA=5e1f8c12f7ff798ba407323aff675cb23b22af02
export PERF_CANDIDATE_SHA=f8dae7026d57488d4097caba942783bc1bbef6d4
for study_dictionary in jmdict jitendex vndb; do
    RUNNER_TEMP="$study_browser_temp" PERF_DICTIONARY="$study_dictionary" \
        python3 dev/perf/import-memory-study-20261122/run.py
done
```

Both revisions must be available in Git before running. The driver verifies
source and package identities, fixes the observation schedule, and writes
every report beneath `builds/import-memory-study`. It refuses to overwrite an
existing corpus output directory. Its scope and validation limits remain the
same as described above.

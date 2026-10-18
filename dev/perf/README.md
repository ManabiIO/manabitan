# Performance tooling

[`mise` tasks](https://mise.jdx.dev/tasks/) are the preferred task UI, but the underlying scripts are ordinary Node programs so exported/offline workspaces do not require `mise`.

```sh
mise run perf:env
mise run perf:bench -- benches/japanese-language-transformer.bench.js
mise run perf:bench:baseline -- benches/japanese-language-transformer.bench.js
mise run perf:bench:compare -- benches/japanese-language-transformer.bench.js
mise run perf:import -- jmdict --runs 5
mise run perf:import:trace -- jmdict
mise run perf:import:ab -- jmdict --flags '{"zipMaxWorkers":3}'
```

Without `mise`, run the `dev/perf/*.js` programs directly. Microbenchmarks can be run offline with `node ./node_modules/vitest/vitest.mjs bench --run`; no task requires npm package resolution at execution time.

Real-dictionary performance runs use `test/perf/dictionaries.lock.json`. Cached archives are accepted only when their byte size and SHA-256 match the lock. Functional E2E continues to use the current recommended dictionaries unless `MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK=1` is set.

Normal import benchmark runs use production import globals (except the completion signal required by the harness) and disable the E2E page CPU profiler, phase screenshots, and browser-process sampling. Their total-import timer stops before test-only diagnostic reads. Import A/B comparisons default to five AB/BA-alternating pairs; use `--pairs` only when deliberately trading confidence for turnaround. Extra bulk-add debug logging is opt-in with `MANABITAN_AB_BULKADD_BYTES_METRICS=1`. `perf:import:trace` instead captures a browser-wide V8/DevTools trace ending at the import worker's `importDictionary` completion marker. Trace runs perturb execution and are marked `authoritativeTiming: false`; never use their wall-clock duration as a performance comparison.

Once the `Performance Bundle` workflow exists on the repository's default branch, it can be started manually or, for an open pull request, by an owner/member/collaborator commenting `/perf-bundle`; this makes it triggerable through the GitHub connector used by ChatGPT. It produces a workspace artifact containing the exact source snapshot, `node_modules`, generated libraries/build output, verified pinned dictionaries, and a manifest, plus a runtime artifact containing the exact Node runtime and matching Playwright browser cache. The manifest preserves the source SHA plus Node/V8/Playwright/Chromium versions and lockfile fingerprints even though `.git` is omitted. After extracting both artifacts, prepend the runtime artifact's `runtime/node/bin` directory to `PATH` and point `PLAYWRIGHT_BROWSERS_PATH` at `runtime/ms-playwright` before running tasks; `mise` is not required in the offline environment.

## Acceptance and timing boundaries

Each import uses a fresh browser profile, the pinned Playwright Chromium, and production import globals unless flags are explicitly supplied. The wrappers remove inherited `MANABITAN_E2E_*` and `MANABITAN_CHROMIUM_*` controls before applying their own settings. This prevents an invoking shell from silently enabling traces, changing browser flavor, skipping checks, or contaminating either A/B arm. Standard runtime variables such as `PATH` and `PLAYWRIGHT_BROWSERS_PATH` are retained.

A successful timing report must match the requested dictionary, trace mode and flags; contain exactly one matching structured import phase with a positive finite duration; and confirm an error-free OPFS import. After the timer stops, the harness checks the exact persisted dictionary title, revision and term count, then probes twelve distinct terms from the first, middle and last term banks for readable content. This is sampled content validation, not an exhaustive equality proof of every definition or a replacement for the functional E2E suite.

`timing` measures the page's file-input change event through the post-UI `manabitan:dictionary-import-complete` event using the browser's monotonic clock. `automationObservedTiming` retains file dispatch through automation-observed completion separately, including file-transfer and polling overhead. `workerTiming` measures the controller's worker-import RPC boundary. Do not compare these boundaries as though they were the same measurement. Completion signals UI readiness, not guaranteed physical paint; an optional next-frame timestamp is recorded separately. Browser startup, extension build, diagnostic reads and post-import checks are outside the browser interval. Internal parser, inflation, compression and sink counters overlap; they must not be summed into end-to-end time.

The total phase starts immediately before file-input dispatch and includes the trigger phase. Report validation rejects missing trigger timestamps or totals starting after dispatch. Older reports that timed only the post-dispatch wait are not comparable end-to-end measurements and must be rerun.

### Overflow layout comparison

Run `node dev/perf/overflow-layout-benchmark.js --baseline '98ecaa39^' --font /path/to/font.ttf --pairs 12`. The font must cover the ASCII fixture. This loads the actual popup CSS, compares baseline/candidate controller source, alternates adjacent AB/BA pairs, and requires identical initial, resized, and toggled geometry at 360px and 800px widths. Expanded/collapsed modes retain automatic overflow eligibility; the non-collapsible mode is a control. Font bytes, controller sources, CSS hashes, actual browser font identity, and host load are recorded. This measures entry insertion, overflow setup, and final layout, not complete popup, hover, or Anki latency.

Counts must be positive safe integers; malformed counts fail before browser launch. Missing diagnostic metrics and undefined percentage changes are represented as `null`, not zero. A/B output uses paired AB/BA ordering and fails with a nonzero exit status if either arm fails validation. A five-pair result is exploratory evidence, not by itself proof of a cross-device improvement.

Run regression coverage with `node ./node_modules/vitest/vitest.mjs run test/perf-benchmark-support.test.js`. Cached fixtures are replaced only after size and SHA-256 verification, using atomic rename; a failed download does not remove an existing cache file.

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

The lock includes complete JMdict, Jitendex and VNDB archives, including image media. Use `node dev/perf/prepare-dictionaries.js --all` to preload every fixture, or pass dictionary IDs to prepare selected archives. Existing callers without arguments prepare JMdict, JMnedict and Jitendex; the 291.7 MB VNDB download is opt-in. The November 22, 2026 refresh pins JMdict to November 22, Jitendex to October 3 and VNDB Characters by Bee to its latest release, 1.0.0. Archives remain outside Git.

```sh
node dev/perf/prepare-dictionaries.js --all
node dev/perf/import-benchmark.js vndb --build-target chrome --runs 1
node dev/perf/import-benchmark.js vndb --build-target chrome --runs 5 --media-check sample
```

Media verification runs after import timing and a full browser restart. The default `--media-check all` compares every installed image byte against the source ZIP through `getMedia`, using file-backed ZIP reads and bounded request batches. `--media-check sample` verifies 64 evenly spaced image paths while still requiring the complete persisted media count; reports label this explicitly. For repeated timing cohorts, run sampled checks each time and keep an independent exhaustive verification for each product version. VNDB contains 6,648,310 term rows and 146,570 images; term-only timings cannot substitute for its complete import.

The lock's `mediaFiles` and `mediaBytes` describe images referenced by dictionary content, which production imports. A complete JSON walk of the pinned Jitendex archive's 219 term banks and 436,555 rows found 627 image references covering 236 unique paths and 4,992,155 bytes. Its ZIP also contains 13 unused SVGs totaling 34,399 bytes, for 249 archive images and 5,026,554 bytes in total. Those 13 exact paths are pinned in `unreferencedMediaPaths`; the verifier requires each to exist once, checks the complete archive image count, and verifies every remaining referenced image. Missing or unlisted images fail verification. The whole ZIP's size and SHA-256 remain mandatory, and no archive is trimmed for benchmarking.

Reports also preserve logical OPFS file sizes and twelve production `termsFind` requests after restart followed by five warm passes. Lookup timings cover the settings-page RPC and exclude result hashing; the first pass is not a claim of cold operating-system caches. OPFS sizes include database and allocation files, not filesystem allocation overhead or browser profile size. Term content remains sampled; exhaustive media checks do not establish exhaustive term-content equality.

Normal import benchmark runs use production import globals (except the completion signal required by the harness) and disable the E2E page CPU profiler, phase screenshots, and browser-process sampling. Their total-import timer stops before test-only diagnostic reads. Import A/B comparisons default to five AB/BA-alternating pairs; use `--pairs` only when deliberately trading confidence for turnaround. Extra bulk-add debug logging is opt-in with `MANABITAN_AB_BULKADD_BYTES_METRICS=1`. `perf:import:trace` instead captures a browser-wide V8/DevTools trace ending at the import worker's `importDictionary` completion marker. Trace runs perturb execution and are marked `authoritativeTiming: false`; never use their wall-clock duration as a performance comparison.

Once the `Performance Bundle` workflow exists on the repository's default branch, it can be started manually or, for an open pull request, by an owner/member/collaborator commenting `/perf-bundle`; this makes it triggerable through the GitHub connector used by ChatGPT. It produces a workspace artifact containing the exact source snapshot, `node_modules`, generated libraries/build output, verified pinned dictionaries, and a manifest, plus a runtime artifact containing the exact Node runtime and matching Playwright browser cache. The manifest preserves the source SHA plus Node/V8/Playwright/Chromium versions and lockfile fingerprints even though `.git` is omitted. After extracting both artifacts, prepend the runtime artifact's `runtime/node/bin` directory to `PATH` and point `PLAYWRIGHT_BROWSERS_PATH` at `runtime/ms-playwright` before running tasks; `mise` is not required in the offline environment.

User Timing marks and measures are disabled in ordinary extension contexts to avoid retaining entries for every lookup and rendered result. To collect them deliberately, set `globalThis.manabitanPerformanceInstrumentationEnabled = true` in the realm being profiled; set it back to `false` when finished. `safePerformance.now()` and health/operation timings remain available regardless. The Chromium phase profiler and Firefox page profiler opt in explicitly.

The manual `Benchmarks (Manual)` workflow also compares a specified baseline commit with the dispatched commit on dedicated browser runners. Both arms use the same candidate measurement harness and pinned archives, select the `chrome` release package (so dev diagnostics do not bypass lookup caches), build before timing, and run in A1 B1 B2 A2 order. Separate lanes measure JMdict imports, Jitendex imports, and the complete lookup lifecycle. Artifacts preserve both package hashes, the deliberate baseline harness overlay, host load snapshots, raw reports, and failures. Import timing includes post-UI completion; hover observations include automation setup and pointer motion and must be read alongside their per-request scanner and popup timings. The first hover in that lifecycle follows production prewarm readiness; it is not a cold-backend measurement. A separate candidate import trace runs after the timing bracket and is never included in the timing comparison. Use `run_order=BAAB` for a reversed bracket and `workload=imports` for an import-only run. A comparison against a commit with identical product bytes provides a same-code control; package-entry hashes verify that identity. These short brackets screen a change; small or opposite-signed deltas require longer qualification.

## Acceptance and timing boundaries

`import-benchmark.js --build-target chrome` selects the release package; its default remains `chrome-dev` for existing callers. Reports record the requested target and package SHA-256. The Chromium E2E harness also accepts `MANABITAN_CHROMIUM_BUILD_TARGET=chrome`.

Each import uses a fresh browser profile, the pinned Playwright Chromium, and production import globals unless flags are explicitly supplied. The wrappers remove inherited `MANABITAN_E2E_*` and `MANABITAN_CHROMIUM_*` controls before applying their own settings. This prevents an invoking shell from silently enabling traces, changing browser flavor, skipping checks, or contaminating either A/B arm. Standard runtime variables such as `PATH` and `PLAYWRIGHT_BROWSERS_PATH` are retained.

A successful timing report must match the requested dictionary, trace mode and flags; contain exactly one matching structured import phase with a positive finite duration; and confirm an error-free OPFS import. After the timer stops, the harness checks the exact persisted dictionary title, revision and term count, then probes twelve distinct terms from the first, middle and last term banks for readable content. This is sampled content validation, not an exhaustive equality proof of every definition or a replacement for the functional E2E suite.

`timing` measures the page's file-input change event through the post-UI `manabitan:dictionary-import-complete` event using the browser's monotonic clock. `automationObservedTiming` retains file dispatch through automation-observed completion separately, including file-transfer and polling overhead. `workerTiming` measures the controller's worker-import RPC boundary. Do not compare these boundaries as though they were the same measurement. Completion signals UI readiness, not guaranteed physical paint; an optional next-frame timestamp is recorded separately. Browser startup, extension build, diagnostic reads and post-import checks are outside the browser interval. Internal parser, inflation, compression and sink counters overlap; they must not be summed into end-to-end time.

The total phase starts immediately before file-input dispatch and includes the trigger phase. Report validation rejects missing trigger timestamps or totals starting after dispatch. Older reports that timed only the post-dispatch wait are not comparable end-to-end measurements and must be rerun.

### Overflow layout comparison

Run `node dev/perf/overflow-layout-benchmark.js --baseline '98ecaa39^' --font /path/to/font.ttf --pairs 12`. The font must cover the ASCII fixture. This loads the actual popup CSS, compares baseline/candidate controller source, alternates adjacent AB/BA pairs, and requires identical initial, resized, and toggled geometry at 360px and 800px widths. Expanded/collapsed modes retain automatic overflow eligibility; the non-collapsible mode is a control. Font bytes, controller sources, CSS hashes, actual browser font identity, and host load are recorded. This measures entry insertion, overflow setup, and final layout, not complete popup, hover, or Anki latency.

Counts must be positive safe integers; malformed counts fail before browser launch. Missing diagnostic metrics and undefined percentage changes are represented as `null`, not zero. A/B output uses paired AB/BA ordering and fails with a nonzero exit status if either arm fails validation. A five-pair result is exploratory evidence, not by itself proof of a cross-device improvement.

Run regression coverage with `node ./node_modules/vitest/vitest.mjs run test/perf-benchmark-support.test.js`. Cached fixtures are replaced only after size and SHA-256 verification, using atomic rename; a failed download does not remove an existing cache file.

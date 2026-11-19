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

### Canonical content resolution component screen

`canonical-scan-benchmark.js` exercises the production WASM parser, `NativeCanonicalScanner`, exact content matcher and `DictionaryDatabase` metadata publication using every row of a pinned dictionary. It compares source checkouts with adjacent AB/BA pairs in alternating ABBA/BAAB brackets:

```sh
node dev/perf/canonical-scan-benchmark.js jmdict \
  --baseline-root /path/to/baseline --candidate-root /path/to/candidate \
  --brackets 3 --out builds/perf/canonical-jmdict.json
node dev/perf/canonical-scan-benchmark.js jmdict \
  --baseline-root /path/to/baseline --control \
  --brackets 3 --out builds/perf/canonical-jmdict-control.json
```

Both checkouts need generated `ext/lib` files and compatible dependencies. The runner uses its own dictionary lock and cache, verifies archive size/SHA-256 and ZIP CRCs, and records all JavaScript source hashes plus the executed WASM artifacts. Each observation runs in a fresh Node process with one full untimed warmup. Source or fixture changes within a cohort fail the run. Use `--order BAAB` to reverse the first bracket. `--control` measures identical baseline bytes in both arms. `--mode existing` first publishes the same complete dictionary outside timing, then measures resolution against existing content; the default `fresh` starts with an empty metadata index. Parser groups are fixed at seven JMdict banks, nine JMnedict banks or ten Jitendex banks, matching the existing parser component screen rather than asserting a particular browser scheduling decision.

The existing content mode is a duplicate continuation stress screen within one import session. Production `startBulkImport()` clears content metadata caches before each dictionary import, so this mode does not represent importing a second dictionary or updating a previously imported dictionary.

The measured interval is the sum of `_resolveArtifactTermContentDedup` calls. Parsing, modeled persistence, metadata publication and verification are outside that interval. The model stores owned canonical bytes in memory and gives the production exact matcher those complete bytes. Every resolved row, including aliases, is compared byte-for-byte with parser output. Reports also require equal references, plan state, metadata columns and stored-content digests across observations. Native counters expose whether the changed path actually ran. These checks establish component parity; they do not establish persisted browser-database parity.

The output is explicitly component-only. In-memory reads, warmup, fixed grouping, verification allocations and Node's runtime differ from browser import. Process RSS includes the source fixture and verification model and is not a production memory estimate. Use this screen to reject a candidate or justify full browser qualification; its percentages are not end-to-end import gains. Run timing serially on a quiet host, keep A/A results, and use the normal browser import and lifecycle checks before promoting an optimization.

The oracle's regression tests are `test/canonical-scan-benchmark.test.js`.

### Raw ZIP payload copy component screen

`raw-zip-copy-screen.js` serves the actual `RawZipPayloadReader` modules from two clean checkouts to the pinned Playwright browser. It verifies the locked JMdict archive and all 53 compressed term-bank payloads. Run Chromium and Firefox separately:

```sh
npx playwright install --with-deps chromium firefox
node dev/perf/raw-zip-copy-screen.js \
  --baseline /path/to/baseline --candidate /path/to/candidate \
  --zip builds/e2e-dictionary-cache/JMdict.zip --browser chromium \
  --output builds/perf/raw-zip-component/chromium.json
```

Repeat with `--browser firefox` and a separate output path. The driver can live outside both source checkouts. `--prepare-only` validates fixture and source provenance without launching a browser. Source commits and clean status must remain unchanged throughout the cohort; served module hashes must match the initial and final receipts. Dependencies, browser identity and executable hash are recorded.

There are four independent cells: ArrayBuffer or memory-backed Blob input, each through `read` or `readBatch`. Each cell has two excluded complete warmups per source arm, four alternating ABBA/BAAB comparison blocks and two same-code control blocks. Each observation reads all banks four times through fresh readers. The final report must contain all 120 observations, `completed: true`, an empty error field and 212 verified independently owned payloads per observation. Byte equality, payload digests, metadata, source mutation and transfer-ownership checks run outside timing. Failed or incomplete observations remain in the output.

The boundary includes fresh-reader Blob materialization, but excludes input creation, module loading, inflation, parsing and storage. All four passes retain their output until verification, unlike the production streaming importer. The batch cell invokes the API directly and falls back to `read` for a bank exceeding its unchanged budget; it does not demonstrate automatic importer dispatch. Treat any result as a reader-component measurement and qualify full imports separately.

### Complete Firefox JMdict source comparison

Status on 2026-11-19: the pinned Playwright Firefox/Selenium combination can crash during extension reload on both source arms. The full cohorts are incomplete and provide no comparative speed result. The preserved runs and failure analysis are in `import-experiments-20260914.md`; resolve that runtime issue before treating this driver as a stable qualification gate.

`test/firefox/jmdict-import-ab-benchmark.js` qualifies the raw ZIP copy change using two prebuilt Firefox release packages. It requires Linux, the repository-pinned Playwright Firefox 155.0 binary and geckodriver 0.37.1. Build each clean source checkout with its locked dependencies before running. Its package oracle permits exactly one differing shipped file, `js/dictionary/term-bank-source-pipeline.js`; the manifest and all other packaged files, including WASM, must agree.

```sh
node test/firefox/jmdict-import-ab-benchmark.js \
  --baseline-package /path/to/baseline/builds/manabitan-firefox.zip \
  --candidate-package /path/to/candidate/builds/manabitan-firefox.zip \
  --zip builds/e2e-dictionary-cache/JMdict.zip \
  --geckodriver /path/to/geckodriver \
  --output builds/perf/firefox-jmdict/smoke --mode smoke
```

Run `--mode prepare` for package/fixture preflight without a browser. After the separate smoke passes, repeat with `--mode cohort` and a new output directory. Each cohort uses 40 fresh Selenium profiles: four excluded complete warmups, twelve adjacent counterbalanced A/B pairs and six interleaved same-code A/A pairs. `--reverse-order` reverses the fixed schedule for an independent confirmation; preserve its output separately. Do not pool incomplete cohorts, change the schedule after observing timings or subtract control drift from the candidate effect.

The unchanged shared `test/e2e/import-timing.js` observer measures the current settings-page file-input change through post-UI import completion. No trace, screenshot or process sampler runs in that interval. The driver asserts production experiment options, OPFS storage without fallback, 526,942 imported rows, the expected 15,574,114 compressed/transferred source bytes, zero fused-parser and native canonical-dedup fallbacks, successful final publication and identical disjoint work/storage counters. It verifies twelve archive-derived expression/reading/glossary probes through actual lookup responses and checks persisted offset bounds and raw-content samples. It reloads the extension, verifies a new background time origin and repeats those checks outside timing. This is an extension reload, not a browser-process restart; sampled probes do not prove exhaustive persisted database equality.

The browser is the pinned headless Playwright Firefox build, with temporary extension installation and explicit shared-memory capability preferences recorded in the driver source. It is a controlled Linux qualification environment, not a claim about every Firefox distribution or device. Reports preserve package manifests/hashes, fixture and executable identities, timing receipts, failed observations and geckodriver logs. Initial and final hashes must match. The isolated CI workflow additionally records source commits/trees and checks the geckodriver archive SHA-256 before extraction.

The driver's syntax and scoped ESLint are checked directly. The existing `test/jsconfig.typecheck.json` excludes `firefox/**/*.js`; running that project does not establish strict type coverage for this driver.

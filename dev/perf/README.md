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

Without `mise`, invoke the corresponding Node/Vitest commands from `mise.toml` directly.

Real-dictionary performance runs use `test/perf/dictionaries.lock.json`. Cached archives are accepted only when their byte size and SHA-256 match the lock. Functional E2E continues to use the current recommended dictionaries unless `MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK=1` is set.

Normal import benchmark runs disable the E2E page CPU profiler, phase screenshots, and browser-process sampling during the measured run. Import A/B comparisons default to five AB/BA-alternating pairs; use `--pairs` only when deliberately trading confidence for turnaround. Extra bulk-add debug logging is opt-in with `MANABITAN_AB_BULKADD_BYTES_METRICS=1`. `perf:import:trace` instead captures a browser-wide V8/DevTools trace ending at the import worker's `importDictionary` completion marker. Trace runs perturb execution and are marked `authoritativeTiming: false`; never use their wall-clock duration as a performance comparison.

Once the `Performance Bundle` workflow exists on the repository's default branch, it can be started manually or, for an open pull request, by an owner/member/collaborator commenting `/perf-bundle`; this makes it triggerable through the GitHub connector used by ChatGPT. It produces a workspace artifact containing the exact source snapshot, `node_modules`, generated libraries/build output, verified pinned dictionaries, and a manifest, plus a runtime artifact containing the exact Node runtime and matching Playwright browser cache. The manifest preserves the source SHA plus Node/V8/Playwright/Chromium versions and lockfile fingerprints even though `.git` is omitted. After extracting both artifacts, prepend the runtime artifact's `runtime/node/bin` directory to `PATH` and point `PLAYWRIGHT_BROWSERS_PATH` at `runtime/ms-playwright` before running tasks; `mise` is not required in the offline environment.

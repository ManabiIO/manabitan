# Activation diagnostic failure and correction

Run `45468163108` used tooling commit `81ebec7d94cea24c0b2b1ec88af78187b193905b`. All four jobs passed the exact source commit/tree, fixture-lock hash, instrumentation patch equality, and build checks. The runtime source candidates remain unchanged.

| Job | Observation | Outcome |
|---|---|---|
| 138708561509 | Prefix JMdict | Complete import and native verification succeeded; activation phase was absent. |
| 138708561743 | Cache JMdict | Complete import and native verification succeeded; activation phase was absent. |
| 138708561878 | Prefix Jitendex | Failed before browser startup or any reported phase, after approximately 120 seconds, with an aborted-operation timeout. |
| 138708562011 | Prefix VNDB | Complete import and native verification succeeded; activation phase was absent. |

The three successful import reports identify their database runtime as `js/background/offscreen-dictionary-worker.js`. The original instrumentation initialized and exported events only in `DictionaryWorkerHandler.importOnce`, which is the fallback entry point. Production offscreen imports therefore never initialized the temporary collector. The report collector's `phases[*].data.importDebug.importerPhaseTimings` path is correct; the phase was not present in the raw report.

The Jitendex report has no browser version, `launchMode: unknown`, zero phases, and a null validation receipt. The native harness prepares locked dictionaries before launching Chromium, and its fixture fetch has the matching 120-second abort signal. This supports a fixture-setup timeout diagnosis; the retained report does not identify which fixture URL was pending. No Jitendex import or valid activation observation was collected.

## Retained artifact archives

All archives were downloaded using the GitHub artifact tool, checked against the API SHA-256 digest, and extracted after rejecting absolute paths, parent traversal, duplicate names, backslashes, and symlink entries. Raw job logs and raw reports remain alongside them.

| Artifact | SHA-256 |
|---|---|
| 14954079813 — prefix JMdict | `13aa0c8a5d3bcbdb23d5b60ca4a072029647f9022ed2cb74b9dbe3f45da1855a` |
| 14955703235 — cache JMdict | `8e78fa217abf3931f25ede0f31f4c9e464deb3602709e9d292e7d94a22cc973f` |
| 14955817640 — prefix Jitendex | `8db4405f1c0386b583e370d0c3989fa541f0dffc08b74b9d699f8c97b52724df` |
| 14956350395 — prefix VNDB | `e2fcd6ee2a6675ca4a64ccefc05562ce7c36674d6b6713b8aa714725939bb62f` |

## Corrected tooling

Local commit `62d238aad6d97a64c7702a09c7406c08fce9c7fd`, tree `02fd3a7018bd0025141f178bd3ca35b3d7244a85`, changes only the same four activation tooling files. Publication manifest: `/workspace/scratch/3aacd533c01f/round2/activation-correction-publication-plan.json`.

Both diagnostic patches now initialize and export events around the production offscreen importer call as well. This phase identifies `owner: offscreen`, which the summarizer requires. The fallback instrumentation remains available, but it cannot satisfy the production-owner check. No production branch, format, budget, fallback behavior, or await dependency changes.

The workflow prepares and verifies the full native setup fixture set before the diagnostic invocation: JMdict, JMnedict, Jitendex, plus VNDB when selected. It preserves the original download timeout and makes no retries. All resulting fixture preparation logs are retained.

Validation completed:

- A focused witness invoked the actual offscreen handler and its completion port with mocked importer work. It proved collector initialization, structured-clone transport through `importerDebug.phaseTimings`, the offscreen owner label, and collector cleanup. One test passed; its source is retained as `import-activation-transport.test.js` in this evidence directory.
- Four synthetic valid offscreen event cases passed; four matching wrong-owner cases failed. These are extraction tests, not browser activation observations.
- Reprocessing all three retained missing-phase reports still fails, so the correction does not reclassify failed observations as successful.
- Actionlint, Python compilation, JavaScript syntax, reverse patch checks, formatting, and diff checks passed. The normal Husky pre-commit hook ran.

No corrected browser diagnostic was run locally. All original failed observations remain failed. Corrected activation counts are pending a new diagnostic workflow execution.

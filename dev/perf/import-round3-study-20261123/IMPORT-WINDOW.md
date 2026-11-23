# Prospective private-buffer import-window memory study

This study asks whether the unchanged byte-admission policy, applied to the private-buffer baseline, changes sampled Chromium process-tree PSS and private memory **during the recorded importer interval**. It is a separate experiment with its rules fixed before collecting its hosted observations. It does not reclassify the earlier full-lifecycle experiment or compute new maxima from its data.

## Fixed scope and source

The two immutable runtime arms are specified in `candidates.json` under `privateMemory`: baseline `1e235059a4c05c2509e8757fccba43a2d60222df` and candidate `f6ae9bcdd0bfc43aa0f13ad6b500bc2179541f26`. Both use private owned content buffers. The packaged differences must be exactly `js/dictionary/dictionary-importer.js` and `js/dictionary/term-bank-wasm-parser.js`. The common preparation code verifies source commits and trees, dependency locks, harness overlays, complete packaged member maps and the pinned dictionary archive before observation.

The scope rule is `recorded-importer-complete-scans-v1`. Its boundaries come from the retained structured `importDebug.importerPhaseTimings`, bound exactly to the unique fixture's `: total import` report phase and the summary's identical debug record:

| Boundary | Required marker and field                       | Meaning                                               |
| -------- | ----------------------------------------------- | ----------------------------------------------------- |
| Start    | `archive-and-index.startEpochMs`                | Beginning of archive/index work                       |
| End      | `post-finalization-integrity-sample.endEpochMs` | Post-commit marker after successful bulk finalization |

The endpoint name is historical. In the pinned importer it has `skipped: true`, `reason: "transaction-commit-completed"` and the expected dictionary term count. **It does not measure an additional integrity-sampling operation.** The study requires those exact details, a successful archive marker naming the pinned archive size, and successful bulk finalization before the endpoint. The source is [the pinned baseline importer](https://github.com/ManabiIO/manabitan/blob/1e235059a4c05c2509e8757fccba43a2d60222df/ext/js/dictionary/dictionary-importer.js), with the [candidate importer](https://github.com/ManabiIO/manabitan/blob/f6ae9bcdd0bfc43aa0f13ad6b500bc2179541f26/ext/js/dictionary/dictionary-importer.js) retained separately by source identity.

All three required markers must be unique. Every importer phase must have finite, ordered integer epoch bounds, matching elapsed milliseconds, and lie inside the chosen interval. The archive start must precede bulk finalization and the endpoint in the recorded marker order. Missing, ambiguous, failed or inconsistent markers reject the scoped result.

## Scan selection and unchanged failure rules

The sampler runs throughout the same full browser lifecycle as before. Its complete schema-3 `chromium-memory.json` is retained without modification, including its original full-lifecycle qualification, every failed scan, every unavailable address space and every sibling-recovery proof.

The new result selects **all and only whole scans** whose recorded start and finish are both within the inclusive importer bounds. A scan that overlaps either boundary is excluded in full. The collection must enclose the complete interval; nonfinite, reversed, overlapping or backward sampler timestamps reject the scoped result. Selected and excluded original indices are recorded explicitly.

The frozen `stable-zombie-leader-live-sibling-smaps-v1` observer's `summarize_samples` rules run on **every selected scan**, including unqualified scans. A stable unreadable address space, denied read, malformed sibling proof or persistent identity failure inside this interval still rejects the scoped observation. Expected process exit during a changed tree rejects that scan under the existing rule. No scan is removed because its memory value or failure is inconvenient. The observer implementation and its real Linux process witnesses remain unchanged.

Two additional requirements apply, fixed prospectively:

- At least **three qualified scans** inside the interval.
- At least **250 ms from the first qualified scan's start to the last qualified scan's start**.

Both are required. Failed scope qualification yields null PSS/private maxima and no paired comparison. The output keeps the original full-lifecycle qualification alongside the separately named `qualifiedForImportWindowPss`; success in the narrower interval does not turn a failed full-lifecycle receipt into a passing one.

## Fixed observations and correctness gates

For each of JMdict, Jitendex and VNDB, replication 1 uses `ABBA` and replication 2 uses `BAAB`. Each replication has four fresh imports, two observations per arm, and two adjacent A/B contrasts. All four observations are retained, even if an earlier import, readback or memory qualification fails. There are no retries or replacement observations.

Every successful import must pass the existing complete readback guards for all 12 predeclared term probes before and after restart: public semantic responses, physical storage previews, derived readable counts and fixture row counts. Cross-arm public semantic **and physical** results must match exactly. No physical-reference-layout exception applies to this private-buffer comparison. Cross-arm readback is checked whenever all four individual readbacks are available, even if a memory observation fails. Both A/B contrasts are produced only after all four scoped memory observations and all readback guards pass.

The original summary and report may contain elapsed times because the common import harness records them. Every memory observation, plan and comparison is explicitly `authoritativeTiming: false`. No timing from these sampled runs is performance evidence; the separate unsampled study supplies timing observations.

## Outputs and limitations

The memory runner is `run_import_memory.py`. It writes beneath `builds/import-round3-study/memory/private-budget/{dictionary}/{replication}`. Each observation retains the original `chromium-memory.json`, report, summary, identity and log, and adds `import-window.json` only when the scope can be derived. `observations.json` retains all four results and failures; `import-window-comparison.json` records scoped qualification, exact readback status, the original full-lifecycle qualification list and any allowed contrasts.

This measurement answers the importer-interval question only. Startup, later readback, restart and cleanup remain visible in the raw receipt but are outside the new comparison. PSS apportions shared pages, individual process reads are non-atomic, and scans can miss short-lived processes and peaks between scans. JavaScript `Date.now()` markers have millisecond precision, while the observer uses the same host's wall-clock epoch. The guards reject observed backward time but cannot detect every intervening wall-clock adjustment or scheduling gap. Three scans over 250 ms establish minimal coverage, not a complete peak measurement or full-lifecycle memory nonregression.

The prospective rules and tests use synthetic records only. They were not tuned by calculating scoped maxima from the previous experiment. Before hosting, run:

```sh
python -m unittest discover -s dev/perf/import-round3-study-20261123 -p 'test_import_window.py' -v
python -m unittest discover -s dev/perf/import-round3-study-20261123 -p 'test_*.py' -v
```

These tests exercise exact/partial boundaries, both minimum coverage gates, outside versus inside failures, unchanged denial and recovery rules, marker ambiguity, malformed timestamps, preservation of failed observations, exact physical readback and the fixed schedules. They do not launch a browser or run dictionary imports.

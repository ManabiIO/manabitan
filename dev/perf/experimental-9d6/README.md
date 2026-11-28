# JMdict registration component experiment

This temporary experiment measures synchronous in-flight source registration. It uses the frozen `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` baseline and the exact source patch recorded in `manifest.json`. The runtime file in the measurement branch remains unchanged: the runner creates a detached baseline worktree, checks and applies `inflight.patch`, and verifies the resulting source hash before running focused correctness tests and lint.

Use Node 24.22.3. Prepare the baseline with `npm ci` and `npm run build:libs`, and prepare the exact JMdict archive with `node dev/perf/prepare-dictionaries.js jmdict`. The parser WASM already has a vendored, verified identity; capture does not require a compiler.

```sh
node dev/perf/experimental-9d6/capture.mjs BASELINE_ROOT BASELINE_ROOT CACHE_DIR CAPTURE_DIR jmdict 4 8
node dev/perf/experimental-9d6/run.mjs BASELINE_ROOT CAPTURE_DIR OUTPUT_DIR AB
```

Use a second isolated host and a fresh output directory with `BA`. The checked-in workflow does this for registration and the separate codec experiment, after a shared baseline capture job.

The capture runs the actual source planner, native parser workers, and canonical content resolver. It verifies all 528,299 term rows against their encoded source bytes and records 362,032 pending source spans in 12 groups. Gzip files carry compressed and serialized hashes. Capture instrumentation and persistence substitution make its phase timings unsuitable as performance observations.

Replay restores shared source slabs and private typed metadata. Pending lengths alias the source lengths, matching `_beginAppendSharedSpans`. Persisted offsets are deterministic virtual sequential addresses. Source decompression, column preparation, frozen-container creation, and explicit GC happen outside registration timing. These choices are recorded in every observation.

The warm cohort uses three complete warmups and all six A/B/C permutations, with 16 corpus passes per observation. A and C use identical baseline source; B uses the candidate. `retain0` matches the current production topology with no prior active batch. `retain2` is a synthetic overlap stress case and is reported separately.

The cold cohort repeats the same six balanced permutations with each arm in its own fresh Node process. No registration call precedes the measured first corpus. Both source modules are imported in every process; preparation is identical. Correctness checks run after the cold measurement. Raw process receipts, source identities, controls, failures, and all observations remain in the output directory.

These results establish a component signal only. They do not measure compression, OPFS, the browser import critical path, first lookup, or browser memory. Node/V8 versions are explicit because cold tier behavior can differ from Chromium. A browser qualification remains necessary before a whole-import improvement can be claimed.

Upload the output directory's top-level JSON and log files. The `source-candidate` directory is a reproducible worktree and does not need to be uploaded. The shared capture artifact contains its report, gzip inputs, and capture logs.

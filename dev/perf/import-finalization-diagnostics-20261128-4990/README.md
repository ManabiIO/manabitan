# JMdict finalization operation diagnostics

This study identifies the operations inside the ordinary record-store close region. It is research instrumentation, not an import optimization candidate, and supports no comparative performance claim.

The baseline is frozen at `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The diagnostic arm is the exact study commit, with the three instrumented runtime files additionally bound to SHA-256 values in `protocol.json`. All native modules, production import settings, browser automation, timing boundaries, dictionary fixtures, and lookup/storage/media verification remain identical. The driver records the exact runtime diff, complete release packages, decoded package member hashes, source hashes, browser identity, host context, raw reports, and semantic receipts.

Each independent GitHub runner imports the locked JMdict archive into six fresh browser profiles. Host 1 runs A,D,A,D,A,D; host 2 runs D,A,D,A,D,A. A is ordinary baseline context. D records per-shard descriptor queue wait and asynchronous close; lookup pending flush, header construction, seek, write, and close; and, inside the existing local synchronous writer, queue wait, `flush()`, and `close()`. The existing await graph and descriptor/index overlap are retained. No process-memory observer or CPU tracing runs. The first import is retained; there are no excluded warmups, retries, replacement observations, trimmed tails, performance ratios, confidence intervals, or cross-host pooling.

The standard benchmark harness derives its `authoritativeTiming` field from its own tracing configuration and does not detect research source instrumentation. Its untouched raw reports are retained, while every observation has an explicit `classification.json` and the study analysis sets `authoritativeTiming: false`. Instrumented duration fields must never be treated as ordinary performance qualification. Three ordinary imports on each host provide duration context only.

The new metrics flow through the existing `bulk-finalization` details into the native import report. Descriptor and lookup intervals overlap; writer intervals are nested. They cannot be added to estimate CPU time or whole-import savings. Asynchronous API waits include scheduling and I/O. Synchronous `flush()` and `close()` measurements identify the corresponding blocking calls, without claiming which kernel work those calls perform.

All six imports must pass the unchanged full semantic receipt validator, including restart, twelve probes and all 72 public lookup observations, exact storage inventory, content digest, and complete media verification (JMdict has no media). The diagnostic importer must use exactly one local SAH writer and record one final flush and close. Failures stop acquisition and are uploaded with completed observations and the unattempted plan. The workflow separately runs the full unit suite, main type check, and all dry build targets.

Run on the pinned browser host:

```sh
python3 dev/perf/import-finalization-diagnostics-20261128-4990/run.py --host 1 --evidence /tmp/finalization-evidence
```

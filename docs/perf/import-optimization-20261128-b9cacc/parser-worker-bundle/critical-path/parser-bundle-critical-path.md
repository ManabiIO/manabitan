# Parser worker bundle: baseline startup boundary

This trace supports the mechanism for bundling: in this JMdict import, the parser pool became ready before the first compressed-source loaders were activated. The approximately 22 ms between the last ready message and the first parse delivery therefore contains subsequent source work. It is not evidence that source reads hid worker startup.

## Provenance

- Exact clean baseline: [9e10d3b3fcf66d344ab31bc42c9b522fa5215da2](https://github.com/ManabiIO/manabitan/commit/9e10d3b3fcf66d344ab31bc42c9b522fa5215da2).
- Hosted acquisition: [run 46102776159](https://github.com/ManabiIO/manabitan/actions/runs/46102776159), artifact 15245833865, archive SHA-256 `af90ccebb72dab5c90f7ba48739db1b02211f7d3e86a2866db8ae30a72bdc3c0`.
- Packaged extension SHA-256: `ff679658d4155495d21b1ca6d08e5944e8f83a927513f969b0d8116d60c58cb4`.
- JMdict 2026-11-22, 528,299 rows; source archive SHA-256 `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`.
- Chromium 153.0.8010.12; four logical CPUs, three production-selected parser workers.
- Raw trace: `trace/run-1.trace.json`; source/runtime manifest: `acquisition.json`; complete sampled parent stacks retained in `parser-startup-parent-cpu.json`.
- The trace is diagnostic and explicitly nonauthoritative for elapsed import timing. Its separate ordinary reference is a single observation, not an A/B comparison.

## Reconstruction

The parent dictionary worker is thread 3541; the parser workers are threads 3589, 3590 and 3591. Timestamps below are trace microseconds.

| Event | Timestamp | Evidence |
| --- | ---: | --- |
| Importer starts prewarm | 311893144 | CPU sample: importer → prewarmParallelTermBankParser |
| Compressed lazy parsing is entered | 311893977 | CPU sample: _readTermBankFileFast → parseTermBankWithWasmColumnChunksParallelCompressedLazy |
| Pipeline waits for the parser pool | 311894346 | CPU sample: run → waitForParallelWork |
| Initialization messages sent | 311896962–311897099 | Parent SchedulePostMessage events at the production initialization callsite |
| First ready message handled | 311943917 | HandlePostMessage matched to worker initialize's ready-message trace ID |
| Last ready message handled | 311949417 | HandlePostMessage matched to worker 3591's ready-message trace ID |
| Lead sources activated | 311949911 | CPU sample: run → _runPipeline → _activateLeadSources → loadParallelTermBankSource |
| Raw archive read begins | 311950243 | CPU sample additionally contains readCompressed → RawZipPayloadReader.read → _getArchiveBytes → arrayBuffer |
| Parent waits for source bytes | approximately 311951013–311960082 | Consecutive idle samples |
| Parent processes raw source bytes | approximately 311960240–311969583 | Samples in RawZipPayloadReader.read |
| First parse posted | 311970854 | Parent SchedulePostMessage at the production parse callsite |
| First parse handled | 311971025 | Parser worker HandlePostMessage matched by trace ID |

The source ordering is explicit: [ParallelTermBankPipelineRun.run](https://github.com/ManabiIO/manabitan/blob/9e10d3b3fcf66d344ab31bc42c9b522fa5215da2/ext/js/dictionary/term-bank-wasm-parser.js#L2949-L2975) awaits the pool before _runPipeline activates lazy sources. [The importer](https://github.com/ManabiIO/manabitan/blob/9e10d3b3fcf66d344ab31bc42c9b522fa5215da2/ext/js/dictionary/dictionary-importer.js#L2149-L2160) initiates prewarm shortly before entering this path. The trace shows that the compressed-lazy path was actually selected and that activation occurred directly after the last ready callback.

## Limits and next decision

There are approximately 55 ms between the sampled pool wait and the last ready callback in this instrumented run. That is an observed dependency interval, not a prediction of how many milliseconds bundling will save. CPU sampling includes small negative time deltas and timestamp jitter; the retained samples should establish ordering, not be treated as exact function spans or summed attribution.

The local HTTP screen used five workers and much larger module-fetch overhead than this extension trace. Its roughly 80% startup reduction must not be carried over to whole-import results. A separate candidate trace could later compare module counts, readiness, source activation and first parse, but the frozen ordinary AB/BA qualification determines whether the candidate has a useful full-import gain.

The active bundle experiment is [run 46104747758](https://github.com/ManabiIO/manabitan/actions/runs/46104747758), frozen at `9da7dedd17535b4a0f8edb97e56756049bbad7a7`. No early-source-activation change is included or proposed; parent review identified prior #765 as a rejected direction.

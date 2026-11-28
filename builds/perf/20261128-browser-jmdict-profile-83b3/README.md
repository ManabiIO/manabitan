# Frozen JMdict browser trace readback

This is an offline analysis of the already completed baseline trace from [PR #973](https://github.com/ManabiIO/manabitan/pull/973), [run 46104197268](https://github.com/ManabiIO/manabitan/actions/runs/46104197268), job `140853159231`, artifact `15248139923`. It performs no browser acquisition and contains no candidate comparison. The source is the unchanged `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` baseline. This artifact is separate from the pending ownership qualification for PR #820.

The readback identifies the sampled import worker, all three parser workers, and all four compression workers. It also includes settings, background, and SQLite proxy threads. The apparent large SQLite proxy frame contains `Atomics.wait`; its sampled occupancy must not be presented as CPU consumption. The largest observed work frames lie in native parsing and inflation, compression, and record publication. These observations identify work to investigate; they do not establish a speedup or an amount of removable time.

## Fixed input and source proof

| Input                                                               |      Bytes | SHA-256                                                            |
| ------------------------------------------------------------------- | ---------: | ------------------------------------------------------------------ |
| Original artifact ZIP                                               | 34,013,156 | `b0dc59b4ffe9ff0d85a0a752255537431b24475c7ba15626f2342f1dc40ef775` |
| Baseline package A                                                  | 16,805,714 | `8f21192b9e4a15261fd188604c1f0d3245b095e35f529948926c0a5366b0dd22` |
| Raw trace                                                           |  5,080,630 | `3beac18db05dad6198e2b40695b8e9c3eb0bf94622b57b413be41a5056a5351e` |
| Locked JMdict archive, as recorded by the original verified harness | 15,645,766 | `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f` |

[bindings.json](readback-v2/bindings.json) preserves every original artifact member's size and digest. Every one of the baseline package's 554 file members matches both the original frozen package inventory and the prepared clean baseline checkout's `ext/` bytes. Its 65 zero-byte directory entries are validated as safe paths. The baseline Git tree is `d99ea4d04658f7ec1c76acdc5f3684594212a471`.

The recorded fixture identity, package lock, fixture lock, import harness sources, browser identity, and successful run receipt are bound together. The browser was Chromium `153.0.8010.12`; its frozen executable SHA-256 is `8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e`. The original host reports Node `v22.22.0`, four available logical CPUs, and an Intel Xeon 6975P-C. The analyzer does not use local browser execution or change production flags.

The original successful receipt records all 528,299 JMdict rows, readable content, 12 selected probes, 72 lookup observations across six passes, and a successful restart. Its output digest is `e88726c0d84ad9f6e9b7cf4455783fee169a41bf0cbfe3252386cec59791117d`. Media verification used `all`; this fixture has zero media files. These are the original harness's verification boundaries, not a newly performed exhaustive record comparison.

The compact archive retains the full raw trace and all eleven non-package members from the original artifact. It retains complete package-member inventories and hashes, while the two original product ZIPs remain obtainable from the source artifact. Rechecking the outer artifact and package bytes requires that original artifact; the saved trace and binding receipts remain available for independent analysis after extraction.

## Profile reconstruction

[analyze.py](analyze.py) follows the primary [DevTools SamplesHandler](references/SamplesHandler.ts) and [CPUProfileDataModel](references/CPUProfileDataModel.ts) conventions for ownership and sample timestamps:

1. Join `ProfileChunk` events by `(pid, profile id)`. Take the sampled owner's TID from its `Profile` head. Chunk-emitter TIDs do not identify the sampled worker.
2. Use the head event's translated `ts`, rather than assuming `args.data.startTime` has the same clock domain.
3. Accumulate signed `timeDeltas`, then stably sort timestamp/sample pairs. This trace contains 417 negative deltas; none is discarded, clamped, or converted to an absolute value. All chunks are already ordered by timestamp within their profiles.
4. Attribute an observed interval forward from a sample timestamp to the next observed sample. Leave the initial gap and final sample's duration unassigned. The analyzer does not invent a mean final interval or apply DevTools' program-node gap repair.
5. Retain idle, GC, runtime, wait-capable proxy, bridge, and explicit instrumentation categories. Function tables are sampled-stack occupancy estimates. They can include scheduling delays or native waits and are not on-CPU measurements.

The full analysis retains every profile, frame aggregate, category, interval maximum, owner TID, emitter TID, and sample count. The raw trace preserves all tails. `RunTask` wall intervals are reported separately per owner thread; they are not added across threads or called CPU time.

| Actual owner role         | Threads | Samples |
| ------------------------- | ------: | ------: |
| Parser workers            |       3 |   9,192 |
| Compression workers       |       4 |   8,712 |
| Dictionary import worker  |       1 |   4,219 |
| Settings renderer         |       1 |   5,388 |
| Background service worker |       1 |   4,413 |
| SQLite asynchronous proxy |       1 |   5,900 |
| Total                     |      11 |  37,824 |

There are 23,210 trace events, 11 profile heads, 447 profile chunks, and 444 chunks containing CPU-profile data. Fourteen TIDs emit those chunks. The original instrumentation receipt's fourteen-thread count described emitters; this readback resolves eleven sampled owners without dropping any sample.

The proxy's `f` frame at packaged `sqlite3-opfs-async-proxy.js` line 454 spans 1,138.045 ms of observed sample intervals. Its source loop includes `Atomics.wait` and request dispatch. This is explicitly classified as wait-capable occupancy, without pretending to separate its waiting and dispatch portions from the sample alone.

## Descriptive sampled work

The following numbers are sums of observed forward intervals attributed to sampled leaf frames. Parser and codec rows combine concurrently running workers. They cannot be added to the import's elapsed time or used as predicted savings.

| Frame                                            | Role                 | Samples | Observed forward intervals, ms |
| ------------------------------------------------ | -------------------- | ------: | -----------------------------: |
| `parse_composite_span_impl`                      | Three parser workers |   1,261 |                        275.258 |
| `parse_and_encode_term_bank_token_binary_dedup`  | Three parser workers |   1,003 |                        221.122 |
| `libdeflate_deflate_decompress_ex`               | Three parser workers |     728 |                        195.417 |
| `crc32_bytes`                                    | Three parser workers |     568 |                        123.550 |
| `parse_row_single_pass`                          | Three parser workers |     400 |                         85.901 |
| Worker `parseTermBankWithWasmColumnChunks` frame | Three parser workers |     318 |                         82.717 |
| `hash_content_xxh32_pair`                        | Three parser workers |     250 |                         57.820 |
| `encode_term_content_token_binary_row`           | Three parser workers |     260 |                         51.340 |
| `copyWasmBackedColumnChunk`                      | Three parser workers |     113 |                         23.916 |
| `_encodeArtifactRecordFields`                    | Import worker        |     145 |                         51.302 |
| `scan_canonical`                                 | Import worker        |     255 |                         44.070 |
| `_cacheRecentPublishedTermContentSources`        | Import worker        |      84 |                         29.937 |
| `_registerInFlightTermContentSources`            | Import worker        |      66 |                         27.847 |
| `_encodeAndAppendArtifactChunkForState`          | Import worker        |      92 |                         24.548 |
| `_createLookupIndexChunk`                        | Import worker        |      92 |                         19.811 |

Across the four codec workers, packaged Zstd WASM frames account for 479.298 ms of sampled intervals, and packaged JavaScript frames account for 113.547 ms. The codec `postMessage` frame accounts for 142.337 ms; this can include transfer or scheduling behavior and is not a measured serialization cost. Private Zstd function indices are retained without invented symbol names. The import worker's 37.697 ms of GC sample intervals is also retained separately.

The trace reinforces the existing investigation boundaries. Native glossary scanning, CRC, and compression have prior active studies; these numbers do not make those mechanisms new proposals. The registration frame provides current browser attribution for the separately reviewed #830 question. Its sampled interval is not a promise that a candidate can remove that amount of wall time.

The original diagnostic recorded a 1,008.9 ms browser import interval and an 827.1 ms worker interval. Tracing was enabled, so these are diagnostic observations only. The original harness begins tracing before the file-input import and stops around worker completion, before its restart and lookup checks. This trace has no import-specific user-timing marks with which to invent a more precise trace cut point. No candidate, control, memory qualification, or uninstrumented timing conclusion is drawn from it.

## Native-name inference

The source-bound symbol proof is copied unchanged to [native-symbol-proof.json](readback-v2/native-symbol-proof.json), SHA-256 `263ca8e77c4932c41db6a3f2c96f89697e32c91b19041a3d99c2e37e01438a69`. Its exact LLVM 21.1.8 release builds match the pinned binaries, and its named builds match every non-custom section. The complete toolchain and section proof are preserved in the [earlier evidence bundle](https://github.com/ManabiIO/manabitan/tree/bc26b191ba38d3b5cfd90d4c88584883720d267c/builds/perf/import-owned-columns-83b3-followup).

Names are inferred only where all numeric frame indices and byte-column locations for a URL uniquely match a proven packaged module's code bodies. The parser URL `wasm://wasm/0004212e` has 23 numeric frame locations matching the pinned parser binary `8ae00698…`. The canonical URL `wasm://wasm/34e657a2` has one numeric location: function index 4, byte column 204, matching `scan_canonical` in the pinned canonical binary `40948d5c…`. Its observed parent chain reaches `_scan` in the packaged `term-content-canonical-scan.js` at line 159. This is a code-body signature inference, not a cryptographic extraction of the module from the running browser. V8 bridge frames remain unnamed and separate.

[independent-readback-v2.json](independent-readback-v2.json) records a separate recomputation of every profile and aggregate frame count and interval from the raw samples. That review confirms chunk chronology, actual owners, local baseline file hashes, and native body/name matching. It explicitly records that its own pass did not reopen the outer ZIP; the successful analyzer's separate outer/package binding remains preserved in `bindings.json`.

## Endpoint correction for the earlier Node profiles

[SAMPLING-NOTE.md](SAMPLING-NOTE.md) adds a correction to earlier descriptive Node tables. The first `timeDelta` is the unassigned gap from profiling start to the first observation. An `inspector/post` first stack does not turn that gap into a measurement of profiler startup, profile-stop work, or product CPU. All original profiles, tables, manifests, and archived bytes remain unchanged.

The exact compressed-worker endpoint audit is [compressed-profile-gap-audit.json](compressed-profile-gap-audit.json), generated by [audit-sampling-gaps.py](audit-sampling-gaps.py). The twelve group profiles partition into 184.826 ms of initial gaps, 901.080 ms between first and last samples, and 2.943 ms of terminal gaps. The initial profile has a 31.921 ms initial gap, a 16.252 ms observed span, and a 0.282 ms terminal gap. These sums are descriptive boundaries, not new runtime measurements.

## Reproduce this readback

The [compact evidence archive](evidence.tar.gz) is described by [ARCHIVE-MANIFEST.json](ARCHIVE-MANIFEST.json). [verify-archive.py](verify-archive.py) checks the outer digest, every member's exact bytes and Git-blob digest, member safety, and the embedded contents manifest without extracting or executing payloads:

```sh
python3 verify-archive.py
```

Keep the verifier, manifest, and archive together when downloading them. [build-archive.py](build-archive.py) documents the exact payload selection and normalized tar metadata. It refuses to overwrite an existing archive or manifest.

The analysis needs Python 3.9 or newer, Git, the original fixed artifact ZIP, and a clean prepared baseline checkout whose generated `ext/` assets match the original package. No npm, browser, or compiler process is launched by the analyzer. Use a fresh output directory:

```sh
python3 analyze.py \
  --artifact /path/to/jmdict-baseline-cpu-15248139923.zip \
  --baseline-root /path/to/manabitan-at-9e10d3b3 \
  --native-proof readback-v2/native-symbol-proof.json \
  --output /path/to/new-browser-trace-readback
```

The script checks the artifact, baseline source, package members, locked fixture metadata, harness and original receipt before deriving profile statistics. The successful analyzer SHA-256 is `6dbda22c5a8b7690a6faaf3f774fd1d1091e9822d1ab395f5596ea74ee55c5bc`; its analysis SHA-256 is `714c9aa2b46b4be653683b725d54062511a02180d199aece96f3e0bf47e58190`. [summary.json](readback-v2/summary.json) is a compact machine-readable result; [analysis.json](readback-v2/analysis.json) preserves all aggregates.

The first offline attempt stopped on an analyzer assertion that assumed both proven native modules imported nothing. The canonical module imports only `env.memory`; neither module imports functions. The corrected fixed-module check preserves function indices. The failed source, log, and failure JSON are retained. It collected no new samples and changed no product source. Duplicate copies of its already-retained raw artifact members are omitted from the compact archive.

Primary reference snapshots and their original licenses are included under `references/`. Their URLs and reported modification dates are in [sources.json](references/sources.json). They document the analysis method and are not claimed to be the exact DevTools source revision bundled with this Chromium build.

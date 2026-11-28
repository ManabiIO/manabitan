# Current JMdict compressed-worker attribution

One baseline diagnostic completed all **53 banks, 528,299 rows and 12 policy-3 groups**. Every group matched the prior complete v3 baseline receipt for its full digest, stable digest, transfer buffers and owned-content bytes. All 12 parent ownership receipts succeeded, and all 16 product source hashes were unchanged before and after. The independent readback verified every raw profile hash and the aggregate sample arithmetic.

This fills the compressed-source attribution gap in the earlier decoded-input profile. It is a single sequential Node diagnostic with cold initialization and a cold first group, not a browser import, candidate comparison, throughput estimate or expected saving. There is no repeated acquisition or performance qualification in this archive.

## What the profile locates

The product's `sourceInflateMs` counter was **215.156 ms**. It includes immediate CRC validation. The separate `sourceCrcMs` counter was zero because JMdict did not use the deferred CRC path; validation was not skipped.

| Native function                                 | Function index | Sampled self time, all 12 groups |
| ----------------------------------------------- | -------------: | -------------------------------: |
| `parse_composite_span_impl`                     |             13 |                       170.695 ms |
| `libdeflate_deflate_decompress_ex`              |             48 |                       140.915 ms |
| `parse_and_encode_term_bank_token_binary_dedup` |             36 |                       117.813 ms |
| `crc32_bytes`                                   |              2 |                        70.306 ms |
| `encode_term_content_token_binary_row`          |             27 |                        62.062 ms |
| `hash_content_xxh32_pair`                       |             24 |                        46.076 ms |
| `parse_row_single_pass`                         |             18 |                        45.154 ms |
| `encode_term_lookup_index`                      |             34 |                        11.904 ms |
| `build_decode_table`                            |             49 |                         3.236 ms |

The decompressor, CRC and decode-table self samples total **214.457 ms** in this observation. The profile now shows that CRC is a substantial part of the compressed-input phase. These sampled values describe the observed work; they do not establish an achievable optimization or justify duplicating existing native experiments.

The worker's result callback had 79.558 ms of sampled self time, and `copyWasmBackedColumnChunk` had 14.516 ms. The corresponding product `resultCopyMs` counter totaled 100.764 ms. Other response counters were `parseBankMs` 511 ms and `lookupIndexPrepareMs` 25.686 ms. Counters use different boundaries and can overlap: `bufferSetupMs` and `chunkDispatchMs` must not be added to these values to infer a wall time.

All group profiles together contain 1,085,906 microseconds of sampled self time. **184.826 ms belongs to `node:inspector` `post`**, primarily profile-stop instrumentation, and is excluded from product attribution. V8 bridge frames remain explicitly unmapped. The separate initialization profile contains 48.173 ms of sampled self time, including 31.921 ms of inspector instrumentation; it is not a startup-duration estimate, and background compilation is not fully represented by a main-thread CPU profile.

## Cold work and chronological counters

Group zero remains cold. Its inflate counter was 57.156 ms, with 50.893 ms sampled in the decompressor. No warmup or tail was discarded. Groups differ in source size and row count, so this table is not an equal-work comparison.

| Group   | Banks |   Rows | Inflate including immediate CRC | Parse counter | Lookup counter | Result-copy counter |
| ------- | ----: | -----: | ------------------------------: | ------------: | -------------: | ------------------: |
| 0, cold |     5 | 50,000 |                       57.156 ms |         69 ms |       1.911 ms |            5.093 ms |
| 1       |     4 | 40,000 |                       13.183 ms |         45 ms |       5.256 ms |           21.677 ms |
| 2       |     4 | 40,000 |                       12.448 ms |         34 ms |       1.606 ms |            9.998 ms |
| 3       |     4 | 40,000 |                       11.257 ms |         34 ms |       1.182 ms |            5.886 ms |
| 4       |     5 | 50,000 |                       14.352 ms |         42 ms |       1.307 ms |           11.543 ms |
| 5       |     5 | 50,000 |                       16.330 ms |         42 ms |       1.307 ms |           18.473 ms |
| 6       |     4 | 40,000 |                       12.812 ms |         38 ms |       1.211 ms |            2.744 ms |
| 7       |     5 | 50,000 |                       12.881 ms |         35 ms |       2.214 ms |            8.644 ms |
| 8       |     4 | 40,000 |                       16.847 ms |         37 ms |       1.480 ms |            2.195 ms |
| 9       |     4 | 40,000 |                       14.525 ms |         37 ms |       5.273 ms |            6.476 ms |
| 10      |     4 | 40,000 |                       14.409 ms |         33 ms |       1.120 ms |            1.670 ms |
| 11      |     5 | 48,299 |                       18.956 ms |         65 ms |       1.819 ms |            6.366 ms |

## Frozen scope and provenance

- Product source: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`; Node `22.22.0`.
- Runtime parser WASM: `8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee`.
- Locked archive: `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`, 15,645,766 bytes. Term-bank compressed payloads total 15,632,849 bytes; decoded source totals 171,617,523 bytes.
- Final profiler source: `f04e84a13d7980f5453841c798775056a2c09b9b4c41ccd65fccfd49d1f1dd95`.
- External observer source: `a67ab3771137a80b99cb40f4f1f50a159c33687e8b381669238ac476af66af3b`.
- Raw result: `de935a5a20ee5a37b6841e359bb0cc5947de57ae943ed0d0f138e88f20f03189`.
- Independent readback: `f75499324533b3701d4a7257118deccf356f68450c3a2d767038b16ecf6b3724`.

The release binary runs unchanged. Native names come from the separately archived exact-toolchain proof under `builds/perf/20261128-native-symbols-83b3`: the release rebuild matched byte-for-byte, and every noncustom section of the names build matched the pinned release. Numeric frames are named only on the proven parser URL after checking their function index and column against the exact code-body range. Unmapped bridge frames retain their raw metadata.

The worker receives actual compressed payloads with the v3 production options and lazy 24 MiB policy-3 grouping. Execution concurrency is one. The profile starts immediately before each original handler request and stops at its `postMessage` adapter before transfer cloning. Actual worker compressed-input `heap.set`, inflate/CRC, parse/encode, lookup preparation, result copying and transfer-list collection are inside. Adapter input construction, file reads, hashes, full output oracles, ownership registration, transfer cloning and report writes are outside. Real worker transport, concurrent scheduling, canonical storage, downstream compression and browser work are excluded.

## Resource revision and setup failures

Both pre-acquisition failures are preserved. The original shell command exited 127 before Node because `/usr/bin/time` was absent. The corrected command reached Node but exited during resource preflight because the new helper assumed `/sys/fs/cgroup/memory.max` existed. Neither attempt initialized the worker or collected a sample.

The prospective resource-plan revision records the exposed controller limit as **unavailable**, rather than inferring unlimited memory. Both actual Node available memory and host `MemAvailable` exceeded the unchanged 512 MiB threshold; both reported 2,086,502,400 bytes at acquisition start. RSS/data/address-space rlimits were unlimited, and no cgroup controller was mounted. A finite hidden container limit is not verified.

The final run retained the 192 MiB V8 old-space cap, 400 MiB observed RSS stop, 64 MiB disk reserve, 16 MiB evidence cap and 120-second outer timeout. A Python observer sampled the direct Node child every 50 ms. Its 48 observations reached 212,611,072 bytes of RSS; child resource usage reported a maximum of 207,936 KiB. No limit, external signal or forced termination occurred. These observations do not guarantee every transient peak. The unchanged native WASM heap reached 43,384,832 bytes.

The observer's 2.444-second elapsed value includes all setup, source hashing, output oracles and evidence writes. It is not a parser benchmark or complete import duration. The original raw result, 13 profiles, acquisition log and observer receipt total 399,432 bytes before source, review and explanatory files are added.

## Files and reproduction

- `raw/result.json.txt` preserves the exact complete result, all counters, mapped samples, source bindings, group receipts and resource observations.
- `raw/initialization.cpuprofile` and all 12 `raw/group-*.cpuprofile` files preserve the complete sampled observations.
- `raw/run.log` and `raw/watch.json.txt` preserve exit status, exact command, process observation and failure/termination state.
- `attribution.json.txt` is a descriptive extraction of the raw result; `independent-review.json.txt` records the separate byte, oracle and sample-arithmetic review.
- `source/` contains the exact profiler, observer, prospective plan and resource-only diff. `setup-failures/` retains both original logs, incomplete receipt, exact original source/plan and resource-interface inspection.
- `MANIFEST.json.txt` binds every archived file by byte length and SHA-256; raw evidence bytes were not reformatted.

The exact invocation and its dependencies are in `source/compressed-profile-plan.md`. The frozen script uses the original checkout path and requires the repository dependencies, pinned WASM, locked JMdict archive, prior native symbol proof, and exact policy-3 reference receipt. Restore that receipt from [the already-published policy-3 artifact](https://github.com/ManabiIO/manabitan/blob/f65f4ef97ebf2f37a5b1b79ca7733d7b362ec963/builds/perf/import-owned-columns-83b3-evidence/v3/policy-3.json.txt) to `/tmp/manabitan-owned-columns-83b3/parity-v3-w3.json`, verifying SHA-256 `b471985781ae3a6ee6e8b3363f71020ba221dbd7e049347cc7bc7408d22a1c11` and length 548,717 bytes first. No compiler or browser download is required for replay. Adapting the hardcoded checkout path requires an explicitly recorded source revision. Any later authorized diagnostic must use fresh output paths; never overwrite these observations or silently substitute a new acquisition for them.

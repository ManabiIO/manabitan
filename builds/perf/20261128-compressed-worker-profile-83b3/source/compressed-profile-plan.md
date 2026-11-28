# One compressed-worker diagnostic

This is a proposed single baseline attribution run, not a timing cohort. No candidate, browser import, whole-import comparison or native rebuild is involved. Implementation and independent review must finish before acquisition. Resource-plan revision 2 is prospective: both preceding setup attempts stopped before worker initialization or any sample, and their original source, plan, logs and incomplete receipt remain preserved.

## Frozen input and behavior

Use the unchanged baseline checkout `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`, Node 22.22.0, and pinned release parser `8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee`. Hash all 16 source dependencies from the existing v3 runner before and after. Load and validate the repository's native manifest and all native input identities; do not substitute the names build at runtime.

Use the locked JMdict archive only: SHA-256 `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`, 15,645,766 bytes, 53 term banks, 528,299 rows, 171,617,523 uncompressed source bytes. Reuse the v3 runner's exact lazy byte-balanced production policy-3 partition: 12 groups with a 24 MiB target and four plain groups per policy worker. Execution concurrency remains one; it does not model actual three-worker scheduling or IPC.

Reuse the actual baseline worker handler with the same v3 compressed-source metadata, parser options, transfer list, complete output digest and transfer-footprint helpers. The worker receives compressed bytes, so native DEFLATE, immediate CRC, parsing, content encoding, index preparation, result copying and transfer-list collection are inside the parser diagnostic. JMdict uses immediate CRC inside `inflate_and_join_term_banks`; its separate `sourceCrcMs` is expected to be zero.

## Sampling boundary

Use one fresh Node process and one baseline module instance. Retain a separate initialization profile for the actual worker-module import, `WebAssembly.compile` and worker `initialize`/`ready` exchange. Keep fixture access and frozen identity validation outside that profile. Do not add a full-corpus warmup: group one remains visibly cold, and each subsequent group retains its chronological place.

For each of the 12 groups:

1. Read compressed payloads and create the delivered input buffers before starting the inspector.
2. Start the Node inspector CPU profiler at the same 250 microsecond sampling interval as the prior diagnostic, then invoke the unchanged source worker handler.
3. In the explicit local adapter's `postMessage` hook, request `Profiler.stop` before cloning/delivery. After the stop callback completes, perform the actual `structuredClone` with the worker's transfer list and resolve the response. Any stop overhead still visible in a profile is labeled instrumentation; it is not assigned to native work.
4. Outside sampling, validate the message type and ID, full digest, normalized key/index columns, transfer bytes/count and owned-content persistence. Compare each group to the corresponding frozen v3 baseline receipt. Do not serialize a whole worker response for diagnostics.
5. Apply the exact parent ownership receipt outside sampling: accept `ownsContentBytes === true`, `borrowsWorkerMemory !== true`, and successful `registerOwnedTermContent(chunk.contentBytesBuffer)`. Record the booleans, complete buffer size and receipt result; do not invoke a canonical sink or compression queue.
6. Save the complete raw profile, counters, oracle results and resource observation before continuing. Keep the previous owned result only long enough to verify persistence after the next heap reuse.

The output preserves all 12 group profiles separately. Aggregate sampled self time only as descriptive attribution, with cold group one separately visible. Product response counters remain separate from sampled CPU values; overlapping counters are never summed into an inferred wall time. File I/O, adapter input-buffer creation, SHA oracles, JSON output, parent ownership registration and adapter clone/delivery remain outside the profiled boundary. The actual worker's compressed-input `heap.set` remains product work inside its profile. Real IPC, concurrent workers, canonical storage, compression workers and the browser remain excluded.

## Names and correctness

Use the existing source-bound symbol proof, SHA-256 `263ca8e77c4932c41db6a3f2c96f89697e32c91b19041a3d99c2e37e01438a69`, only after confirming the runtime release parser hash above. Both release rebuilds matched byte-for-byte, and every noncustom parser section in the names build matched the release. Preserve raw WASM indices and URLs alongside their mapped names. Do not assign symbols to any unexpected WASM module.

The original v3 helper source is `cee15f1242da2c2a5e73f030f6bf2a5f4a54f292a723319a3924105c6f10eaaf`. The existing policy-3 receipt used for outside-profile parity has SHA-256 `b471985781ae3a6ee6e8b3363f71020ba221dbd7e049347cc7bc7408d22a1c11`. Preserve a new harness hash and clearly label it as new instrumentation, not the original already-executed runner.

## Resource and failure limits

No archive, compiler or browser download is needed. Keep only the current compressed group, current output and one previous output. Use a 192 MiB V8 old-space cap, and record RSS/external/array-buffer memory and process maximum RSS after every group. A 400 MiB observed RSS ceiling is a stop condition, not a promise about unsampled transient allocation. The archived decoded run's WASM heap maximum was about 40 MiB, and this single-instance replay should need substantially less storage than the earlier all-corpus setup.

Require at least 64 MiB free output storage and both actual Node `process.availableMemory()` and `/proc/meminfo` `MemAvailable` to report at least 512 MiB before starting. Record their values and sources separately; they need not be independent estimates. Include any exposed finite cgroup-v2 and applicable rlimit headroom in the minimum as well. Resolve the visible controller using `/proc/self/cgroup` and `/proc/self/mountinfo`; fail closed if an exposed controller layout cannot be resolved. When no cgroup controller is mounted, explicitly record its limit and headroom as unavailable. Node `constrainedMemory() === 0` does not establish that a hidden finite container limit is absent or verified.

Bound all saved profiles/reports to 16 MiB total, with at most 2 MiB per CPU profile; fail and preserve an incomplete-status receipt rather than silently truncating a profile. Use a response deadline and a 120-second outer process limit. Save `complete:false` before initialization, checkpoint after every group, and preserve all failure logs. Stop on resource exhaustion or a failed oracle; do not retry the same acquisition unchanged.

An external Python supervisor starts Node directly and reads only that live child's `/proc/<pid>/status` every 50 milliseconds. It records the exact command and PID, all sampled RSS values, maximum sampled RSS, exit status and child resource usage; it terminates the child on an observed RSS above 400 MiB or a combined evidence size above 16 MiB. The supervisor does not inspect hidden interfaces or bypass a sandbox. These samples do not guarantee detection of every transient peak or establish a finite hidden container limit. The external timeout encloses the supervisor, so the observed PID belongs to Node rather than `timeout`. The small observer is diagnostic instrumentation, not part of any performance claim.

### Preserved setup failures and revision

The original runner SHA-256 was `220f769840933837dd76bfca23c12821b5473cfbd8da08bb37eae043a9e9acc3`, and the original plan SHA-256 was `7eba808132edeb079fb5e2d1ecb043651c21d766fb186b7466d786ce693bcedd`. Exact copies and the failure archive are under `compressed-profile-preflight-failures/` beside this plan. The first launch exited 127 because `/usr/bin/time` was unavailable, before Node started. The corrected command omitted that utility and exited 1 during preflight because `/sys/fs/cgroup/memory.max` was absent. The exposed environment has no cgroup mount, `/proc/self/cgroup` contains `0::/`, and Node reports no known constrained-memory value. No worker or sampling process began in either attempt; no diagnostic observation exists to resample.

Revision 2 changes only this resource-plan interface and adds external observation. Every product source, fixture identity, parser option, group, oracle, profile boundary and symbol gate remains unchanged. The original strict controller requirement belonged to this new diagnostic helper. It was revised explicitly before data with parent authorization and independent review; no repository, product or hosted qualification gate is weakened.

The reviewed invocation from the baseline checkout is:

```sh
timeout --signal=TERM 120 python3 builds/perf/import-owned-columns-83b3-analysis-source/watch-compressed-profile.py \
  --out /tmp/manabitan-owned-columns-83b3/compressed-jmdict-profile-v2 \
  --log /tmp/manabitan-owned-columns-83b3/compressed-jmdict-profile-v2.log \
  --receipt /tmp/manabitan-owned-columns-83b3/compressed-jmdict-profile-v2-watch.json \
  -- /workspace/scratch/83b3b3bfba02/node-v22.22.0-linux-x64/bin/node \
  --expose-gc --max-old-space-size=192 \
  builds/perf/import-owned-columns-83b3-analysis-source/profile-compressed-jmdict.mjs \
  --out /tmp/manabitan-owned-columns-83b3/compressed-jmdict-profile-v2
```

Coordinate the quiet CPU slot with the native agent immediately before execution. Independent review must confirm the frozen source bindings, profile-stop/clone boundary, output/parity checks, symbol binding and resource controls first. The parent authorized this one diagnostic after those checks; no new approval is needed once they pass.

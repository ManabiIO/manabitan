# Native record fields: frozen complete-call component screen

This research kit compares the unchanged current JS record-field encoder with an isolated native helper. It changes only this kit and its push workflow over baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. There is no product integration, asynchronous change to the existing validation-to-encode boundary, or whole-import speed claim.

## Workload and correctness binding

The input is every actual record-field call from one complete current JMdict import: twelve calls, 528,299 rows, 366,030 resolved unique entries. The locked archive SHA-256 is `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`. Capture used the stock three-parser-worker/four-groups-per-worker policy, all 53 banks, and media fast scanning disabled. There are no inferred sink splits or selected example groups.

All stock outputs remained consumed by that import. Exact compressed frames, references, and finalized content/row/lookup payloads match the retained current-baseline oracle. All twelve helper results match every captured byte and a fresh untouched stock call. The complete input/output captures occupy 4,111,914 gzip bytes. Full capture source, bindings, output receipts, focused cases, independent reviews, earlier build revisions and the original failed test expectation remain under `evidence/stage1`.

The capture and this kit append one diagnostic named export to the verified stock module in memory to observe its real private factory-origin predicate. The existing function bodies and every on-disk product file remain unchanged. Capture reconstruction calls the actual current factory. A and C call the same untouched stock encoder in independent processes. B uses the exact isolated C/WASM/wrapper that passed stage 1.

Reconstruction preserves every captured value and view dimension, but gives each captured column a separate backing buffer and holds all twelve inputs before the sequence begins. It does not reproduce the browser's original allocation identities, source-arrival schedule, cache state, or garbage-collection history. The complete-call boundary is suitable only for component nomination; these differences remain for independent browser qualification.

## Timing boundary

Every observation starts a **fresh Node 22.22.0 subprocess**. Common stock-module import, source checks, capture decompression and factory input reconstruction happen before the timer. Each subprocess then executes all twelve calls in their original order. There are no repeated per-call warm loops and no forced garbage collection.

For B, the timer starts **before dynamically importing/evaluating the native wrapper**. It includes the WASM asset file read, module compilation, memory/instance creation, all current guards, memory growth, all four input copies per call, hash-table clearing, encoding, and the complete independent output copies. There is no process-local compiled WASM module from a previous observation. Node's compile cache is disabled; permitted flags/cache state are recorded without dumping the environment.

The primary measure is the difference in `process.cpuUsage()` user plus system microseconds across that complete sequence, reported in milliseconds. It includes work by all threads in the process. Monotonic `process.hrtime.bigint()` wall time is secondary. Fresh process launch and the common preparation above are excluded explicitly. File verification can warm the host's file cache; this screen does not estimate a cold network/package fetch or extension startup.

All twelve newly produced owning output buffers remain live through the end of the interval in **every arm**. Full byte comparison, output hashes, score/work checks, resource reporting and disk writes happen afterward. The common captured outputs retain the identical result bytes once; each observation records their exact identities and complete equality. Any differing/failed output is preserved separately. Per-call B statistics must exactly match the frozen copy/activation/scratch/growth receipt. A fallback or changed output/work identity stops acquisition.

The helper adds 8,618,752 input-copy bytes and 4,239,960 output-copy bytes across a sequence, plus 6,291,456 slot-zero bytes. Maximum scratch is 824,288 bytes; retained native memory reaches 2,424,832 bytes including its prefix, inputs, scratch, output capacity and page rounding. These are capacity/work counts. The child's `resourceUsage()` maximum RSS covers its entire life, including setup; it is not a qualified memory-window measurement.

## Prospective schedule and gate

A and C are independent copies of the stock path. B is the standalone helper. Two excluded, untimed full warmup cycles run `ABC` then `CBA`. Twelve measured blocks then run:

`ABC ACB BAC BCA CAB CBA ABC ACB BAC BCA CAB CBA`

This gives twelve measured observations per arm, four appearances in each position, and four of every directed within-block adjacency. Across block boundaries the transitions are unbalanced: CA, BB, CB, AC and BC occur twice; AA occurs once. Warmup order is deterministic. Neither boundary order nor warmups are used to claim stronger randomization or balance.

The nomination gate is fixed before any timing:

| Requirement | Threshold |
| --- | --- |
| Median paired CPU reduction, B/A and B/C separately | At least 20% against each |
| Median paired absolute CPU saving, B/A and B/C separately | At least 5 ms against each |
| Candidate faster paired CPU observations | At least 9 of 12 against each |
| Absolute identical-code C/A paired-median change | At most 3% |
| Absolute identical-code C/A equal-work change | At most 3% |
| Source, complete output, activation, copy/scratch/growth checks | Every observation passes |

`equal-work` is the ratio of summed C CPU to summed A CPU. Paired percentages and absolute savings are computed separately per block. No pooled-control substitute is used. CPU and wall B/A, B/C and C/A contrasts retain every raw observation. No reruns, selective blocks, discarded outliers, added observations, or adaptive thresholds are allowed. Failure stops the remaining prescribed acquisition and preserves all attempted receipts.

A passed gate is only a component nomination. It still requires product integration review, full correctness gates, and an independent complete-browser import qualification before any performance PR decision.

## Reproduction and validation

The workflow pins Ubuntu 26.04 and Node 22.22.0, checks Clang and LLD 21.1.8, rebuilds the exact 1,753-byte WASM, verifies every frozen/runtime file, and runs all 51 focused cases before the fixed acquisition. Timing is allowed only in the original hosted attempt. CPU affinity is the second allowed CPU, or the only allowed CPU when there is one; children inherit it.

From the repository root, the hosted commands are:

```sh
node dev/perf/native-record-fields-20261128-1c413/prepare.mjs builds/perf/native-record-fields-1c413
python dev/perf/native-record-fields-20261128-1c413/pin-cpu.py builds/perf/native-record-fields-1c413/affinity.json node dev/perf/native-record-fields-20261128-1c413/run.mjs builds/perf/native-record-fields-1c413
```

An explicitly untimed local compatibility check may use `prepare.mjs OUTPUT --local-untimed`, followed by `run.mjs OUTPUT --untimed-only`. It executes one fresh A/B/C sequence, records the observed Node version, and reads no timing clocks. It cannot qualify the planned Node 22 runtime or acquire the measured schedule. The real hosted preparation and timing path enforce the exact version.

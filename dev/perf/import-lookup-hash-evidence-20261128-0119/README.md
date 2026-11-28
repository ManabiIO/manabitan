# Import lookup checksum experiment

See the [follow-up evidence and current decision](FOLLOWUP.md) for the guard correction, rejected combined screen, contended pacing diagnostic, and subsequent gate attempts. This original report records the first experiment stage; it is not the final performance assessment.

This bundle preserves the component experiments behind the native lookup checksum candidate. The enclosing writer result merits a complete browser import comparison. No complete-import speedup is established by these local measurements.

The frozen baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The measured runtime change was checkpointed at `8c561628`; later changes through `4df50f0a4de2706e5f04782706d6d4ac7c1b021b` added the full license header, qualification observer/workflow, and another tail-coverage test. The published experiment, `f3fd2373de6e74f6243008ff3f1f68703d688973`, has the same complete tree as that local checkpoint. Its [hosted qualification run](https://github.com/ManabiIO/manabitan/actions/runs/46104742882) was queued when this evidence was prepared.

## Results and scope

All local timing uses Node 22.22.0. Kernel comparisons include the required source-to-private-memory copy. The enclosing comparison calls the actual `_createLookupIndexChunk`, including record validation, three checksums, allocation, both output copies, and import begin/end lifecycle. Each cold observation starts in a fresh process. Native initialization is conservatively awaited and charged, although production starts it alongside other import work.

| Observation                                          | Baseline median | Candidate median | Paired median change |
| ---------------------------------------------------- | --------------: | ---------------: | -------------------: |
| Warm scalar streaming kernel                         |        4.462 ms |         5.192 ms |              +20.20% |
| Warm SIMD streaming kernel                           |        6.167 ms |         7.306 ms |              +20.90% |
| Fresh scalar streaming kernel, full canonical module |       22.820 ms |         8.833 ms |              -60.55% |
| Fresh enclosing writer                               |       54.943 ms |        38.426 ms |              -23.80% |
| Warm enclosing writer                                |       18.287 ms |        14.669 ms |              -22.80% |

The enclosing experiment has 12 balanced baseline/native/identical-baseline-control blocks. Cold native totals improved in 10/12 pairs, with an equal-work change of -8.35%; the identical-baseline control had a paired median of -2.78% and equal-work change of +4.10%. The native 162.78489 ms observation in block 8 remains included. Warm enclosing totals improved in 8/12 pairs, with an equal-work change of -15.91%. Raw observations, all warmups, controls, and outliers are retained. Median ratios and paired median changes are different statistics.

The initial scalar, SIMD, and cold-kernel screens used an obsolete codec name in the research persistence adapter, which suppressed 3,998 cross-group deduplication hits. These remain representative full-corpus checksum comparisons, with valid identical-input differential checks. The enclosing experiment uses the corrected `raw-v6` adapter and confirms 362,032 pending unique spans plus 3,998 persisted hits, matching the browser diagnostic. Every capture still uses synthetic sequential raw logical content offsets. None is represented as exact compressed physical OPFS output.

The corrected input covers all 528,299 pinned JMdict rows, 12 frames, and 23,748,240 checksum bytes across base, derived, and record-field spans. Every enclosing output matches its captured reference SHA-256. The new import-owned instance uses a fixed 192 KiB memory with 64 KiB scratch; compiled canonical-module code is shared, while scanner memory is never reused. Existing read validation remains in place.

## Validation status

The final new hasher file passed all 35 tests, including every native tail length, unaligned inputs, multi-chunk boundaries, current-byte mutation, forged shared-buffer prototypes, resizable-buffer property shadowing, initialization failures, native traps, and session teardown/races. The selected product suites have 306 successful cases across separate runs. An earlier combined run had an unexpected store-test worker exit and remains recorded as a failed gate; an isolated rerun then passed all 203 store tests. Canonical scanner and compact-field validation suites also passed in the earlier focused set. Pinned Clang/LLD 21.1.8 regeneration and exact rebuild comparison passed.

A combined typed-lint attempt exited 137 before diagnostics. Remaining local and hosted gates are not presented as passes. Browser latency, full storage/readback parity, and separate memory qualification remain necessary before a speedup PR is justified. The warmed isolated kernel regressions remain part of the assessment.

## Durable contents and reproduction

`evidence.tar.gz` contains raw timing/result/gate JSON and logs, input manifests with exact acquired SHA-256 values, prototype code and small WASM binaries, source/toolchain hashes, and reproduction scripts. It excludes `.v8` captures and historical release-package archives. `files.sha256.json.txt` binds every archive member and the archive itself. The complete 36,206,711-byte local capture bundle is preserved separately, unchanged, with SHA-256 `26186c9da1ecf3830f8360024b7d640c27d9d60a16b8508a51e6cb3160e163f1`.

To regenerate the corrected input:

1. Prepare separate checkouts of the frozen baseline and published candidate. Install their locked dependencies and run `npm run build:libs`.
2. In the baseline checkout, run `node dev/perf/prepare-dictionaries.js jmdict`. The lock pins the archive to SHA-256 `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`.
3. Extract the compact archive. Keep `regeneration/capture-lookup-payloads.mjs` beside `regeneration/parser-replay.mjs`, then run `node regeneration/capture-lookup-payloads.mjs <baseline-root> jmdict <capture.v8>`.
4. Run `node regeneration/verify-regenerated-input.mjs <capture.v8> input-manifests/jmdict-lookup-payloads-baseline-raw-v6.v8.json`. This compares all acquired payload, field, checksum, and enclosing-output digests. The entire regenerated V8 container can have a different SHA because it also records paths, host information, and timings.
5. Run `python3 native-hash/envelope-run.py <node22> <baseline-root> <candidate-root> <capture.v8> <result.json>`. The preserved scripts and `reproduction.json` describe the earlier kernel screens and pinned native rebuild too.

The retained scripts are historical acquisition inputs inside an archive, not active project tooling. Complete source identities and every limitation accompany the results so later review does not depend on expiring Actions artifacts.

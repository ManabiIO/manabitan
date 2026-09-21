# Bounded compressed-block read candidate

This is a memory/scheduling candidate, not a measured whole-import speedup.

## Changes

The store admits at most four distinct block loads and 16 MiB of declared expanded bytes at once. Scalar reads and overlapping batches share the same FIFO admission queue and single-flight map. One block larger than the budget runs alone; no impossible reservation waits forever. Cache invalidation rejects queued old-generation readers while active storage operations retain their reservations until settlement.

Batch tasks process each completed block without returning it to `Promise.allSettled`. When the total requested bytes from a block are less than half its decoded length, those spans are copied into one small owned buffer. Dense groups retain existing zero-copy views. Request order, exact bytes, corruption classification, generation checks and checksum/codec validation remain intact.

The budget is not a total-memory cap. The existing 48 MiB cache, output bytes, reference metadata, compressed inputs and codec scratch are separate; declared lengths are validated against actual decoded output by the existing loader. Four loads, 16 MiB and the half-block copy threshold are candidate settings requiring real-corpus qualification.

## Reproducible controlled probe

```sh
node dev/perf/block-read-retention-probe.js
```

Run that identical probe on the tests-first commit and candidate commit. It executes production reference parsing, grouping, single-flight admission and result assembly, with controlled storage and decoded-block delivery. It records source fingerprints, runtime version, output correctness, concurrent load reservations and distinct result backing-buffer bytes. It does not measure actual decompression, process RSS or import elapsed time.

For 32 one-byte requests from 32 distinct 4 MiB blocks, local Node 22.16 observed 32 concurrent loads and 128 MiB result-backed storage on the original; the candidate observed four loads, 16 MiB in-flight declared bytes and 32 result-backed bytes. Both retained the same cache limit and returned identical output. This does not establish how frequently JMdict or Jitendex exercises this case.

## Merge gate

Keep draft until full exact-head CI/browser acceptance and independent review. Run real JMdict and Jitendex full-import A/B through persistence/index finalization and reopening on the same accepted correctness baseline. Record corpus/source hashes, active optimized-path counts, raw paired timings, cache misses/reloads/decompression counts and peak memory. Include cold/warm, sparse/dense, long/short and overlapping-reader controls. Reject or refine a material throughput regression; do not infer a speedup from the controlled buffer accounting. No production branch or experiment defaults have been changed by publishing the candidate.

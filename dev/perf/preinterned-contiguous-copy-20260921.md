# Preinterned compaction copy candidate

## Decision and scope

Draft import-component candidate, not a whole-import speedup claim. Coalesce adjacent source-byte ranges while copying the first-use ordered keys in `compactValidatedTermRecordPlan`. A contiguous run uses one copy instead of one temporary subarray and copy per key. Fragmented ranges use direct Uint8Array views to avoid the regressions seen with the first two prototypes.

The destination arena remains independently owned. Row order, distinct key identities, lengths, offsets, hashes, reading-equality overrides, source validation and scratch cleanup are unchanged. Neither import flags nor persisted formats change. This edits the compaction copy loop only; it is independent of the builder validation change in PR #130.

## Source identity

- Base develop commit: `e932c60d689b0af96ef357f76486091189c21f19`.
- Baseline production blob: `316b678a557cc2b6d9a36bc829b06f34a371aa86`.
- Candidate production blob: `80be086ddddd4a5513c5025ce54cf425e21e4268`.
- Baseline SHA-256: `7442f1c5ffd4458762494eaaf6d435216e235a6f26eb7ca136c7b17c29ef54a3`.
- Candidate SHA-256: `dfc523e7863c8b3335df7e9c22905df6b7e2ef3c209deab9f83bb7a85f377a13`.

## Benchmark-first measurements

Node v22.16.0, Linux x64, Intel Xeon Platinum 8370C. Chromium 144.0.7559.96 runs on the same host. Each workload starts with 90,000 source keys and compacts 30,000 rows six times per timed sample. Short keys contain 16-22 bytes; long keys contain 512-518 bytes. This includes source validation, row remapping, destination allocation and byte copying, but excludes parser, lookup-index encoding, ZIP, SQLite, OPFS and UI work.

Six paired warmups precede nine alternating ABBA/BAAB blocks. Garbage collection is outside timing. Complete output equality is checked outside timing and checksums are consumed inside timing. Figures are medians of paired-block percentage changes, not ratios of separately selected median durations. Negative means less time. Absolute times and individual blocks vary materially on this shared host.

Results below list Node run 1, independent Node repeat, the published-harness Node run, and Chromium respectively:

- Contiguous short keys: **-56.81%, -56.27%, -54.86%, -34.63%**.
- Shuffled groups of eight contiguous keys: **-45.97%, -52.56%, -53.30%, -40.20%**.
- Fully shuffled control: **-21.10%, -18.74%, -11.68%, -8.88%**.
- Alternating between two distant regions: **-18.93%, -13.14%, -15.19%, -13.91%**.
- Repeated-key control: **+0.80%, -5.69%, -0.38%, -6.00%**.
- Contiguous long keys: **-12.06%, -4.61%, -14.22%, +0.14%**.

The two intended short-key locality workloads improved in every paired block in all four runs. Repeated-key results are not a consistent gain; long-key copying is effectively flat in Chromium. Do not infer a universal speedup. The original subarray-based prototypes were rejected after the alternating-region control regressed by 7.48% and 7.11%.

The published Node harness differs from the first two final runs only in JSDoc return annotations. Its own independent run is included above rather than presenting the earlier harness as byte-identical. The raw JSON, rejected prototypes, browser runner and source snapshots are retained in the accompanying review bundle. The repository harness emits raw samples, paired blocks, checksums, output hashes, environment and source fingerprints on each run.

## Correctness and browser execution

44 native cases pass, including 1,500 seeded arbitrary-byte cases compared with an independent first-use model. Coverage includes zero-length and maximum-length keys, UTF-8/BOM/NUL bytes, disjoint and reordered spans, optional offsets/hashes, padded views, Buffer and stable SharedArrayBuffer sources, output independence, corrupt arenas, invalid row references, scratch recovery and run compaction. A counted-copy case verifies one source copy for a 512-key contiguous run. The Vitest wrapper runs these cases in repository CI.

A separate Chromium run passed 1,500 seeded model comparisons for both baseline and candidate. Local HTTP navigation is blocked in the review environment, so full ES modules were imported through data URLs with only relative import specifiers rewired; production function bodies were unchanged. The page was not cross-origin isolated, so browser SharedArrayBuffer coverage was unavailable; Node covers stable shared-backed views. This is not a full-extension browser import test.

## Reproduction and remaining qualification

Use separate baseline and candidate worktrees. From the candidate worktree:

```sh
node --test test/util/preinterned-copy-cases.js
node --expose-gc dev/perf/bench-preinterned-copy-20260921.mjs \
  --baseline=/tmp/manabitan-base/ext/js/dictionary/term-record-preinterned-plan.js \
  --candidate=./ext/js/dictionary/term-record-preinterned-plan.js \
  --output=/tmp/preinterned-copy.json --rounds=9 --iterations=6
```

Run repository unit, lint, type and build validation on the final PR head. Real JMdict/Jitendex and large-archive import latency, actual compaction-path frequency, peak memory and Firefox/WebKit performance remain unmeasured. Whole-plan reuse can bypass compaction entirely. This candidate must not be promoted solely from these component measurements.

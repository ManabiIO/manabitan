# Independent readback of hosted qualification artifacts

This reader is offline analysis for run `46103918280`, candidate `f65f4ef97ebf2f37a5b1b79ca7733d7b362ec963`, baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. It does not change acquisition, retry observations, alter thresholds or run a browser. The two JMdict cells remain independent hosts.

## Frozen schedule

| Cell                 | Ordinary receipts | Excluded warmups | Candidate observations | Identical-code observations | Separate exhaustive media | Separate memory |
| -------------------- | ----------------: | ---------------: | ---------------------: | --------------------------: | ------------------------: | --------------: |
| JMdict AB, 12 pairs  |                36 |                4 |                     24 |                           8 |                         2 |               4 |
| JMdict BA, 12 pairs  |                36 |                4 |                     24 |                           8 |                         2 |               4 |
| Jitendex AB, 6 pairs |                20 |                4 |                     12 |                           4 |                         2 |               4 |
| VNDB AB, 6 pairs     |                20 |                4 |                     12 |                           4 |                         2 |               4 |

Thus the complete four-cell qualification contains 136 browser imports. The separate baseline JMdict trace adds one diagnostic only after its AB cell qualifies. It never enters timing statistics. Each cell also runs three sequential component replay policies, 2, 3 and 5, before browser qualification; their durations are not browser observations.

The first warmup pair follows the cell's initial order and the second reverses it. Candidate pairs alternate AB/BA. Each third candidate pair is followed by an alternating AC/CA control pair. C uses the exact baseline A source, package, runtime and flags. Memory uses ABBA for an AB cell and BAAB for the BA cell.

## Artifact intake and bounded staging

The expected artifact names are `import-owned-columns-83b3-jmdict-AB`, `import-owned-columns-83b3-jmdict-BA`, `import-owned-columns-83b3-jitendex-AB`, and `import-owned-columns-83b3-vndb-AB`. Bind each download to its GitHub artifact ID, name, run ID, head SHA, creation time and reported size before reading it. The connector follows GitHub's temporary redirect and returns a reusable ZIP reference. Do not publish signed download URLs.

Process one cell at a time. First inspect the ZIP central directory and record every member's name, compressed size, uncompressed size and CRC. Reject duplicate names, absolute paths, parent traversal, and symlink entries before any selective extraction. Prefer a range-backed ZIP reader if the returned reference supports authenticated byte ranges. If range reads are unavailable, stage one complete ZIP only after checking current free space and maintaining a reserve; do not silently read the whole response into memory.

Extract the following selected files while hashing their bytes and preserving their relative directory structure:

- `import-owned-columns-83b3/registered-plan.json`, `source-identities.json`, `browser-identity.json`, `observations.json`, `analysis.json`, and root build/fixture logs.
- Every ordinary observation's `summary.json`, `run-1.json`, `canonical-receipt.json`, `host-before.json`, `host-after.json`, and `run.log`, including every slow tail and any incomplete observation directory.
- The two `exhaustive-media-*` directories' summary, raw report, canonical receipt and log.
- `memory/plan.json`, both exact harness copies, `observations.json`, `memory-comparison.json`, `memory-audit.json` or audit failure, and `semantic-failures.json`; for all four memory runs, their summary, raw report, canonical receipt, raw `memory.json`, `markers.jsonl`, logs, and any sampling-failure or incomplete memory files.
- All three `import-owned-columns-83b3-components/<dictionary>-policy-*.json` receipts and the exact `owned-column-replay.mjs` copy; all `import-owned-columns-83b3-logs` files.

The `*-diagnostic` trace, screenshots and HTML reports stay outside the first pass. Retain them in the original workflow artifact for later targeted examination. Do not confuse its trace completion boundary with the qualified browser monotonic total.

For the second pass, stream each nested `package-A.zip` and `package-B.zip` through SHA-256, compare it to `source-identities.json`, then inspect one product ZIP at a time. Reject duplicate members and hash every uncompressed member, requiring exact equality to the recorded member map. The only A/B member differences allowed are the parser, parser worker and retained-record store JS files. Remove only our disposable product ZIP staging after its verification receipt is saved. An outer artifact SHA can be independently verified only when all of that ZIP's bytes were read; do not label a range-only extraction as a complete outer-archive hash check.

Current temporary and workspace capacity fluctuates with shared activity. Inventory sizes before extraction, reserve space for the next phase, and stop a download before the known budget is exceeded. JSON reader inputs are bounded to 64 MiB each. Raw memory audits should be scheduled separately if their actual member sizes make that bound or available RAM unsuitable.

## Analysis

After selective extraction, pass the single cell's `import-owned-columns-83b3` directory. Its component directory must be the sibling `import-owned-columns-83b3-components`:

```sh
python3 builds/perf/import-owned-columns-83b3-analysis-source/analyze-cell.py \
  --repo /workspace/scratch/83b3b3bfba02/manabitan \
  --evidence /tmp/one-cell/import-owned-columns-83b3 \
  --cell jmdict-AB \
  --output /tmp/one-cell-analysis-receipts.json
```

This first pass explicitly leaves the package-byte gate pending and exits 2. After both local product ZIPs have been staged within budget, add `--verify-packages` and choose a new output filename. Existing derived reports are never overwritten.

The script freezes the baseline/candidate commits and trees, package and fixture lock digests, the three changed runtime hashes, the unchanged native parser hash, the exact component runner, and the strict semantic/memory auditor hashes. It recomputes each ordinary duration from raw browser monotonic start/end events and requires agreement with both the summary and `observations.json`. It verifies exact schedules and all component rows, source hashes, bank coverage and buffer-delta identities. The original receipt auditor independently checks source/package/runtime, persisted semantic probes, all 72 lookup observations, restart, storage and media receipts. The original memory auditor recomputes process-tree qualification and maxima from raw scans; its existing 5% median/10% worst-pair thresholds remain unchanged. VNDB's prospective active SAH allocation contract remains exactly 37 units.

Per cell, the reader recomputes B/A paired ratios, their median, equal-work total ratio, worst pair, faster-pair count, the frozen descriptive bootstrap, and initial-order strata. It displays C/A controls separately. It never pools hosts, subtracts control drift, removes slow observations, or folds warmups, memory, media or trace timings into the candidate estimate. All chronological observations and pair values remain in the output. Incomplete schedules and source/correctness failures remain explicit; any statistics from their complete pairs are provisional. Passing correctness and memory gates does not itself establish a latency improvement.

At preparation time, Python compilation passed and static review was requested. No hosted artifact had completed, so this reader had not yet been exercised on the new cohort. The transport and selective-extraction plan must be checked against the actual returned download-reference format before use.

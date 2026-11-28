# Compact score loop restoration experiment

Base: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` (develop).
Local product commit: `1f61dbf2f462d8a3594da3bac7372d72432e6896`.

The product change restores the two indexed-loop lines previously accepted in
PR #944 and subsequently overwritten by integration commit
`a35b064d5d37960429ce591c9f6f17a2df0486c5` from PR #967. The only product file is
`ext/js/dictionary/term-record-opfs-store.js`.

## Finding

The complete pinned JMdict native corpus passes through the current source
planner and native parser workers and the real record encoder: 528,299 rows,
53 source banks, 12 complete production-sized native lookup chunks. Native
uncompressed content lengths are mapped to deterministic safe offsets; physical
content persistence is intercepted. All field/sidecar outputs match between the
two implementations and an independently loaded identical-baseline control.
Timing preserves all source buffers.

Recorded Node 22.22.0 results from 12 balanced A/B/C triplets:

| Component | Baseline A median | Candidate B median | Baseline C median |
| --- | ---: | ---: | ---: |
| Compact field validator | 2.5117 ms | 1.6183 ms | 2.5161 ms |
| Complete sidecar construction | 13.6887 ms | 12.8929 ms | 13.9085 ms |

Times are per complete corpus after the declared warmups. The absolute gain is
about 0.9 ms. These are retained-buffer component measurements, not complete
browser-import measurements. Identical controls include substantial outliers;
all observations are retained. The root reviewer judged the magnitude too small
for a standalone speed PR. It may be restored separately as already-accepted
code within an independently qualified improvement.

## Artifacts and limitations

- `score-loop-jmdict-node22-02.json`: all recorded observations, source/fixture
  hashes, worker groups, per-block receipts and environment.
- `score-loop-jmdict-node22-02.log`: a second raw JSON copy on stdout plus summary.
- `score-loop-benchmark.mjs`: exact successful runner. It reads its baseline from
  the supplied worktree's HEAD, so reproduction requires a clean worktree at the
  base above plus the uncommitted two-line restoration, as tested. It rejects
  any other product-file difference.
- `jmdict-node22-01.log`: first run reached report write, then failed with ENOSPC.
  Its timings were not recovered or observed; no result is claimed for that run.
- `score-loop-focused-tests-02.log`: compact-score and lookup suites passed all
  56 tests; the broader OPFS suite failed collection because generated libraries
  were absent from the new worktree.
- `score-loop-focused-tests-03.log`: after linking the existing built libraries,
  the broader test invocation was killed with exit 137 before a result.
- `score-loop-focused-tests.log`: first CLI invocation rejected an unsupported
  Vitest `--minWorkers` flag before running tests.

`git diff --check` passed. A targeted ESLint invocation was also killed with
exit 137; it is not a lint pass. No complete unit/build or browser qualification
is claimed for this isolated restoration.

Successful command (run before committing the restoration):

```sh
/workspace/scratch/83b3b3bfba02/node-v22.22.0-linux-x64/bin/node --expose-gc \
  /workspace/scratch/83b3b3bfba02/score-loop-experiments/score-loop-benchmark.mjs \
  /workspace/scratch/83b3b3bfba02/score-loop \
  /tmp/manabitan-import-20261127/profile/e2e-dictionary-cache \
  /tmp/score-loop-jmdict-node22-02.json jmdict \
  > /tmp/score-loop-jmdict-node22-02.log 2>&1
```

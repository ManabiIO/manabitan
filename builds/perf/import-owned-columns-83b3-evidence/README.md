# Owned lookup columns: local evidence index

This directory preserves exact local evidence for the #820 ownership follow-up. It is an index of source replay and scoped checks; the experiment handoff and hosted qualification results are maintained separately.

[MANIFEST.json.txt](MANIFEST.json.txt) lists every preserved file's path, Git blob SHA, SHA256 and byte count, plus runtime/source identities and all nine completed dictionary-policy cohorts. Raw JSON files use `.json.txt` without altering their bytes. The ENOSPC file uses `.partial.txt` because the interrupted write left invalid JSON.

| Directory                      | Contents and status                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `v3/`                          | Complete JMdict, Jitendex and VNDB receipts for each modeled 2/3/5-worker grouping; full stdout and process resource records.           |
| `original-v1/`                 | Original complete JMdict policy-3 receipt, stdout and exact historical runner. Its parser hash precedes formatting-only fixes.          |
| `failed-v2/`                   | Exact buggy runner, ENOSPC and exit137 partial cohorts, explicit 192 MiB V8 heap-limit failure, and wrapper failure before Node launch. |
| `validation/parser-worker/`    | Original 18 selected tests, scoped type/lint receipts, formatting failure and final logs.                                               |
| `validation/retained-records/` | 22 selected ownership/native/retained-record cases and scoped type/lint receipts for the carried-forward #820 guard.                    |
| `declined-score-loop/`         | Exact unpromoted two-line restoration, retained-buffer comparison, controls, first ENOSPC failure and other check failures.             |

The [independent corpus audit](independent-corpus-audit.json.txt) records a separate fetch and check of the three final Git blobs: 616 groups and 22,839,492 rows across the policies. It is descriptive verification, not a browser result.

## Reproduce the completed source replay

Use Node **22.22.0**, two distinct clean checkouts, and baseline commit **9e10d3b3fcf66d344ab31bc42c9b522fa5215da2**. In the candidate checkout, the runnable source is [owned-column-replay.mjs](../import-owned-columns-83b3-source/owned-column-replay.mjs), SHA256 `cee15f1242da2c2a5e73f030f6bf2a5f4a54f292a723319a3924105c6f10eaaf`.

Set the two paths, then run:

```bash
set -euo pipefail
baseline_root=/absolute/path/to/clean-baseline
candidate_root=/absolute/path/to/candidate

for source_root in "$baseline_root" "$candidate_root"; do
  npm --prefix "$source_root" ci
  npm --prefix "$source_root" run build:libs
done

cd "$candidate_root"
node dev/perf/prepare-dictionaries.js jmdict jitendex vndb
mkdir -p builds/perf/ownership-replay-new
for policy in 2 3 5; do
  node --max-old-space-size=384 --expose-gc \
    builds/perf/import-owned-columns-83b3-source/owned-column-replay.mjs \
    --baseline-root "$baseline_root" --candidate-root "$candidate_root" \
    --cache-dir "$candidate_root/builds/e2e-dictionary-cache" \
    --parser-workers "$policy" --pairs 1 \
    --out "builds/perf/ownership-replay-new/policy-$policy.json" \
    jmdict jitendex vndb \
    2>&1 | tee "builds/perf/ownership-replay-new/policy-$policy.log"
done
```

Each output JSON path must be new. The runner checks the complete locked archives, source hashes before/after, every row's semantic output, actual transfer-list buffer accounting, and previous owned-output persistence. It imports actual parser-worker code and performs real structured-clone transfers. The resource wrappers used locally are described by their recorded command and resource fields; they are outside the source measurement boundary.

## Interpretation and failure provenance

Execution concurrency is **one**. The 2/3/5 values model existing grouping policies; they do not model browser scheduling or every low-memory source-batching path. The recorded byte reduction is cumulative emitted owned buffers, not copied IPC bytes or peak browser memory. Per-group timers are diagnostic; these files make no complete-import speed claim. Storage, compression and image-payload import require the separate browser qualifier.

For policy 3, the expression-column arithmetic increment is **30,452,656 bytes** (`4 × whole-index rows`). The other **220,644,286 bytes** overlap #820's earlier key-byte/length reuse mechanism. This split is not a separately executed key-only control.

V2 mistakenly evaluated `JSON.stringify(successfulWorkerResponse)` as an assertion message. It created avoidable CPU and heap pressure; the 192 MiB attempt explicitly failed in V8's JSON stringifier. The ENOSPC failure was also real, and exit137 has no captured kernel OOM receipt. V3 uses bounded diagnostics only inside the failure branch; independent review and all nine full-corpus cohorts passed afterward. Preserve the v2 artifacts as failures and do not use their timings.

The 22-case guard receipt postdates the parser replay. That guard changes retained-record behavior, while parser/worker/WASM bytes remain identical; its raw receipt describes the reachability and exclusions. Scoped validation is not a full repository or hosted CI result.

The declined score-loop experiment's own [README](declined-score-loop/README.md.txt) documents its approximately 0.9 ms component gain, controls and failures. Its exact patch is preserved for provenance and is not part of the candidate runtime.

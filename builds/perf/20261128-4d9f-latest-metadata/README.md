# Latest a300 metadata corpus qualification

This is a **new, untimed correctness and retained-backing qualification** for the integration of implicit signature1 and dictionary-name metadata columns with merged #982. It does not relabel the completed dcfc or f28 acquisitions.

| Arm | Exact public source | Full source tree |
| --- | --- | --- |
| A | `a300da36d00df8e353c5679b1528b50a1299b75f` | `5fe9ee5a3e2c27ce4e099cb3d6a598077027eac4` |
| B | `86cd5c18d325488b0ecb04c552d1dc83567de9d2` | `525583edb6429008801d181ee03b3e9e5c519eae` |

The candidate is byte-identical to local integration `5b178ff002216d74cc8a09336c375832fc4dd994`. All source IDs used by these instructions are public. The older f28 candidate and its six successful acquisitions remain in `../20261128-4d9f-current-metadata`.

## Frozen boundary

The executable verifier and all three contract files in `test/perf/signature1-corpus-verification` are unchanged from the tested fb9/a221 package, publicly preserved at `3da567143d51e2857eeec7550aef4e7e4de921e6`. This directory changes only the explicit source profile and protocol. The outage-reconstructed format4 derivative and newly reconstructed decoder are unused.

The profile retains the same 42 source/asset identities, complete original output oracles, source grouping, codec-worker count, parser transport, bounded OPFS adapter, 512 MiB Node old-space limit, 512 MiB temporary-space floor, 3 GiB sampled RSS ceiling and 20-minute child deadline. The independent logical-ID decoder still expands only the upstream empty Float64 representation to positive zero. Its backing is measured separately and is never credited to this candidate.

Six parent source hashes changed after f28. Their exact values, the seven-path historical-delta whitelist, all helper hashes and the unchanged archive identity are recorded in `source-profile-transition.json`. Generated library inputs, native assets and locked fixtures did not change. A profile mismatch or output-oracle mismatch fails the run.

## Hosted execution

The separate workflow `.github/workflows/qualify-latest-metadata-corpus-4d9f.yml` runs three independent Ubuntu 26.04 jobs, one each for JMdict, Jitendex and VNDB. Every job checks out exact A and B, runs ordinary locked `npm ci` and `npm run build:libs` in each checkout, verifies the public helper bytes and all oracle archive members, and runs the unchanged 26 helper contracts. It then attempts exactly one fresh A and one fresh B, preserving both exits, before running the unchanged comparison.

All logs, launcher receipts, source/protocol receipts and raw reports are uploaded even when qualification fails. No warmup, benchmark timing, automatic rerun, source retuning or oracle weakening is part of this protocol. The job's tooling commit and binary identity are written to `preflight.json`; workflow artifacts identify the exact run and corpus.

## Manual reproduction

Use Node **v22.22.0 Linux x64**, whose executable SHA256 is `1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31`. Use separate clean checkouts for A and B, and this published tooling checkout for the helper and evidence. Run `npm ci` and `npm run build:libs` normally in each runtime checkout.

Extract `verification-oracles.tar.gz` into this directory only after checking its SHA256 `456120a04cb75c4772aeedba7738060d0a7ed956f18610f292aea5b501022a71`; verify every member against `verification-oracles-index.json`. The archive and all eight members are byte-identical to the prior qualified package. Acquire the selected exact archive from `test/perf/dictionaries.lock.json`, and verify both its size and SHA256 before starting.

Set the following shell variables to absolute paths. `META_OUTPUT` must be a new directory; neither the helper nor launcher overwrites earlier attempts.

```sh
META_HELPER=/absolute/tooling/test/perf/signature1-corpus-verification
META_EVIDENCE=/absolute/tooling/builds/perf/20261128-4d9f-latest-metadata
META_A=/absolute/source-a
META_B=/absolute/source-b
META_CACHE=/absolute/locked-archives
META_OUTPUT=/absolute/new-results
META_CORPUS=jmdict
META_NODE_SHA=1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31

node --test "$META_HELPER/node-opfs-bounded.contract.mjs" \
  "$META_HELPER/metadata-oracle.contract.mjs" \
  "$META_HELPER/logical-record-ids.contract.mjs"

python3 "$META_HELPER/launch.py" --node "$(command -v node)" \
  --source-root "$META_A" --source-id a300da36d00df8e353c5679b1528b50a1299b75f \
  --corpus "$META_CORPUS" --arm A --cache-dir "$META_CACHE" \
  --output "$META_OUTPUT/$META_CORPUS-A-1" --evidence-dir "$META_EVIDENCE" \
  --node-sha256 "$META_NODE_SHA"

python3 "$META_HELPER/launch.py" --node "$(command -v node)" \
  --source-root "$META_B" --source-id 86cd5c18d325488b0ecb04c552d1dc83567de9d2 \
  --corpus "$META_CORPUS" --arm B --cache-dir "$META_CACHE" \
  --output "$META_OUTPUT/$META_CORPUS-B-1" --evidence-dir "$META_EVIDENCE" \
  --node-sha256 "$META_NODE_SHA"

node "$META_HELPER/compare-results.mjs" \
  "$META_OUTPUT/$META_CORPUS-A-1" "$META_OUTPUT/$META_CORPUS-B-1" \
  "$META_OUTPUT/$META_CORPUS-comparison.json" --evidence-dir "$META_EVIDENCE"
```

Repeat with `META_CORPUS=jitendex` and `META_CORPUS=vndb`, retaining independent new output paths. These commands assert exact full persisted-file bytes after the existing generation-ID normalization, independent logical metadata, every parser group and every encoded record field/envelope. VNDB retains the independent 170-group, 146,725-reference, 146,570-distinct-path oracle.

## Claims and limits

Successful results may establish exact retained native/array backing avoided at this boundary. They do not establish import speed, browser peak/settled memory, separate media persistence, settings UI, SQLite transactions, restart or lookup behavior. The generic non-MBR6 fallback can require less than one extra 64 KiB page at some capacities because of page rounding. The expected corpus savings remain hypotheses until the new source-bound reports finish.

The unchanged comparator requires a null physical signature1 column in every candidate group, exact A/B output equality and exactly 4 MiB saved for JMdict. It reports the observed dictionary-name representation and complete per-group backing for every corpus; it does not assume Jitendex or VNDB remains implicit.

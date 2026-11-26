# Independent review of JMdict split-record encoding

This directory retains independent review and component evidence for [PR #897](https://github.com/ManabiIO/manabitan/pull/897), authored by another concurrent session. It does not claim authorship of that product change or a complete-import speedup.

| Identity                          | Commit                                     |
| --------------------------------- | ------------------------------------------ |
| Baseline                          | `7d1643e6147a10cb2165e9744cf0e63b59e46632` |
| Reviewed PR #897 head             | `475d351ff07c1b5cfc5651d7f59c624629e4fdc5` |
| Reviewed product tree             | `59959442e3d7ec9290d9da5d1177a7df28b58ed1` |
| Independent local patch, withheld | `96f5ed82a76ecca9dcb8dea382ec54af288a0ffe` |

The local patch independently found the same provenance loss. A live refresh then found PR #897 already published, so no duplicate product PR was opened. Its exact published head was reviewed and replayed instead. Earlier validation of the withheld patch is not attributed to PR #897.

## Findings

The production source planner and native parser workers processed all **528,299** rows of pinned JMdict [2026-11-22]. Every emitted record and lookup byte matched baseline in both configurations.

| Existing policy selected by hints    | Groups / record runs | Affected rows | Temporary offset/length bytes avoided |
| ------------------------------------ | -------------------: | ------------: | ------------------------------------: |
| 2 CPU, 8 GiB: two workers            |               8 / 18 |       348,299 |                             2,089,794 |
| 4 CPU, 8 GiB: ordinary three workers |              12 / 12 |             0 |                                     0 |

The replay intercepts persistence and uses deterministic native-content spans. It excludes compression, global deduplication, browser OPFS, and UI. Its raw parser diagnostics are not controlled timing observations. **There is no ordinary three-worker benefit demonstrated by this change, and no complete-import latency or peak-memory claim here.**

PR #897 checks the exact private index subview more strictly than the withheld patch. Its broader acceptance of a parent score accessor is safe because slicing first creates an ordinary child score snapshot, which still passes the final encoder guard. No correctness blocker or product follow-up was found.

The initial independent run was **74 passed / 1 failed across four files**. The failure concerned only a staging-copy expectation for that score-accessor case; byte equality had already passed. The adapted test changes its label and expected copy counts from `[1, 1]` to `[0, 0]` for that case only. Every byte assertion remains unchanged. The adapted run passed **75/75**, including all 16 PR tests and all 15 independent tests. Both sources, reports, logs, and hashes are retained.

The local Chrome package comparison found exactly one changed file among 551: `js/dictionary/term-record-opfs-store.js`. All other 550 files, including all five WASM files, matched. Local ZIP growth was 467 bytes. Product archives are omitted; all entry hashes and build logs remain.

## Retained files and verification

`receipts/` contains the original reports and logs. `sources/` contains the exact replay and original/adapted independent tests. The `.txt` suffix keeps archival source and JSON bytes unchanged and separate from active repository tests/configuration. `SHA256SUMS` binds every retained file except itself.

From this directory:

```sh
sha256sum --check SHA256SUMS
python audit-evidence.py
python review-statistics.py ../../import-qualification-20261125-a7f7.py
```

The statistical review checks the frozen runner's schedule and arithmetic with synthetic data. It is not a hosted benchmark result. The reviewed runner/workflow hashes and resolved findings are in `receipts/qualification-statistical-review.json.txt`. Hosted cohorts are reported separately.

## Reproduce the component checks

Use Node **22.22.0**, separate checkouts of the baseline and PR head above, and each checkout's `npm ci` and `npm run build:libs`. In the baseline checkout, run `node dev/perf/prepare-dictionaries.js jmdict` to prepare its checksum-verified archive.

Set `JM_BASE`, `JM_CANDIDATE`, and `JM_EVIDENCE` to those absolute checkout/evidence paths. Set `JM_OUTPUT` to a fresh output directory and create it. Then:

```sh
cp "$JM_EVIDENCE/sources/record-split-origin-replay.mjs.txt" \
  "$JM_CANDIDATE/test/fixtures/record-split-origin-replay.mjs"
node "$JM_CANDIDATE/test/fixtures/record-split-origin-replay.mjs" \
  "$JM_BASE" "$JM_CANDIDATE" "$JM_BASE/builds/e2e-dictionary-cache" \
  "$JM_OUTPUT/two-workers.json" jmdict 2 8
node "$JM_CANDIDATE/test/fixtures/record-split-origin-replay.mjs" \
  "$JM_BASE" "$JM_CANDIDATE" "$JM_BASE/builds/e2e-dictionary-cache" \
  "$JM_OUTPUT/three-workers.json" jmdict 4 8
```

For regressions, copy `sources/original-independent.test.js.txt` into the PR checkout as `test/term-record-sliced-origin-independent.test.js`. Run the following there; the original run intentionally retains the one staging-expectation failure described above. Repeat after replacing that test with `sources/adapted-independent.test.js.txt` for the 75-pass check.

```sh
node node_modules/vitest/vitest.mjs run \
  test/term-record-split-reference-origin.test.js \
  test/term-record-sliced-origin-independent.test.js \
  test/term-record-reference-origin.test.js \
  test/term-record-validation-runs.test.js \
  --maxWorkers=1 --testTimeout=60000
```

For package reproduction, run `npm run license-report:html` and `npm run build -- --target chrome` in each checkout, then compare the uncompressed bytes of every ZIP entry. The exact expected changed-entry set is the single file above; ZIP container hashes and sizes can depend on the packaging environment.

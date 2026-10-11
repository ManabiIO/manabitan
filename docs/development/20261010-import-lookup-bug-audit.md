# Generic import and lookup bug audit

## Scope and source heads

Audited on 2026-10-11 in an isolated worktree based on current `develop`,
`e05294d263582b58bbe92c5e9f97349f6f60df31`. A final fetch before publication
confirmed that head and `main` at `81b149f44426dbfa8bca6af57f3bef9a3af02620`.
The user's original checkout and other workers' branches were not changed.
Repository and parent AGENTS instructions and the optimize-manabitan skill were
read; the user's narrower validation limits override their broad build and test
requirements. Existing intentional Yomitan names are retained.

Ownership covers generic Yomitan import, lookup, dictionary database, generic
record/content persistence, compression/dedup and worker lifecycle. No file with
an MDX/MDict basename or directory component was edited. Open develop PRs #482,
#483 and #484 belong to the separate MDX task and do not duplicate this fix.
PR #481 is a separate main-only suffix-classification fix; develop already has
that fix in `51f2b0b1d`, so it is not a current-develop finding.

## Demonstrated bug: transient descriptor recovery persists false missing data

At the audited head, `ext/js/dictionary/term-record-opfs-store.js:5873–5913`
reconstructs a missing `.mbtr` descriptor from its authoritative `.mbti`
container. Its catch logs and swallows every failure, including transient
container stat/header reads and descriptor writes. The swallowed-error catch
was introduced by `255e9a0467d47d210168ab1c32ec38c047429037` ("Store term
records in one self-repairing container").

When the only descriptor needs recovery, a failed recovery allows the shard scan
to fulfill with zero registered shards despite intact authoritative bytes.
Database startup awaits record-store preparation at
`ext/js/dictionary/dictionary-database.js:9299`, then verifies installed summaries
at line 822. `_cleanupMissingTermRecordShards` (4515–4558) interprets the absent
registered shard as missing data and calls `markDictionaryReimportRequired`.
The health callback (4173–4187) writes that terminal state to
`dictionaryStorageHealth`; `_restoreTermRecordDictionaryHealth` (4210–4228)
restores it on subsequent startup. Successful later descriptor reconstruction
therefore does not by itself remove the persisted reimport requirement.

The regression uses existing fake OPFS handles and a single actual term row.
It executes the real database cleanup and health callback with a tiny SQL
adapter, in the same scan-before-cleanup order as startup. Before the fix the
descriptor-write case records the health insertion bind values
`["Retry descriptor recovery", "Retry descriptor recovery", "Dictionary record data is missing"]`.
The container-stat and header-read cases also incorrectly fulfill the scan
instead of reporting their errors. All three regression cases fail on the
unmodified develop source.

The minimal fix rethrows the original recovery error after existing diagnostics.
An incomplete scan can no longer reach startup's missing-data inference. The
write-failure regression also retries the same store, verifies the rebuilt
descriptor signature and successful lookup, and asserts no terminal health
insertions. Two additional tiny cases cover a transient authoritative-container
stat or header-read failure, unchanged authoritative bytes, and successful
same-store retry. Existing neighboring cases retain successful descriptor
reconstruction, retryable descriptor stat failure, and the genuine both-files-
missing reimport verdict. All fixtures are constructed in memory using the
existing test helpers; no external fixture or dictionary download is needed.

### Performance and availability implications

The change adds only an exceptional-path throw: no healthy-path allocation,
comparison, additional OPFS/SQLite I/O, streaming change, batching change,
compression/dedup change or new retained data. It stops subsequent startup work
on the failed scan rather than publishing a falsely complete scan. A transient
recovery failure now rejects startup, potentially delaying other dictionary
availability until a later retry. No automatic retry policy is added. This is
an intentional availability tradeoff to avoid a durable false corruption
verdict. Same-store retry is exercised; no benchmark supports a claim of zero
performance regression.

## Actual validation

- Baseline: the three focused new/strengthened cases failed (162 other cases
  skipped); the write case demonstrated the false persisted health insertion.
- Fixed: six focused cases passed, 159 skipped, with Vitest 3.0.9 and existing
  Node 22.22.0. The final run spent 34 ms in those cases, 1.75 s total.
- Scoped ESLint for the source and test passed. Its config emitted an existing
  CommonJS-in-ESM warning from the excluded MDX pako vendor file; that file was
  not changed. `git diff --check` passed.

Reproducible focused command:

```sh
node node_modules/vitest/vitest.mjs run test/term-record-opfs-store.test.js \
  -t 'retries descriptor recovery after|retries missing descriptor recovery after|recreates a missing descriptor|retries a transient descriptor stat|requires reimport when both descriptor' \
  --maxWorkers=1 --minWorkers=1 --reporter=dot
```

Existing dependency packages and generated libraries were reused through local
links; nothing was installed or rebuilt. No full tests, builds, native builds,
browser/e2e/soak suites, benchmarks, user database or large dictionaries were
used. The SQL adapter records the real health callback's write but does not
exercise SQLite persistence or the full public browser startup. Real OPFS,
restart behavior and the broad runtime remain uncovered by this bounded check.

CI inspection found broad PR-triggered tests/builds/e2e in
`.github/workflows/ci.yml` and a matching dictionary path in
`manabitan-web.yml`. The commit uses `[skip ci]` to avoid that automatic work;
no workflow or production configuration is changed and no workflow is dispatched.

## Reviewed areas without another demonstrated correctness bug

Disjoint Sol 6.1 Medium reviewers examined current-develop generic importer
fallback/cancel ownership, worker startup and error settlement, queued content
writes, cursor/reservation cleanup, compression barriers, content dedup reads,
generation fences and record recovery. These were source reviews, not runtime
coverage claims. Notable reviewed protections include fallback abort-and-join
before replay in `dictionary-importer.js:2130–2208`, pipeline cache/ownership
release in `term-bank-source-pipeline.js:173–227`, worker/sink shutdown and
join in `term-bank-wasm-parser.js:2513–2743`, and startup/messageerror settlement at
3084–3136. Recent fixes `b27926c30`, `5292851ba` and `570490abd` already address
several older failure-path leads. Database import-session ownership, rollback
journals and commit markers were also inspected; no additional bug was proven.
Yomitan schema/compatibility, duplicate expression/reading and Unicode lookup
leads did not yield another current-develop repro. This is bounded coverage,
not a clean bill of health for those systems.

One allocation concern remains: `term-content-opfs-store.js:855–857` retains
every active-import chunk in `_importReadOverlayChunks` until session cleanup,
so the queued-write budget does not bound cumulative retained overlay bytes.
The current exact dedup fallback needs arbitrary earlier-content reads
(`dictionary-database.js:6140–6190`), including while the OPFS writable is open.
Trimming that overlay without providing readable committed snapshots can break
dedup correctness. This audit makes no speculative retention change; evaluating
that design requires separate ownership and measurements.

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
It now executes public `DictionaryDatabase.prepare()` and
`TermRecordOpfsStore.prepare()`, real failure cleanup, database integrity cleanup
and the health callback with fake OPFS and a tiny SQL adapter. SQLite connection
opening, unrelated migration/legacy-import cleanup and zstd worker initialization
are mocked. Before the fix the
descriptor-write case records the health insertion bind values
`["Retry descriptor recovery", "Retry descriptor recovery", "Dictionary record data is missing"]`.
The container-stat and header-read cases also incorrectly fulfill the scan
instead of reporting their errors. All three regression cases fail on the
unmodified develop source.

The fix rethrows recovery I/O errors after existing diagnostics and explicitly
skips malformed or unsafe header metadata. An incomplete I/O scan can no longer
reach startup's missing-data inference. The write-failure regression retries
public `prepare()` on the same database and record store, verifies that failed
startup closes its connection and clears `_isOpening`/`_openingPromise`, and
checks successful descriptor reconstruction and lookup with no terminal health
insertions. Two additional tiny cases cover a transient authoritative-container
stat or header-read failure, unchanged authoritative bytes, and successful
same-store retry. Existing neighboring cases retain successful descriptor
reconstruction, retryable descriptor stat failure, and the genuine both-files-
missing reimport verdict. All fixtures are constructed in memory using the
existing test helpers; no external fixture or dictionary download is needed.

### Review correction: permanent corruption stays dictionary-local

Review identified that the initial blanket throw also propagated the deterministic
`RangeError` from `readSafeU64Le(header, 8)` when descriptor-length metadata
exceeded the safe integer range. A new two-dictionary public-prepare regression
failed on PR head `732cce382`: the corrupt orphan prevented preparation despite
the healthy neighbor. Bad-magic and truncated-header variants already passed.
Explicit header-length and safe-integer checks now skip invalid metadata just
like the existing magic/count/length checks, while rejected stat/read/write
operations still propagate. The corrupt dictionary receives the existing local
reimport verdict; healthy-neighbor lookup and public dictionary-info listing
remain available in all three corruption cases. No files are deleted by this
new validation.

`DictionaryDatabase._prepareOnce` (794–856) clears `_openingPromise` in `finally`;
`_cleanupAfterPrepareFailure` (9375–9401) ends sessions and releases/nulls the
connection through `_releaseRuntimeConnection` (920–942). The public retry test
exercises those actual methods rather than only repeating a private shard scan.
At the backend boundary, `_ensureDictionaryDatabaseReady` (5078–5101) also clears
its promise in `finally`, and `Backend.prepare` (381–408) resets its preparation
promise after rejection. There is no retained rejected database promise in the
tested path. However, startup awaits readiness (backend line 863), and extension
message dispatch is gated by backend preparation (1032–1043), so permanent
metadata failures must not escape into global startup: otherwise dictionary
listing/removal requests can be blocked too. These UI implications are source
traces; no browser UI was run.

### Performance and availability implications

The change adds an exceptional-path throw plus scalar length/safe-integer checks
only while recovering a missing/empty descriptor. It adds no I/O, retained data,
new healthy-lookup allocation, streaming change, batching change,
compression/dedup change or new retained data. It stops subsequent startup work
on the failed scan rather than publishing a falsely complete scan. A transient
recovery failure now rejects startup, potentially delaying other dictionary
availability until a later retry. No automatic retry policy is added. This is
an intentional availability tradeoff to avoid a durable false corruption
verdict. Same-database public preparation retry is exercised; no benchmark supports a claim of zero
performance regression.

## Actual validation

- Develop baseline: the three focused cases failed again using the strengthened
  public preparation regression (165 other cases skipped); the write case
  demonstrated the false persisted health insertion.
- Review baseline: unsafe-length orphan preparation failed at `732cce382`, while
  the public same-database transient retry, bad-magic and truncated cases passed
  (one failure, three passes, 164 skipped).
- Fixed: nine focused cases passed, 159 skipped, with Vitest 3.0.9 and existing
  Node 22.22.0. Only this focused selection was run.
- Scoped ESLint for the source and test passed. Its config emitted an existing
  CommonJS-in-ESM warning from the excluded MDX pako vendor file; that file was
  not changed. `git diff --check` passed.

Reproducible focused command:

```sh
node node_modules/vitest/vitest.mjs run test/term-record-opfs-store.test.js \
  -t 'isolates a .* orphan container|retries descriptor recovery after|retries missing descriptor recovery after|recreates a missing descriptor|retries a transient descriptor stat|requires reimport when both descriptor' \
  --maxWorkers=1 --minWorkers=1 --reporter=dot
```

Existing dependency packages and generated libraries were reused through local
links; nothing was installed or rebuilt. No full tests, builds, native builds,
browser/e2e/soak suites, benchmarks, user database or large dictionaries were
used. The SQL adapter records the real health callback's write but does not
exercise SQLite persistence or browser startup. Public database/record-store
preparation and same-instance failure cleanup/retry are covered with adapters. Real OPFS,
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

## Independent continuation review (2026-10-10, America/Toronto)

The visible local continuation reviewed PR #485 at
`a2d2cf539266f01b85741fdb88bbc345348ca6a5` in a separate clone. A fresh GitHub
read and fetch confirmed the PR head and develop base
`e05294d263582b58bbe92c5e9f97349f6f60df31`. The parent benchmark checkout,
dependency pins, preserved task-21 worktree, MDX work and native workers were
not changed. The earlier audit's date is retained as historical evidence.

This review traced descriptor reconstruction, scalar header validation,
write/close/abort error propagation, public prepare failure cleanup, and lazy
lookup validation. No additional reproducible correctness defect was found in
that bounded review. The existing nine focused record-store cases were executed
again in the isolated checkout: nine passed, 159 skipped. This is new local
adapter verification, not new browser/SQLite/OPFS qualification.

The content overlay is a separate lifetime from pending/queued/in-flight writes.
`_appendBatchInternal` retains every nonempty OPFS-backed import chunk;
`_drainQueuedWrites` releases queued write references but does not release those
overlay references. `flushImportWrites` does not close the writable or publish
a new snapshot. The overlay remains readable after writeback so exact dedup can
compare arbitrarily early content after recent/in-flight source caches miss.
It includes stored content blocks and reference slabs, rather than necessarily
the uncompressed source archive. Its logical byte counter is not a measurement
of heap or unique retained backing-buffer capacity.

Successful `endImportSession` clears the overlay after closing the writable;
validated rollback clears it before abandoning pending writes and restoring the
checkpoint. Draining or capping it independently would risk reading an old File
snapshot or reporting missing content during exact dedup. No eviction, stream
rollover policy, new copies or storage protocol change was introduced. The
queued-write budget therefore still does not bound cumulative overlay retention;
no throughput, heap reduction or zero-regression claim is made.

Five existing focused content-store cases were also run: five passed, 30 skipped.
They cover batch overlay reads (including a cross-chunk span), old-snapshot
reads while writes are pending and overlay release at successful finalization,
sticky queued-write errors, residual write admission, and rejected-write
rollback. Reproduction:

```sh
node node_modules/vitest/vitest.mjs run test/term-content-opfs-store.test.js \
  -t 'reads an import-overlay batch|keeps queued write failures sticky|queues a residual import write|rollback survives a rejected queued write|reads the pre-import snapshot' \
  --maxWorkers=1 --minWorkers=1 --reporter=dot
```

Both selections used Node 22.22.0 and Vitest 3.0.9.
Scoped ESLint passed for both source/test pairs (with the existing excluded MDX
vendor CommonJS warning); Markdown formatting and `git diff --check` passed.
Existing dependency packages were reused through a local directory of package
links; runner caches were local
to the clone. An initial runner launch was blocked when its whole-directory link
would have placed a config cache in shared dependencies; no test executed in that
attempt. Nothing was installed or rebuilt. Real recovery close/abort failures,
browser startup/message gating, durable SQLite health writes across restart,
and large-import retained heap remain unqualified. No broad suites, builds,
browser captures, benchmarks, merges or deployment ran. A future retention change
needs a measured readable-snapshot design that preserves exact dedup and existing
write/publication order.

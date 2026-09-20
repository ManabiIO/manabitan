# Import publication acknowledgement and journal snapshots

Base: `6cf7c3df7b3038b4a7c91ee7d9d469d1cc171108` (`develop`).

## Repairs

`finishBulkImport` can successfully COMMIT and then fail during cache reset, runtime pragmas, metrics, or final resource closure. Previously the import session learned about publication only when that entire promise fulfilled. Its failure cleanup could consequently delete the dictionary SQLite had committed. The finalizer now synchronously acknowledges publication to its owning session immediately after the commit and local journal-ownership transition. Later errors are still reported, but cannot authorize incomplete-import deletion. Pre-commit rollback and cleanup behavior is unchanged.

The journal now serializes its admitted record before any filesystem await, validates the serialized bytes, and writes that snapshot. Caller mutations cannot change previously admitted checkpoints during asynchronous setup. Invalid custom serialization fails before a writable can be opened. This is a journal API boundary guarantee; no production importer mutation was observed.

Only three production modules change. There is no storage format, migration, flag/default, batching, or concurrency-budget change.

## Reproduction

```sh
node test/fixtures/import-publication/check.mjs . /tmp/publication.json
node test/fixtures/import-journal-snapshot/check.mjs . /tmp/journal.json terminal
node test/fixtures/import-journal-snapshot/check.mjs . /tmp/journal-operation.json injection-only
npx vitest run test/import-publication-journal.test.js
```

Node 22.5+ is required by the SQLite fixture; local execution used 22.16.0 and SQLite 3.49.1. At the tests-first baseline the identical fixtures produced 15 passes/19 failures for publication and 14 passes/31 failures for journal snapshots. With repairs: 34/34 and 45/45. Publication executes the complete production session plus the extracted finalizer method and real on-disk SQLite transactions, with controlled unrelated database helpers and OPFS boundaries. Independent SQLite readers verify committed rows before and after cleanup. The journal fixture uses real temporary files with commit-on-close semantics; its two error models are not native browser OPFS. No full importer or native crash/power-loss qualification is implied by these tests.

The standalone publication fixture extracts the method from the complete checkout. Local review first used a manually retained method excerpt; an initial transcription error was corrected before recording the cited results. The corrected excerpt was subsequently verified byte-identical against the exact repository archive. The qualification workflow reruns the same assertions against actual checkout source. Tests-first and repair commits remain separate. Review Actions results on the published head for full-unit/options/types/lint/build outcomes; never attribute a different composition's CI results to this one.

## Remaining native gates

Exercise actual Chromium/Firefox imports with failure after COMMIT, after journal cleanup, and during resource disposal. Confirm the committed summary, lookup rows, and OPFS content survive cleanup/reopening; pre-commit failures must still roll back. Qualify application update/cancellation/restart handling and WebKit separately. No optimization or complete-import speedup is claimed.

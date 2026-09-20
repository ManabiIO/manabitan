# Snapshot admitted import journals before asynchronous filesystem work

Base: `6cf7c3df7b3038b4a7c91ee7d9d469d1cc171108` (`develop`).
Tests-first commit: `05b8a45bef2655f99fea8c34a0ef4294c8db1dba`.

## Scope and repair

Only `ext/js/dictionary/dictionary-import-journal.js` changes in production. The journal previously validated the caller's mutable checkpoint, awaited root/handle/writable creation, then serialized it. Caller mutation during those awaits could change the admitted session or recovery inventory. Invalid custom serialization could also reach a writable after object validation.

Serialize before the first await, validate the serialized record, and write those frozen bytes. Serialization failure occurs before filesystem access. Existing write/abort error aggregation, previous committed-file preservation, missing-file handling, and OPFS-unavailable behavior are unchanged. No format, migration, option/default, batching, or concurrency-budget change is introduced. This is an API-boundary guarantee; the current importer was not observed mutating its privately created checkpoint during these waits.

## Regression evidence

The identical 45-case standalone fixture gives **14 passes / 31 behavioral failures** on the exact baseline and **45 passes / zero failures** with the repair. Both injected-operation and terminal-stream error models pass with no observed unhandled rejection. These models use real temporary files and commit-on-close replacement, not native browser OPFS.

Cases cover mutations at root/handle/writable acquisition; checkpoint lengths, names, inventories, and session IDs; invalid custom serialization; cyclic/throwing serialization before I/O; preserved previous journal after write/close failure; aggregated write/abort errors; ordinary round-trip/clear; malformed/unreadable files; invalid input; and unavailable OPFS. The two Vitest wrappers execute the same 45 cases under two boundary models; they are not 90 distinct cases.

```sh
node test/fixtures/import-journal-snapshot/check.mjs . /tmp/journal.json terminal
node test/fixtures/import-journal-snapshot/check.mjs . /tmp/journal-operation.json injection-only
npx vitest run test/dictionary-import-journal-snapshot.test.js --maxWorkers=1 --minWorkers=1
```

Run the standalone fixture at the tests-first commit to observe the same 31 failures, then at the fixed head without modifying assertions.

## Qualification and composition

[Qualification run 35531498272](https://github.com/ManabiIO/manabitan/actions/runs/35531498272) executed the exact production repair and identical formatted fixtures in a larger, separately retained composition at `b297ddd8c8b798fef3713af931a7cff6e42599d1`. That composition passed 6,764 unit tests with 46 skipped, options tests, all four TypeScript projects, changed-source lint, and the all-target dry build. Its source/evidence artifact is `import-publication-journal-qualification`, ID `10610844902`, SHA-256 `d05fe2bd090abf0cb1e185638e8d6f366c40484ae266dfeba683f87ea77b5a6b`. Retention is seven days. Its broader results do not substitute for the independent PR's own normal CI.

The independent PR intentionally excludes publication-acknowledgement changes and their fixture because another active branch, `fix/import-publication-ownership-20260920`, addresses overlapping publication cleanup and session ownership. Neither that branch nor its changes were overwritten. Research workflows, transport patches, and rejected optimization sources are not part of this PR.

Two qualification attempts before the successful run stopped on new fixture formatting/lint issues. Those were corrected without weakening assertions. The final formatted fixture produced the same baseline and repaired results against actual repository source.

## Remaining gates

Require the independent head's normal lint/types/unit/build and browser CI. Native quota/write/close failure injection, application journal restart/crash/update/cancellation qualification, and WebKit remain separate gates. No whole-import speedup is claimed.

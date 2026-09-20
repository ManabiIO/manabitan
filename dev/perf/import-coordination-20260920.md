# Import journal ordering and session callback ownership

## Scope

Baseline: `5e2af5627e0510bc27cbdc968575f0ebe0ed3706` (`develop`).
Only the journal and session modules change in production. This publishes the
previously local correctness implementation, with a smaller repository-ready
regression fixture. It does not include the optional content-hashing experiment
or the unrelated OPFS patch bundles.

Journal reads, writes, and clears now share one per-instance operation queue.
Empty-file cleanup executes inside the existing queue owner. Write inputs still
snapshot before any filesystem await, preserving the already-merged snapshot
repair. Operation failures remain observable without poisoning subsequent
explicit recovery.

Session start, resource disposal, finalization, and placeholder cleanup publish
their shared promises before invoking callbacks. A healthy cleanup no-op does
not consume the later cleanup opportunity. The existing database session-ID
checks and guarded placeholder deletion are unchanged.

## Reproduction

```sh
node --test test/fixtures/import-coordination/reentry.mjs
npx vitest run test/dictionary-import-coordination.test.js
```

Tests-only commit: `a7e99e66749ee6298ebcc7ff5a2765ccccc74dec`.
At that source, the identical 17-case runner produces 5 passes and 12 behavioral
failures. The fixed source produces 17 passes, zero failures, zero skips, and zero
cancellations in Node 22.16.0 on Linux.

Production Git blobs verified against the locally executed source:

- Journal: `e718f954eaf34e37a369537059f5b449a5bc8a29`
- Session: `cf2c48c6c15ac17381b24f9d29f4f285d35503da`

A separately retained 49-case temporary-file fixture from the preceding local
review was rerun: baseline 37 passes / 12 failures, repaired 49 passes / zero
failures, with zero observed unhandled rejections. These are overlapping checks,
not 66 independent defects or additional full-unit tests.

## Witnesses and boundaries

An old empty-file read previously deleted a newer successfully written journal.
Delayed clears and writes could similarly overtake one another. The fixture uses
captured Blob snapshots and commit-on-close writable doubles at the filesystem
boundary; it is not native OPFS qualification.

Reentrant source/parser disposers previously closed the archive before the
original disposer completed. Other callbacks could duplicate database start,
finalization, and cleanup calls. Database calls in the fixture use explicit
boundary doubles; two finalizer calls are not evidence of two SQLite commits.

The journal queue is instance-local. Cross-instance ownership remains the
application coordinator's responsibility. A callback must not await the same
operation that owns it; self-dependent callback cycles are not supported.

## Merge gates

Require green full repository unit/options/type/lint/build checks and the actual
Chromium/Firefox extension and static-runtime acceptance lanes on the final PR
head. At initial publication these CI results were not yet available. Native
quota/power-loss fault injection and complete application cancellation/recovery
qualification remain outside the local evidence. No import speedup or release
readiness is claimed.

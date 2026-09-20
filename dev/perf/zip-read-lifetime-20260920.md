# Released ZIP read lifetime repair

## Scope and source

Base: `54ac62a39386459b7822fc644e5a1a6b1a619619` (`develop`, merged #65).
Tests-first commit: `13344f06103385cf5f3ad873e0c126ba8915d83d`.
Production baseline blob: `80d5758b5e5f00476ca833c4093f3f1bff953ab8`.
Repaired production blob: `3166e4ab89f5550c56038fcb2d0cece2d293f0bf`.
Test blob: `c7adf378df821e180de9ff72afc5d57094806c32`.

Source and CI context are tracked in the [Manabitan repository](https://github.com/ManabiIO/manabitan).

`AbortableZipReadPool.release` evicted cache entries while `abortAndJoin`
used that cache as its only ownership inventory. An unfinished released
read could therefore remain running after disposal returned. Re-reading
the same entry also left the older generation without an abort/join owner.
This is a demonstrated helper/pipeline contract failure, not a claim of
observed end-user data loss or of a fully reproduced whole-import failure.

The repair separates pending-read ownership from cache membership. Settled
reads leave the pending set on either outcome. Release still permits a new
read, promise sharing remains entry-identity keyed, and disposal still
waits for all earlier abort joins. No parser, storage format, lookup,
batching budget, watchdog, or import optimization flags change.

## Executed regression evidence

Node 22.16.0 on Linux x64. Command:

```sh
node web/zip-read-pool-check.mjs
```

The runner uses the same Vitest test source and assertions, replacing only
the test-runner import and resolving the production import to its file URL.
There are no copied production implementations. Reads at the external I/O
boundary are manually settled to reproduce non-interruptible work.

| Source               | Cases | Pass | Behavioral failures | Skipped/cancelled | Exit |
| -------------------- | ----: | ---: | ------------------: | ----------------: | ---: |
| Tests-first baseline |     7 |    2 |                   5 |                 0 |    1 |
| Repaired source      |     7 |    7 |                   0 |                 0 |    0 |

Failures cover released pending reads, both generations after re-read,
plain and compressed pipeline release, overlapping abort passes, and a
late rejection. Passing controls cover identity sharing, settled release,
idempotent disposal, closed-pool rejection, and synchronous reader throws.
The exact final source and test blobs above were rerun RED then GREEN.

## Remaining gates

This is not a full Vitest run or a claim that repository lint, types,
builds, Chromium/Firefox integration, or OPFS recovery passed. Dependency
installation and direct repository downloads were unavailable locally.
Before merging, install dependencies and run:

```sh
npm ci
node web/zip-read-pool-check.mjs
npx vitest run test/zip-read-pool-lifetime.test.js test/raw-zip-range-reader.test.js
npm run test:ci:lint
npm run test:ci:types
npm run test:ci:unit
npm run test:ci:build
```

Also exercise real import cancellation, fallback, immediate restart and
archive close in Chromium and Firefox, including released prefetched
reads. Confirm the five baseline failures pass with unchanged assertions.
Preserve unrelated open watchdog repairs #66/#67 and the merged #65 stack.
This repair is independent of the separately measured ZIP-header read
coalescing experiment; no performance win is claimed for this fix.

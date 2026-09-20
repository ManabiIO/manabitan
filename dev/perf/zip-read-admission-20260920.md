# ZIP read admission and reentrant disposal ownership

## Scope and stack

This correctness change is stacked on the
[import coordination repair](https://github.com/ManabiIO/manabitan/pull/79), at
parent `2c83a7d1ba04c5f14be3f38a8bea9c95ee0187bf`. Only
`ext/js/dictionary/term-bank-source-pipeline.js` changes in production. Its
`RawZipPayloadReader` and all batching/source budgets are unchanged. The change
does not include the independent ZIP-header coalescing or hash experiments.

## Reproduction and repair

The read pool previously invoked the supplied reader before registering the
read's identity and pending lifetime. Synchronous callback reentry could start a
duplicate read, undo an explicit release, overwrite a replacement cache entry,
or allow abort/disposal to finish without joining the in-progress read. The
plain and compressed source-pipeline paths both reproduce the lifetime gap.

The pool now registers a deferred promise before invoking the callback, then
forwards its exact result or error into that promise. Reader callbacks and abort
notifications retain synchronous timing. Byte identity, cache sharing, pending
ownership after release, and source budgets remain unchanged.

Disposal similarly publishes its shared promise before dispatching abort events.
An abort listener that reenters disposal joins the original promise instead of
starting a second disposal operation. This uses the existing `deferPromise`
helper; no new scheduler or global lock is added.

## Tests-first evidence

Tests-only commit: `9fbb9f47f170fc8b192657b0cb9bf5eeaba81851`.
Repair commit: `1f228ed0d617549f3cf27943c3fffbb2a5ce9e42`.

```sh
npx vitest run test/zip-read-pool-reentry.test.js --maxWorkers=1 --minWorkers=1
```

The identical final 13-case fixture produces **3 passes / 10 behavioral failures**
on the baseline, **12 passes / 1 failure** after fixing read admission only, and
**13 passes / zero failures** with both repairs. There are no skipped cases.
Baseline source blob: `3166e4ab89f5550c56038fcb2d0cece2d293f0bf`.
Fixed source blob: `669b07172b1ee8a75fc64a16d9188a82c78cd9c0`.
Final test blob: `19da516b2fd51dcf38afe653841830249107d4ed`.

Eight focused/adjacent suites passed **133 tests**. A full unit run with the new
assertions passed **6,823 tests**, with 46 existing skips and zero failures.
Subsequent test-only type annotations were checked again against both the red
and green production sources, with the same 3/10 versus 13/0 results. Main/dev
TypeScript checks and the final test/bench checks passed; targeted source/test
ESLint passed.

Two attempts to run the entire repository's ESLint process locally exceeded the
four-GiB container limit (one killed process and one V8 heap failure). These are
not passing lint receipts. Require the exact published head's normal repository
CI, which has the appropriate runner resources. Initial test type errors were
repaired with explicit boundary types, not suppressed rules or weakened tests.

## Boundaries and remaining gates

Tests execute the production classes with controlled reader callbacks, using
actual AbortController events and promises. They demonstrate a helper/pipeline
contract defect; they do not establish that the normal application currently
invokes every reentrant callback schedule, or that a user experienced data loss.
Callbacks must not await the operation that owns them. No native power-loss or
filesystem fault injection is claimed.

Require green full unit/options/type/lint/build, Chromium/Firefox extension, and
static-runtime CI on the final stack. Actual cancellation/fallback/restart under
native storage remains additional qualification. This is a correctness repair,
not a performance optimization or release-readiness claim.

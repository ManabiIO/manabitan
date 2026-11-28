# Untimed complete importer parity and owner accounting

This driver is adapted from the exact audited f28 correctness driver
`97963dba2500c4ba557ec2c2b2367b74199e6ced` and orchestrator
`ebbfddf86e8b2f6ce1f008a3ac88ffe8bf0cca4b`. Disk OPFS, worker/runtime adapters,
the actual-I/O smoke and the enclosing link-safe archive writer are reused byte
for byte. This is a new a300-to-fusion correctness acquisition, not a replay of
old receipts or a performance study.

## Running

The enclosing workflow pins Node22.22.0 and requires Python3.11 or newer. It
prepares independent checkouts/dependencies and uses the real pinned fixture
archives. The serial orchestrator interface is:

```
python3 run-all.py --baseline-root BASELINE --candidate-root CANDIDATE \
  --candidate EXACT_CORRECTNESS_COMMIT --fixtures FIXTURE_DIRECTORY \
  --output FRESH_EVIDENCE_DIRECTORY
```

`--preflight-only` performs full generated-runtime inventory/delta validation
without fixtures, product module evaluation or imports. The full mode repeats
that same preflight before the existing adapter smoke and fresh child processes.
Each child retains the six-argument interface:

```
node run.mjs REPOSITORY DICTIONARY ARCHIVE FRESH_OUTPUT A|B EXPECTED_COMMIT
```

There is no timing mode. Output roots must be fresh, disk-backed and have at
least4GiB available. No readiness wait or native prewarm is introduced. Failure
halts the remaining sequence and is preserved without a replacement observation.

## Whole-operation accounting

The old field-only before/after observer misses fusion work performed before
`_encodeArtifactRecordFields`. `owner-observer.mjs` now records each actual
`_encodeAndAppendArtifactChunkForState` invocation. It snapshots the owning
session before invocation and after the original Promise settles, attaches its
observer before the caller resumes, and returns the exact original Promise.
Concurrent or nested owners fail closed rather than being attributed to an
incorrect interval. No source metadata, Promise or output is substituted.

The synchronous field hook still records every actual field buffer's length and
SHA256, row count, numeric content base and Float64 base bits. It also records
its owner ordinal and whether the fifth argument is the exact successful whole
result returned by the source-bound helper. Ordinary native work is observed
inside the field hook; whole work is reconciled at the surrounding owner.

The retained ledger must satisfy all of these equations:

- Actual field entries equal session calls, native successes plus JavaScript
  outcomes, and the complete fixture row count.
- Whole successes are unsplit whole owners. Direct whole calls/rows/attempts
  reconcile with those actual output witnesses; ordinary native success alone
  cannot pass the fusion activation gate.
- An attempted whole call copies `8 * ownerRows + 12 * uniqueCount` input bytes.
  Each ordinary attempted field call charges its own corresponding input shape.
  Each attempted call requests its exact power-of-two score table. No copied
  work is omitted because it happened before the field hook.
- Output-copy bytes equal every successful native field buffer plus8bytes for
  each successful whole call's copied base scalar.
- Native attempts equal successes and actual native-decline outcomes. The
  whole-copied diagnostic map overlaps an ordinary decline only when the exact
  copied, unsplit fallback commits that outcome. That authenticated overlap is
  subtracted once; maps are never naively summed. A true split retains the
  failed whole work and all ordinary slice attempts.
- Pre-readiness JavaScript calls and all allowed eligibility/memory/compact
  declines remain visible. Disabling failures, guard exceptions, copy failures,
  malformed native returns and unavailable encoders reject the correctness gate.
- All direct native work totals equal the sum of enclosing-owner deltas. Memory
  growth is page-aligned and respects the helper's64MiB private arena cap.

The pure JavaScript suite includes success before the field hook, ordinary work,
unsplit and split declines, duplicate/missing copies, output-base bytes, owner
membership, original Promise identity/rejection and signed-zero serialization.
The Python comparator independently recomputes owner partitions, direct call and
copy/table ledgers, then compares every A/B field output and finalized term file.
Neither test suite imports product code or acquires observations.

## Current SQLite and content scope

The retained f28 outer-body check correctly failed during source adaptation:
a300 now delegates opening/admission to `_openSupportedDictionaryConnection`.
Both current A/B bodies were independently extracted and proved equal. The
three `baseline-*.txt` files bind the exact outer method, admission method and
schema-version12 source line. Only admission-helper storage dependencies are
rebound to real memory SQLite and explicit adapter diagnostics. The outer method
and all schema/version/content-root checks execute unchanged.

The driver observes a fresh epoch-zero content root before importing and requires
that same root mode after publication. Legacy flat segments and every record/
lookup sidecar are in the full byte oracle. Arena/online paths fail closed;
upgraded content roots are not claimed. The only byte normalization remains the
16 random generation bytes at MBTRD16X offset8 and MBTIDX11 offset24. Scalar base
bits retain the distinction between positive and negative zero independently of
JSON numeric formatting.

## Receipts

Each original arm retains source-before/source-after, fixture/host and adapter
receipts, all worker requests/results, complete field-calls and owner-calls,
actual final session/DB metrics, initial/final content state, semantic probes and
complete file hashes. A/B parser groups, actual bank boundaries, CRC/reuse totals
and fallback counters must match. The comparator and driver both preserve
original failures; neither excludes fallback calls or difficult groups.

Successful sinks are deleted only after both arms pass full equality and a second
raw-byte hash confirms their unchanged inventories. Failed bytes remain. The
workflow archives names containing pipes and preserves inert smoke symlinks
without following them. Detailed receipts remain available even when no corpus
qualifies. There are no browser, restart, full-media or timing claims.

## Problem

Projected dictionary images already own the diagnostic key bytes needed for errors, but import bookkeeping wraps those bytes in an entry object and clones the requirement again when deferring media. Dense ZIP setup also allocates a temporary assignment object per entry, and packed media copies and sorts its records even when they are already in physical archive order.

## Change

- Create one internal projected media requirement containing its path and owned diagnostic fields, and reuse it through deferred resolution.
- Attach the shared data reader directly to each private dense ZIP entry.
- Detect nondecreasing physical offsets during the existing validation pass. Reuse that record order when possible, retaining the sorted-copy fallback for other request orders.

The existing diagnostic-byte copy boundary, first-reference ordering, ordinary image target/getter behavior, cancellation, CRC checks, header/range validation and persistence format are preserved.

## Validation

- 140 focused tests passed, including immediate and deferred resolution, copied diagnostic keys after parser memory reuse, mixed projected/fallback references, first-reference errors, sorted/reversed/duplicate ZIP offsets, and cancellation joining an active read.
- Main/test TypeScript, scoped ESLint and the all-target build dry run passed.
- Independent review of this frozen change found no blocker.
- Full units, locked-corpus media parity, PR CI and frozen browser comparisons are in progress. This is a draft; no complete-import speedup or browser memory reduction is claimed yet.

Baseline: `d24b4e56ceb1fe14ad96ef3853f4d397efa6fa26`. Candidate: `ebb0777114578c5cee879877274e7d872bfea27e`. Source tree: `923cd36b875afbbee6e6674fd1b4450bed6ce362`.

Original changes to the repository's existing GPL-covered implementation; no third-party implementation code was added. This follows the existing projected-diagnostics path and is separate from the numeric media-path and direct media-entry proposals.

## Problem

The native lookup-index encoder hashes and inserts every distinct sequence ID even when the source IDs are already increasing. JMdict and Jitendex contain long ordered runs, while VNDB repeatedly uses one ID.

## Change

Append first-seen increasing IDs directly to the existing sequence-key array. Repeated IDs keep the existing adjacent-value shortcut, including across absent sequences. On the first decrease, clear and backfill the existing hash table once, then use the original probing algorithm for the remaining rows.

First-seen key order, validation, error returns, persisted index bytes, scratch allocation and the native ABI are preserved. The pinned Clang/LLD 21.1.8 parser module was regenerated with its source-bound manifest; the module grows from 62,783 to 63,004 bytes.

## Validation

- 107 focused tests passed, covering independent JavaScript encoder parity, collisions, late decreases, maximum supported cardinality, negative gaps, dirty scratch reuse, error recovery and output guards.
- All 7,613,164 rows across 937 locked JMdict, Jitendex and VNDB banks passed the complete component oracle: native parser columns, keys, numeric fields, content, lookup-index bytes and media projections match the baseline, with independent source JSON and ZIP checks.
- That corpus oracle uses declared sequential four-bank component groups. It excludes worker transport, compression and persistence, and its work counts are not browser-planner counts.
- Scoped lint, test TypeScript, pinned native reproduction and the all-target build dry run passed.
- Full unit/PR CI and frozen complete-browser comparisons are in progress. This remains a draft pending those results; no complete-import speedup is claimed yet.

Baseline: `d24b4e56ceb1fe14ad96ef3853f4d397efa6fa26`. Candidate: `ec4e81395a1eb0f6f5fbf4f6d4c591201887e8cf`. Source tree: `3dd10f7c9b24e9ba3429a4d65540210a86d17fa3`.

Original changes to the repository's existing GPL-covered implementation. No third-party implementation code was added. This is independent of the existing record-column and score-run proposals.

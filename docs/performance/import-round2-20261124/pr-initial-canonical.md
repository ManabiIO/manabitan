## Problem

The native canonical-content scanner declares all seven header words volatile, so ordinary row counters repeatedly read and write memory inside the scan. Only journal progress must be visible before each authoritative mutation for synchronous rollback after a trap.

## Change

Accumulate the cursor, pending, exact, resolved and dense counts in local variables. Publish them at every normal return, negative return, exact-batch boundary and intentional fault-test trap. Keep journal progress volatile and retain its existing publication-before-mutation compiler barrier.

The native ABI, scratch layout, journal width, validation and persistent data formats are unchanged. The pinned Clang/LLD 21.1.8 kernel was regenerated; its module grows from 1,624 to 1,760 bytes.

## Validation

- 59 focused tests passed. The new direct native comparisons cover all seven header words, complete output/journal/exact descriptors and authoritative arena bytes on success, errors, continuations and first/middle/late traps.
- The existing owner suite now includes an AbortError exact-read rollback/retry case among 64 differential controls.
- All 219 locked Jitendex banks / 436,555 rows passed captured native-state parity across 55 component calls, including 363,243 pending rows and 38 exact hits, without a fallback group.
- Scoped lint, test TypeScript and pinned native reproduction passed.
- A retained 12-round local component comparison is inconclusive: candidate/control changes overlap the unchanged-product drift. It is not a complete-import speed result.
- Full units, builds, PR CI and isolated complete-browser comparisons are in progress. This remains a draft; no whole-import or process-memory improvement is claimed.

Baseline: `d24b4e56ceb1fe14ad96ef3853f4d397efa6fa26`. Candidate: `d147a60fc4845e898d98d8924968d6094b417007`. Source tree: `e3b9546229ac4118cc3e539678522446d74cff1d`.

Original changes to the repository's existing GPL-covered implementation. The small baseline test module is the exact source-bound artifact from the baseline commit, used solely as the partial-state oracle. No third-party implementation code was added. This does not include the separate compact-journal proposal.

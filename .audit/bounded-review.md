# Bounded compressed imports on accepted develop

## Integration candidate, not a new speed claim

This applies only the bounded source-planning/importer change and its tests from
PR #24 (`ff9cbf2e848a86d6bbfd281179a6d753349e52f4`, relative to #23
`b8d68458cde8788b5d5301ceaf36beae7a1363f9`) onto accepted develop
`da8f7436d34e510441d30692c8d698806b70e13f`.

The production parser stays at blob `836cb10f5aa52177bd82d6fbccb44dd5f3811e2b`.
The accepted #22 inflater remains unchanged. The rejected #19 SIMD scanner,
#23 composite-state experiment, custom ZIP splitter, and later copy/cache
experiments are not imported. No old branch is rewritten or deleted.

Low-memory plans retain the 64 MiB decoded-source budget, independently bound
compressed inputs by 64 MiB, and retain the 80-file cap and ordinary fallback.
These bound source batches, not whole-process memory. No worker defaults,
compression level, persistent format, cache policy or release setting changes.

## Acceptance

Historical #24 percentages compare a different complete parser tree. They are
not measurements of this candidate against accepted develop, and are not reused
as release evidence. The earlier JMnedict slow-tail/equal-work concern remains
open. A conflict-free patch and passing unit tests do not resolve it.

Before promotion, execute full supported-browser correctness and fresh fixed
A/B plans against this exact accepted baseline, with both constrained and
higher-memory runtimes. Report paired changes, equal-work totals, all tails and
same-binary controls separately for JMdict, JMnedict and Jitendex. Incomplete
plans must receive no effect estimate. Verify actual parser/WASM/package and
fixture identities; do not splice prior favorable results into this comparison.

Keep draft until those gates pass. No general import-speed, Apple/phone,
exhaustive persisted-database parity or release-readiness claim is made here.

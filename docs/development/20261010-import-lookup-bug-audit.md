# Generic import and lookup bug audit — 2026-10-10

## Scope and source identity

Audited default `main` at `81b149f44426dbfa8bca6af57f3bef9a3af02620`.
Compared candidates with current `develop` at
`e05294d263582b58bbe92c5e9f97349f6f60df31`. These heads were fetched and
verified again with `git ls-remote` before submission. Main is substantially
older than develop; the findings below must not be described as new bugs in
current develop.

Used an isolated worktree on `fix/yomitan-import-lookup-audit-20261010`.
Read the repository and parent workspace `AGENTS.md`, optimize-manabitan
skill and architecture reference. No repository `.agents` directory exists at
either inspected main checkout or parent workspace. Existing worktrees and
the original develop checkout were preserved. No MDX/MDict paths were edited.
One read-only analysis agent reviewed lookup and record/content ownership.

## Fixed: exact suffix matches misclassified

At main `ext/js/dictionary/dictionary-database.js:2039`, `findTermsBulk`
compared a reversed index key (`value`) with an unreversed query
(`queryData.term`). For `日本`, the suffix index key is `本日`, so the returned
record incorrectly had `matchType: 'suffix'` instead of `'exact'`. Reading
queries and supplementary Unicode characters had the same failure. Extended
suffix results remained suffix results; palindromes accidentally passed.
The match metadata is retained by translator sources at
`ext/js/language/translator.js:1837–1857`.

Blame identifies introduction in
`fae87bc2012c3ded79d92140d663af52d1c4825f` (custom term virtual table/OPFS
optimization). The fix compares `value` with `queryData.query`, placing both
sides in the index coordinate system. Prefix queries already use this same
coordinate system, so their behavior is unchanged.

This is a narrowly reproduced **main-only correction**, not a novel develop
finding: `51f2b0b1d19cb16415eb941dffe27dbb109f8df8` already contains this
comparison fix on develop. No open fix PR targeting main existed at the
pre-submission check (only contribution-license documentation PRs #382 and
#380 were open). Parent integration should choose this small main correction
or the existing develop work, rather than apply both.

### Regression and actual checks

Tiny five-row fixture:
`test/data/manabitan-lookup-regressions/suffix-match-classification.json`.
`test/dictionary-database-suffix-classification.test.js` exercises the real
public lookup, sorted prefix enumeration, reversal, and result construction.
Only persistence and content loading are replaced with in-memory records;
this does not validate SQLite, OPFS, parsing, decompression or browser wiring.

Under Node 22.22.0 / existing Vitest 3.0.9:

- Baseline: **3 failed, 2 passed**. Expression, reading, and supplementary
  character cases returned suffix instead of exact.
- Fixed: **5 passed**. Exact and extended suffix classification, palindrome
  control, and prefix controls pass.
- Scoped ESLint of the regression file passed after correcting its relative
  URL style; the report was formatted with existing Prettier, and
  `git diff --check` passed.
- Command: `node node_modules/vitest/vitest.mjs run test/dictionary-database-suffix-classification.test.js --maxWorkers=1 --minWorkers=1`.

Dependencies and generated library files were reused from the existing local
checkout through local links; nothing was installed or rebuilt. An initial
Vitest startup attempt could not write its config cache through a node_modules
directory symlink. Per-package links with a worktree-local cache resolved it
without writing to the original checkout.

### Performance and invariants

The production diff changes one existing string equality comparison. It adds
no allocation, I/O, index load, query, worker message, decompression, or
additional scan. Lookup algorithm and memory bounds are unchanged. Streaming,
batching, cancellation, transaction/publication, dedup and compression paths
are untouched. This is correctness-only evidence; no latency, throughput or
zero-regression claim is made.

## Other confirmed main failures, already fixed on develop

These are evidence for parent integration, not additional fixes in this PR.

| Main location                                      | Failure                                                                                                                             | Existing develop evidence                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `dictionary-database.js:1907,1928`                 | Global visited IDs drop later expression/reading query associations. Translator consumes each request index at `translator.js:523`. | `24449000d7f03a6a22bd6aec544a2cbeabf4d3a2`; per-query ownership. Introduced in `02aa911900`.                   |
| `dictionary-database.js:1995–2001,2036`            | Duplicate and overlapping prefix/suffix queries retain only the first input association.                                            | `cdb73021cf9934fcbfd5fc3b7fd4febd96f25129`; accumulated input indices and per-query visited sets.              |
| `dictionary-database.js:1607–1628,2326–2341`       | Separator-based composite identities can collide; tag/media query splitting loses literal separators.                               | Develop frames dictionary/query identities and serializes dictionary sets; PR #149 merged into develop.        |
| `dictionary-database.js:2421–2423`                 | Cached SQL cursor remains live across awaited media reads; concurrent rebinding or eviction can invalidate it.                      | Develop snapshots each bounded request chunk and resets the cursor before yielding; PR #149.                   |
| `dictionary-importer.js:3402–3425,3469–3481`       | Non-array bank JSON is silently accepted as zero rows in auxiliary/serial term readers.                                             | `f09cf5bc1e4d2ef2a3b141d5b987061e430beffd`, `51f2b0b1d19cb16415eb941dffe27dbb109f8df8`; explicit array checks. |
| `dictionary-importer.js:2211–2237`                 | Index validation checks truthiness rather than schema types for title/revision.                                                     | `8e1f1939fc4c93df9f6dcc95a1ccd3e1b6b66329`; typed metadata validation.                                         |
| `dictionary-importer.js:701–710,735–743,2177–2178` | Index failure, already-imported return, or ZIP enumeration failure can bypass archive close.                                        | Develop establishes resource ownership before index/session setup and closes failed catalog readers.           |
| `term-record-opfs-store.js:1680`                   | Cold-load trimming changes literal persisted dictionary identity.                                                                   | Develop preserves literal whitespace/U+FEFF names.                                                             |
| `term-record-opfs-store.js:1319–1320`              | Target collision detection expects a Set where the dictionary index is an object.                                                   | Develop `_hasRecordsForDictionary` check.                                                                      |

The other findings above are source-inspection evidence, not newly executed
regressions in this task. No new concrete failure surviving comparison with
current develop was established.

## Credibly reviewed areas and remaining coverage

- Query and record reversal preserve UTF-16 surrogate pairs. Prefix ordering
  and `startsWith` use consistent UTF-16 lexicographic coordinates.
- Lazy reverse indexes are updated when records append. Exact expression /
  reading-pair and sequence request paths retain duplicate request indices.
- Yomitan compatibility review covered supported index formats 1 and 3,
  auxiliary bank array shape, literal dictionary identity, and fast/serial
  parser failure boundaries. Main's bundled schema also advertises format 2,
  while importer runtime explicitly rejects it; no compatibility expansion
  was attempted. Develop has additional explicit row/schema validation.
- Transaction/setup/finalization and archive ownership were read. Main's
  summary-before-session and failure finalization differ materially from
  develop's session/journal architecture. No crash/rollback/cancel simulation
  was run; do not infer safety from the suffix test.
- Content/write/cache review compared develop's queued-error retention,
  rollover stream ownership, stale snapshot/cache fencing, and persisted
  index checksums, dimensions, record-range and generation checks. No novel
  failure was demonstrated in that source review.
- No change to Unicode normalization policy was made. Distinct literal
  keys must remain distinct; the regression specifically verifies reversal
  of a supplementary code point rather than normalization behavior.

No full test suite, build, browser/E2E/soak, benchmark, native build, large
dictionary download, real user database, deployment, merge or production
change was performed. Coverage of those paths remains deferred by the task's
explicit limits.

## CI submission policy

Main's `.github/workflows/ci.yml:11–14` triggers on main pushes and every PR,
and includes full unit/build and Firefox/Chromium extension lanes. Separate
Playwright/Firefox workflows are manual. Use `[skip ci]` on the audit commit
to avoid automatic heavyweight push/PR work where GitHub supports that
directive; required checks can remain pending on the draft. Do not dispatch
manual suites or interpret skipped CI as validation.

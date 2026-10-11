# Native MDX staging collision review — 2026-10-10

## Source and ownership

Independent helper-only branch from remotely verified develop `e05294d263582b58bbe92c5e9f97349f6f60df31`; isolated worktree `/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-collision.kn17pQ/manabitan`. Parent/repository AGENTS and previously read optimize-manabitan architecture/MDX references apply. Parent sources/pins, lookup ownership, original clean dependency worktrees, old tasks, and native closeout workers are preserved. PR #482/#483/#484/#486/#487 are independent and not composed into this branch.

## Confirmed finding

The experimental helper preserves separate upload paths, but flattens selected logical names to basenames in a single job workspace. Distinct uploads such as first/fixture.mdd and second/fixture.mdd target the same staged path; sequential copyfile calls overwrite the first source. Case-only variants likewise collide on typical macOS case-insensitive filesystems. An explicitly supplied companion basename matching fixture.mdx can also overwrite the primary source. The helper previously accepted all three selections and invoked conversion instead of reporting ambiguity. The staging code is inherited from experimental helper addition `2de4150cb`, not recent browser optimizations; the browser client uses a Worker rather than this helper.

## Fix and cost

Preflight the primary and companion basenames before mkdir/copy. Reject duplicate casefolded names with a ValueError naming the conflicting logical file. Use a conservative portable policy even on case-sensitive filesystems; case-only names are now explicitly rejected. No silent deduplication, renaming, or last-writer choice is introduced.

This adds O(number of selected files plus filename characters) CPU and a set of normalized names. It adds no dictionary-byte buffers or file I/O, and preserves the existing copy/conversion pipeline for distinct names. This is correctness-only evidence, not measured throughput or a zero-regression claim. Casefolding is not a complete filesystem-name equivalence oracle; Unicode normalization and other platform aliases remain unverified.

## Actual checks

Python 3.14.6 and stdlib with existing stub-reader test infrastructure:

- Initial test setup used mocks without output creation and errored during archive stat. Corrected it to exercise real copyfile and a tiny archive-writing converter stub; these setup errors are not bug evidence.
- Before fix: all three filtered collision subcases failed because ValueError was not raised (same basename across folders, case-only names, companion matching MDX basename).
- After fix: all three passed, also proving zero copyfile/converter calls, no job workspace creation, and preserved original source bytes.
- Existing filtered staging/description-override regression passed.
- git diff --check passed.

No dependencies, full tests, builds, native/browser suites, benchmarks, real PyGlossary, large dictionaries, user databases, merge, deployment, or production action. Other PR evidence is historical and not rerun here. Commit requests [skip ci] because automatic workflows contain heavyweight jobs; this is a draft rather than release validation.

## Remaining gaps

Automatic selection still scans retained uploads by basename across jobs; this change reports ambiguous collisions rather than inventing a source-generation ownership policy. Explicit empty companion selection versus automatic discovery, upload retirement/reuse, chained/missing/cyclic redirects, real encoding/encryption, native/browser HTML/CSS parity, and installed storage integration remain unresolved. Failed-job cleanup is addressed independently in #487; framing in #486; selected numbering gaps in #484; upload integrity in #483; record-section extent in #482. A composed integration state still needs separate validation.

# Native MDX zero usable entries review — 2026-10-10

## Scope and source

Independent helper-converter branch from remotely verified develop `e05294d263582b58bbe92c5e9f97349f6f60df31`; isolated worktree `/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-empty.WcMidJ/manabitan`. Parent/repository AGENTS and previously read optimize-manabitan architecture/MDX references apply. Original dependency worktrees, old tasks, native closeout workers, parent source/pins, lookup and shared import/storage source remain untouched. Existing drafts #482/#483/#484/#486/#487/#488/#489 are independent and not composed here.

## Confirmed false success

The native converter skips blank headwords and redirect records but returned a ZIP even when every source record was skipped. Nonempty dangling redirects, a pure alias cycle, and a blank-headword source each produced success with index.json and no term bank. The host could register that empty conversion as a downloadable job. The browser converter already rejects nonempty inputs with no usable non-redirect entries. Native behavior dates to experimental helper addition `2de4150cb`; the production browser Worker does not invoke this helper.

## Fix and costs

Track whether the existing conversion pass encounters source entries, then reject if the existing sequence counter is zero. The guard distinguishes an empty source from a nonempty unusable source and keeps nonempty headwords with empty definitions valid. Mixed dictionaries keep their existing skip policy. No extra source pass, full-file materialization, payload buffers, schema changes, or row/asset behavior changes. Cost is one boolean assignment per source record and one constant-time final check. No measured throughput or zero-regression claim.

The check raises within the existing ZipFile context, which closes the archive. The caller must treat it as a failed output: a partial ZIP can remain on disk, as with other conversion exceptions. Independent #487 reclaims failed host workspaces; it is not incorporated here. Direct CLI failure output cleanup remains outside scope.

## Actually executed verification

Python 3.14.6 with stdlib and existing fake reader registry:

- Before: filtered usable tests failed in three rejection subcases (dangling redirect, pure cycle, blank headword); empty-source/mixed controls passed.
- After: all three filtered test methods passed. They contain those three rejection subcases, empty-source and mixed/empty-definition controls, and an actual host/converter call proving no native job is registered on rejection while uploaded source bytes survive.
- Existing filtered direct-redirect/assets/CSS/description regression passed.
- git diff --check passed.

No dependencies installed, full tests/builds, native/browser suites, benchmark, real PyGlossary, large dictionaries, user databases, merges or deployment. Existing PR results remain historical and were not rerun here. Commit requests [skip ci] to avoid automatic heavyweight validation; not release-ready.

## Remaining gaps

Mixed dangling/cyclic aliases still lack diagnostics; exact-name chains are addressed independently in #489, while KeyCaseSensitive/StripKey normalization remains absent from the native helper. Real parser encoding/encryption, native/browser HTML/CSS parity, upload retirement and repeated-job ownership, filesystem aliases, composed draft integration, and installed storage/media validation remain unverified. This guard does not claim general malformed-format coverage or transactional standalone CLI output.

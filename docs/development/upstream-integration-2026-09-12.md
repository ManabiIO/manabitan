# Yomitan integration: 2026-09-12

Integrated Yomitan `master` through `d34832d756e05dc00945e5b7d7ebc80963299a7a`
(48 commits since the shared upstream base `e03bae777aa161783ce00128cdc81de221fda56f`)
onto Manabitan `develop` at `8f50101b`.

The update includes Ukrainian and Celtic language support, historical Japanese kana,
English/Greek/German transform fixes, Anki frequency rank/occurrence separation,
batched duplicate searches and API keys, content-derived media filenames, local audio,
popup/fullscreen/blob scanning fixes, API metadata/card formats, dictionary recommendations,
and upstream dependency and action updates.

## Fork compatibility decisions

- Keep Manabitan's SQLite/OPFS import, deduplication, lookup, offscreen workers, and
  publication architecture. No dictionary format migration or storage reset is added.
  The upstream relaxed IndexedDB transaction change applies only to the retained
  generic IndexedDB helper, not the production dictionary database.
- Keep Manabitan's consent migration at version 75. Apply upstream migrations 75–77
  as Manabitan versions 76–78, including renumbered template patch files. Existing
  consent and custom templates survive upgrades; the resulting upgrade is idempotent.
- Preserve indexed translator result replacement while applying upstream's preference
  for the original spelling. Make the new frequency metadata cache retry failures
  and prevent invalidated reads from replacing the cache for a newer generation.
- Keep API-based Firefox detection, extension-unload handling, permission rollback,
  and dictionary readiness checks. Merge the new browser argument and metadata
  behavior into their callers and fork-specific test fixtures.
- Retain Manabitan's shared duplicate-query builder, including invalid-note handling
  and deck scope semantics, underneath upstream's union/candidate Anki search.
- Retain the fork's CI lanes, conditional dependency-review availability check, and
  deletion of the Playwright comment workflow. Apply compatible upstream action
  updates and the link checker's extension root fix.

Relevant upstream context:
[frequency semantics, PR 2373](https://github.com/yomidevs/yomitan/pull/2373) and
[batched duplicate search, PR 2479](https://github.com/yomidevs/yomitan/pull/2479).

## Validation

Validated with Node.js 22.22.0 and dependencies installed from the merged lockfile.

- ESLint, TypeScript main/dev/test/bench, CSS, HTML, JSON format/types, Markdown
  formatting, and dry-run builds for all targets passed.
- Full unit suite: 6,199 passed, 46 skipped; three additional focused Anki batching
  tests passed after that run. Dedicated options suite: 27 passed. JSON types:
  140 passed.
- Added regression coverage for migration/consent/custom-template compatibility,
  frequency cache retry and invalidation, and Anki scope/position/API-key behavior.
- Fresh Chromium extension E2E passed: import, content integrity, concurrent lookup,
  staged-update crash recovery, update, restart, multi-file import, hover stress,
  and deletion.
- Fresh Firefox extension E2E passed: recommended imports, content integrity,
  update/restart, multi-file import, and hover responsiveness.
- Browser runs used the canonical workspace mise task bodies in an isolated QA
  root pointing at this integration worktree, preserving the dirty original checkout.
- Edge and Android lanes were not run locally; this is a develop integration,
  not a release or promotion to main. No new performance claim is made.

Generated packages, browser reports, and dependency bundles are not committed.

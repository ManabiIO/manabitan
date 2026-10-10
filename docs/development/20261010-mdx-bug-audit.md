# MDX/MDict bug audit — 2026-10-10

## Source and isolation

- Repository: `ManabiIO/manabitan`; default main verified through GitHub.
- Fresh main: `81b149f44426dbfa8bca6af57f3bef9a3af02620`.
- Audited source: fresh develop `e05294d263582b58bbe92c5e9f97349f6f60df31`.
- Main lacks the recent MDX performance changes. The repository and parent AGENTS prescribe develop for active development, so the focused fix targets develop instead of reproducing already-merged develop fixes on main.
- Isolated worktree: `/Users/alex/Documents/Codex/2026-10-10/task-20/manabitan`; branch `fix/mdx-current-bug-audit-20261010`. Existing checkout remained clean on develop at `e6f85c1fb`; no source or active worker branch there was changed.
- Read repository and parent AGENTS, package metadata, worktree list, source history, and optimize-manabitan architecture/MDX references. No repository or parent `.agents` skill directory was present. Existing personal MDX skill references were used as leads, with current source verified independently.
- Only open PRs at the initial GitHub check were documentation PRs #380/#382. Searches of all MDX/MDict/MDD and record/truncation PRs found prior decompression, scanner, and block fixes, but no duplicate section-extent fix. No other task was contacted.

## Confirmed bug: truncated record section can report successful conversion

Severity: medium correctness/integrity failure. An MDX import with assets enabled can accept a truncated MDD and report no missing assets or lookup errors when the truncated resource is unused. Integrity depends on which records happen to be fetched.

Evidence at the audited source:

- `ext/js/dictionary/mdx/vendor/js-mdict/mdict-base.js:901-910` checks that record-table totals match the header, then sets the record-data start. It never verifies that the declared packed record section fits inside the supplied bytes.
- `ext/js/dictionary/mdx/mdx-converter.js:359-379` indexes MDD key metadata without reading every resource. `getBytes` at lines 445-455 reads only requested resources.
- Independent synthetic reproduction: one MDX term containing `healthy text`, plus one unreferenced 3-byte MDD resource, with the MDD cut short by one byte. `createMdxImportData` returned `term_bank_1.json` with `assetLookupErrorCount: 0` and `missingReferencedAssetCount: 0`.
- Parser-only reproduction: declared packed record size 13 bytes, available section 12 bytes; constructor accepted it before the fix.
- The missing section check is inherited from `1f478b7724`. Lazy MDD indexing was introduced in `fed2f97c9944d55af70c46efa49579e5f01e2a0f` (`Optimize dictionary imports and harden MDX support`), replacing eager `collectAssets`/resource fetch at its parent lines 439-445. This is verified source lineage; no historical performance or end-to-end behavior claim is made from it.

Expected behavior: reject a source whose declared record section exceeds its bytes during metadata parsing, including when the truncated resource is never requested. Continue to fetch and decompress valid MDD resources lazily.

## Minimal fix and performance implications

The vendored parser now performs one zero-length `FileScanner.readBuffer` at the declared record-section endpoint (`mdict-base.js:911-913`). The scanner's existing safe-integer and file-range checks enforce the complete extent. This adds O(1) arithmetic/bounds work and one empty typed-array result per dictionary, with zero record-payload bytes copied, zero additional decompression, and zero filesystem I/O. It does not change the record-table loop, lazy resource selection, cache budgets, compression checks, deduplication, batching, worker ownership, or cancellation.

Vendored provenance remains js-mdict as already recorded in the source and repository. The three added lines are a fork-local integrity boundary check; no upstream parser wholesale replacement or unrelated cleanup was performed.

This is correctness-only evidence, not a measured performance win or proof of zero runtime regression. The healthy control confirms zero `MDD.lookupRecordByKeyBlock` calls for the unused resource.

## Regression coverage and actual outcomes

All checks used existing Node 22.22.0, dependency packages, and existing generated `zip.js`/`parse5.js` through local ignored links. No dependency installation or library rebuild occurred. An initial Vitest attempt could not write its temporary config through a shared dependency-directory symlink; changing only the isolated worktree to local package links gave it a local writable temporary directory and the rerun passed.

New tiny cases live in `test/data/manabitan-mdx-regressions/record-section-cases.js`, using the existing independent `makeMdictFixture` writer. The Vitest wrapper is `test/mdict-record-section-bounds.test.js`.

- Before fix: 10 native cases, 9 failures and 1 healthy-control pass.
- After fix: 10 native cases passed. Eight constructor rejection cases cover MDX/MDD × v1.2/v2.0 × raw/zlib; one covers converter rejection of an unreferenced truncated MDD; one verifies healthy text, lazy unused-resource loading, and omitted unused output bytes.
- Existing `test/util/mdict-native-cases.js` truncated-final-block expectation updated to constructor rejection. Its single filtered native regression passed.
- Vitest: `node node_modules/vitest/vitest.mjs run test/mdict-record-section-bounds.test.js` passed (one wrapper executing all 10 native cases).
- `git diff --check` passed.

Full unit tests, type/lint suites, builds, benchmarks, browser/e2e/soak tests, native builds, real user databases, and large dictionaries were not run, per the task's validation limits. Browser publication/installed lookup and corrupt unreferenced block checksums remain unverified. This fix checks the record section's extent, not every unused resource checksum and not a strict no-trailing-data policy.

## Reviewed areas without additional claimed bugs

Read-only review covered safe numeric widths and v1/v2 table structure, UTF-16 key termination and encoding selection, scanner ownership/range checks, bounded raw/zlib/LZO decode, cross-record-block assembly, normal and oversized record caches, lazy exact/case-folded MDD lookup, embedded-data URL deduplication, and the MDX worker/client cancellation and settlement paths. Existing safeguards were identified; this audit did not establish another concrete failure in these areas. Coverage is inspection plus the specific tests above, not blanket validation of every format or lifecycle.

Shared importer/database/SQLite/OPFS/translator/generic-worker source remained untouched. Existing intentional Yomitan names were preserved.

## CI and delivery

Inspected current CI triggers. `ci.yml` and `mdict-native.yml` run on pull requests, with the latter including a Chromium build/browser job; Playwright and benchmark workflows are manual. The focused draft commit uses `[skip ci]` to request skipping automatic push/pull-request work rather than launching prohibited heavy validation. Skipped required checks may remain pending; this draft is not merge-ready. No workflow source was edited and no manual workflow was dispatched.

## Exact tracked ownership map at the audited tree

The following tracked `ext`/`dev` paths match the delegated basename/directory rule. This is ownership, not a claim that every file received a full audit. MDX-specific test/util files were also owned; only the two new regression files and one existing truncated-record expectation were changed.

- `dev/data/zstd-dicts/jmdict.zdict`
- `dev/native/mdx-import/mdx_to_yomitan.py`
- `dev/native/mdx-import/native_host.py`
- `dev/native/mdx-import/test_native_helper.py`
- `dev/perf/mdict-checksum-overhead-20260920.md`
- `dev/perf/mdict-checksum-overhead-abba-20260920.json`
- `dev/perf/mdict-record-cache-20260920.md`
- `dev/perf/mdict-record-cache-abba-20260920.json`
- `ext/js/comm/mdx.js`
- `ext/js/dictionary/mdict-import-sources.js`
- `ext/js/dictionary/mdx-worker-main.js`
- `ext/js/dictionary/mdx/browser-util.js`
- `ext/js/dictionary/mdx/mdx-converter.js`
- `ext/js/dictionary/mdx/vendor/js-mdict/latins.js`
- `ext/js/dictionary/mdx/vendor/js-mdict/lzo1x-wrapper.js`
- `ext/js/dictionary/mdx/vendor/js-mdict/lzo1x.js`
- `ext/js/dictionary/mdx/vendor/js-mdict/mdd.js`
- `ext/js/dictionary/mdx/vendor/js-mdict/mdict-base.js`
- `ext/js/dictionary/mdx/vendor/js-mdict/mdict.js`
- `ext/js/dictionary/mdx/vendor/js-mdict/mdx.js`
- `ext/js/dictionary/mdx/vendor/js-mdict/ripemd128.js`
- `ext/js/dictionary/mdx/vendor/js-mdict/scanner.js`
- `ext/js/dictionary/mdx/vendor/js-mdict/utils.js`
- `ext/js/dictionary/mdx/vendor/pako-inflate.js`
- `ext/js/dictionary/mdx/vendor/pako.js`
- `ext/js/pages/settings/mdict-import-feedback.js`
- `ext/mdict.html`

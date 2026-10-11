# Native MDX composition review — 2026-10-11

This checkpoint composes the independent experimental native-helper fixes below. Earlier per-fix review documents are retained unchanged as historical evidence; statements there that the fixes were not composed describe those earlier snapshots.

## Exact inputs

Base: `e05294d263582b58bbe92c5e9f97349f6f60df31` (`develop`).

- PR #483: `29c6c2113f5952ba62eb8d5e6ca07a748113bcdf` — fix(mdx): reject sparse native helper uploads
- PR #484: `b6f915e061dd0b4e93a08c226cb6bb46cc0c066a` — fix(mdx): preserve selected native MDD volumes
- PR #486: `eda468c8b88b05da7712bb9c9e3192cac4c2fc89` — fix(mdx): complete native response writes
- PR #487: `2524b4b12d76b6fd0237948eece2b45c896af678` — fix(mdx): reclaim failed native job workspaces
- PR #488: `a74e39e75351eae4ffc9dfff052bb121ac67b060` — fix(mdx): reject colliding native staging names
- PR #489: `9599ac1fd4225ca037b8c805f4adf1c07a053df9` — fix(mdx): preserve native chained redirect aliases
- PR #490: `3a57501be2eacd9e6e9d2dea29a251a03732ae8a` — fix(mdx): reject native conversions without usable entries
- PR #491: `cbcde26b165f57b1613ae21adee68c32d8928578` — fix(mdx): require completed uploads before native conversion
- PR #492: `0a59865fa02be02fa7316db2ca3aaa2f3fd12ea6` — fix(mdx): validate native archive download ranges
- PR #493: `da5e6f5e845020921d90aaa1267a4b77c55467fc` — fix(mdx): preserve native data URL decoding fidelity
- PR #494: `f4e89c523ee7307bae9527a013e404cc624bc396` — fix(mdx): honor native stylesheet encodings
- PR #495: `b46ae752eed98246c9b6098b2af77de268d270cf` — fix(mdx): preserve CSS literals during native URL rewrite
- PR #496: `8e77e0f10260a3a3534af268b20327a58ebfdc9c` — fix(mdx): reserve native source paths for embedded assets
- PR #497: `88190c2f066af5592d1b88cb5d5a44724abcdd01` — fix(mdx): preserve native definition references and nesting
- PR #498: `2e3042eb6ac9c5a8fd708561e764e4ad426fa89c` — Fix native MDX definition-local inline CSS selectors
- PR #499: `af111c945fed7b639f4cb2fc380f805a27f96136` — Fix native MDX legacy font sizes and inline CSS precedence

## Composition decisions

- Preserve every source commit as a merge parent and all fourteen historical review documents.
- Preserve explicit selected MDD staging inside failure cleanup, including noncontiguous companions; keep collision and upload-completion validation.
- Combine transitive redirect expressions with entry-local stylesheet scope triples.
- Keep embedded-resource reserved-path protection alongside scoped inline stylesheets.
- Retain all input regression methods and both intentional changes to existing test expectations.
- Add a cross-feature archive regression combining chained aliases, local stylesheet scoping, legacy font sizes and inline-style precedence. Remove a duplicate import introduced by test composition.

## Validation actually run

Python 3.12.14: `python3 -m unittest -v test_native_helper` from `dev/native/mdx-import` passed all 47 tests against the combined three Python files. `python3 -m py_compile *.py` also passed. The pre-composition 498/499 subset passed 14 tests; the complete input-test composition passed 46 tests before the new cross-feature regression was added.

The tests use the existing in-memory PyGlossary stub and temporary files. This establishes combined helper-level behavior only. It does not establish real PyGlossary compatibility, real MDX/MDD corpus fidelity, browser/native-host installation or pipe timing, browser rendering, extension runtime behavior, or performance. No native app build, browser suite, benchmark, deployment, or user database operation was run.

## Remaining qualification

This is the retained experimental Python native helper. The browser Worker import path is separate; these fixes do not qualify that path or resolve Reader hotfix shipping blockers. Keep this draft pending actual PyGlossary/corpus and host integration checks. Browser-only PRs #482 and #485 and main-only #481 are outside this composition.

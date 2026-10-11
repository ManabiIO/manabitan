# Native MDX inline CSS selector scopes

The retained experimental native Python helper exported ordinary selectors from
all definition-local style elements into one global `styles.css`. Two definitions
with conflicting `.shared` rules therefore had indistinguishable targets. The
browser converter already scopes inline selectors to their originating entry;
the active browser client uses its Worker, not this native helper.

## Change

Definitions containing nonempty inline stylesheets receive a stable
`mdict-yomitan-entry-{sequence}` root class. Direct aliases reuse their target's
glossary and sequence. Definitions without inline stylesheets retain the original
root class. Inline body/html/:root selectors migrate to the entry root, and every
ordinary selector gets a zero-specificity `:where(scope, scope *)` guard on its
matched element. Guarding the subject constrains sibling combinators too; merely
prefixing an ancestor would allow the subject to lie outside the entry. The guard
precedes double-colon and legacy pseudo-elements and ignores colons in quoted
attribute values and functional pseudo-class arguments.

The existing grouping-rule recursion propagates this scope through media,
supports, layer, container, and document rules. External MDD stylesheets remain
global. Font-face and keyframe blocks retain their existing behavior; this is
ordinary-selector scoping, not isolation of CSS names or arbitrary CSS grammar.
Existing selector migration limitations, including escape handling and native
CSS nesting, are not changed by this patch.

## Evidence

Baseline: `e05294d263582b58bbe92c5e9f97349f6f60df31` (develop).
Python: 3.14.6; standard library and the existing fake MDX/MDD registry only.
The final new tests were copied into a fresh directory with exact baseline
converter and host sources. They failed with 3 and 11 assertion failures,
respectively; both pass with the fixed source. No dependency installation occurred.

```sh
python3 -B dev/native/mdx-import/test_native_helper.py -k inline_stylesheets_are
python3 -B dev/native/mdx-import/test_native_helper.py -k inline_scope_guards
python3 -B dev/native/mdx-import/test_native_helper.py -k rewrites_inline_urls
python3 -B dev/native/mdx-import/test_native_helper.py -k migrate_stylesheet
python3 -B dev/native/mdx-import/test_native_helper.py -k writes_redirects_assets
```

All five distinct methods pass. The archive fixture checks two conflicting styled
definitions, a direct alias, an unstyled definition, nested media, root selectors,
and unchanged external asset bytes. The other new method checks six selector
forms, all five supported grouping rules, and unchanged font-face/keyframe blocks.
The existing archive fixture's expectations changed only for the new entry class
and inline guards; its external CSS and media assertions remain intact.
`git diff --check` passes.

Raw baseline exports and logs are preserved locally at
`/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-css-scope.YjQr7w/evidence/`.
The `final-baseline-*` logs use the final tests; `fixed-*` logs show fixed results.

## Costs and limits

Each scoped selector now requires an additional split/scan and a larger serialized
selector containing two scope references. Styled definitions also gain one root
class; inline bookkeeping stores that scope string. No timing or memory benchmark
was run and no performance or zero-regression claim is made.

Real PyGlossary parsing, rendered stylesheet behavior, extension imports, installed
storage compatibility, and composition with other draft fixes remain unverified.
No browser/native suites, broad builds, benchmarks, production actions, or security
policy changes were performed. This independent branch changes only native
converter source, focused tests, and this report; parent sources/gitlinks and the
three original task-20 worktrees remain unchanged.

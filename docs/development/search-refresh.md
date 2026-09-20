# Search refresh and draft input

Automatic dictionary/options refresh must rerun the displayed lookup, but must
not replace the user's unsent textbox value, selection, scroll position or focus.
An explicit search, history navigation or Clear action still owns those fields.

`Display.searchLast(false)` marks search-page content with a one-use
`preserveSearchInput` instruction. `_setContentTermsOrKanji()` removes it from the
nonpersistent history content before awaiting options/lookup, then carries its
value into `contentUpdateStart`. The search controller skips textbox replacement
and blur only for that refresh. The instruction is not serialized into the URL,
does not alter stored dictionaries, and cannot stick to a later history visit.
`searchLast(true)` is an explicit action and does not request preservation.

## Regression coverage

The Node fixture executes the actual `Display.searchLast`,
`Display._setContentTermsOrKanji`, content-start dispatcher and search-controller
handler. Only storage/options and leaf layout operations are controlled. It
covers terms/kanji, both refresh triggers, existing drafts (including empty and
trailing-space drafts), edits at both asynchronous boundaries, selection/focus,
explicit search/Clear, history revisits and popup/unloaded controls.

```sh
node --test test/util/search-refresh-cases.js
npx vitest run test/search-refresh-input.test.js test/search-display-controller.test.js test/display-lookup-refresh.test.js
```

## Correction to the earlier MDict review probe

The prior clear-page probe replaced `searchLast` with a stand-in that emitted a
clear event. The real method already returns for clear content. That probe did
not prove the reported clear-page production defect. The clear-page control here
passes on unchanged source. The reproduced defect instead requires visible
terms/kanji: automatic refresh overwrites a different draft with the last query.
The earlier intermittent browser failure is not conclusively attributed to this
path. Do not treat a passing rerun as causal evidence or weaken its assertions.

See [the MDict client follow-up](https://github.com/ManabiIO/manabitan/pull/81) for
historical context. This repair is independent of native MDict parser changes.

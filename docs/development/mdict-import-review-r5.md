# MDict import review R5

This is an incremental candidate over PR #81 at `781a647596d84d179e048c394b210a6c67d335a7`.
The retained CI source is `38def24c5aac334d04a4f96c0b80399ef76178a1`. It does not reapply
R1/R2/R3 parser patches, overwrite later parser work, or enable any performance flag.

## Source map

- `ext/js/dictionary/mdict-import-sources.js`: local grouping, normalized basename
  identity, exact numeric stems, duplicate rejection, and volume ordering.
- `ext/js/pages/settings/dictionary-import-controller.js`: URL listing discovery,
  validated download names, preserved download order, stale-run checks, and
  integration with regular dictionary storage. URL matching is same-directory.
- `ext/js/pages/settings/mdict-import-feedback.js`: bounded numeric conversion
  counters and literal-text note rendering. Notices do not modify import errors.
- `ext/js/dictionary/mdx/mdx-converter.js`: native conversion and missing-reference
  accounting; this patch does not change the binary parser or error policy.
- `ext/templates-modals.html`, `ext/mdict.html`, and `docs/mdict.md`: actual shipped
  import guidance and conversion notes. `ext/css/settings.css` keeps one import
  scroll region and wraps long dictionary filenames.
- `ext/js/display/display.js`, `search-display-controller.js`, and
  `types/ext/display.d.ts`: one-shot draft preservation during automatic refresh.

## Correction to the previous handoff

The R4 clear-page probe replaced `Display.searchLast` with a stub that always
emitted a clear event. Real `Display.searchLast` already returns in clear state.
That probe did not establish the reported clear-page causal chain and must not be
used as evidence of it. The earlier browser failure still lacks exact causal
attribution.

R5 tests execute actual `searchLast`, `_setContentTermsOrKanji`, content-event
emission, and the search-controller handler. Browser history routing and
options/lookup I/O are controlled. The real visible-results path does overwrite
an unsent draft and blur its input. Both options and database refreshes reproduce
this. Clear-page controls pass on the original code.

## Draft preservation invariant

Automatic search-page refresh calls `searchLast(false, true)`. The one-shot
`preserveSearchInput` content field is read and deleted before any lookup await;
it is passed only to that content-start event. It must not survive in history and
suppress subsequent explicit navigation. At render time the controller leaves
current text, selection and focus alone, rather than restoring an earlier
snapshot. Results still refresh. Unloaded states are checked before and after the
options wait. Ordinary search and clear events retain their existing behavior.

## Verification

`test/mdict-import-ui-regressions.test.js` runs four native Node suites:
`test/util/search-refresh-cases.js`, `mdict-import-source-cases.js`,
`mdict-import-feedback-cases.js`, and `mdict-import-integration-cases.js`.
Use `node --test --test-reporter=tap` with those files for isolated reproduction.
They include real controller methods and independent native MDX/MDD fixtures.
Parser and codec substitutes are not used. The controller-to-storage boundary
has doubles and does not certify OPFS publication.

Keep full repository unit/type/JS/HTML/build checks, actual extension imports,
Firefox-specific MDict behavior, browser restart and large-source qualification
as merge gates. Offline modal checks and source-artifact native tests are not
full extension acceptance. The new `mdict-import-feedback.spec.js` Playwright scenario is prepared but unrun.
It verifies numeric-name resource precedence via stored PNG bytes, separate alias
notes, and notice clearing on the next clean import.

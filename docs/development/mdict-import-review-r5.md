# MDict import review R5

This change is the MDict import/pairing/feedback remainder from the R5 review,
rebased onto current `develop` after PR #81 and the independent Search refresh
fix in PR #85. It does not reapply R1/R2/R3 parser patches, overwrite later parser
work, or enable any performance flag.

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
The Search refresh issue discovered during R5 was fixed and merged independently
as PR #85. This branch deliberately does not duplicate those display changes.

## Verification

`test/mdict-import-ui-regressions.test.js` runs three native Node suites:
`test/util/mdict-import-source-cases.js`, `mdict-import-feedback-cases.js`,
and `mdict-import-integration-cases.js`.
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

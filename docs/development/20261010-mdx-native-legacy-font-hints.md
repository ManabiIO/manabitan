# Native MDX legacy font hints

The retained experimental native helper copied `<font size="4">` directly into
structured content as `fontSize: "4"`, which is not a CSS length or size keyword.
Relative HTML sizes such as `+2` were likewise copied unchanged. Legacy color,
size, and face attributes also overwrote explicit author inline CSS. The browser
converter already maps these size hints to keywords and gives inline CSS priority;
the active browser client uses its Worker, not this native helper.

## Change

Translate the HTML legacy size hint to the seven CSS keywords from `x-small`
through `xxx-large`. Signed sizes are relative to the legacy default of three;
absolute and relative results clamp to one through seven. The parser accepts
leading ASCII HTML whitespace and the initial ASCII digit run, as the browser
helper does. Invalid hints are omitted. Integer conversion is bounded by the
significant digit count, so long digit strings cannot exceed Python's integer
conversion limit; values above seven already clamp to an endpoint.

Merge legacy color/size/face first and existing inline styles second, preserving
inline CSS priority while retaining unspecified legacy hints. Font elements still
map to spans and preserve their data tag and content. No other inline CSS grammar
or property handling is changed.

## Validation

Baseline: `e05294d263582b58bbe92c5e9f97349f6f60df31` (develop).
Python 3.14.6, standard library, and the existing fake MDX/MDD reader registry.
Three new tests fail on baseline with 30 assertion failures and pass with the fix:
24 size inputs, five precedence combinations with nested fonts, and an archive
fixture checking a direct alias and invalid legacy hint with valid inline CSS.
Sizes cover all seven keywords, relative signs, leading zeros, ASCII whitespace,
trailing text, clamping, 100-digit values, and invalid/Unicode-digit hints.

```sh
python3 -B dev/native/mdx-import/test_native_helper.py -k legacy_font
python3 -B dev/native/mdx-import/test_native_helper.py -k convert_definition_to_structured_content
python3 -B dev/native/mdx-import/test_native_helper.py -k writes_redirects_assets
```

All six distinct methods pass (three new and three existing). `git diff --check`
passes. No existing test expectation changed. Raw before/after logs are preserved
locally at
`/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-legacy-font.ajf93oqe/evidence/`.

## Costs and limits

Legacy size attributes now incur one regular-expression match and a scan/copy of
the digit run; arithmetic is bounded. Serialized sizes become keyword strings.
No timing or memory benchmark was run and no performance or zero-regression claim
is made. Real PyGlossary parsing, browser rendering, extension imports, installed
storage compatibility, and composition with other drafts remain unverified.

This independent branch changes native converter source, focused tests, and this
report only. No dependency installation, broad build/suite, browser/native suite,
benchmark, production action, security-policy change, or delegation occurred.
Parent sources and gitlinks, original worktrees, and the earlier drafts remain
untouched.

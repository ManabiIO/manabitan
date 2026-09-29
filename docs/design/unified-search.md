# Search-page and embedded search contract

## Scope

Extend the existing Japanese converter, translator, glossary renderer and local
worker. No replacement dictionary engine, grammar dictionary, hidden English-gloss
index, Anki service or external lookup API is introduced.

The extension's full search renderer remains intact. Search input debounces for
100 ms, suspends during IME composition, invalidates obsolete entry actions before
waiting, replaces browser history for live results and preserves the input/caret.
Explicit submission retains existing behavior. Pasted queries longer than 256
UTF-16 code units retain explicit submission instead of live enumeration.

`japaneseSearchQueries` keeps the literal input first. It adds width normalization
and the existing converter's Hepburn/Kunrei/Nihon-style spellings, with bounded
macron/circumflex alternatives. These are search alternatives, never authoritative
readings and never edits to the host's title/content query. Literal results win;
there is no homophone fusion or ranking by invented definitions. English gloss
search is not implemented. Remaining Latin syllables are not silently removed.

## Worker API

API v1 gains an additive `search` operation and the static manifest advertises
`searchVersion: 1`. Request: `{text, full: boolean}`. Response: original query,
matched spelling, enabled dictionary count, preview, and full lookup only when
explicitly requested. Existing `lookup` and scanner behavior is unchanged.

A compact response has at most two entries and two source-labelled preview senses
per entry, with 220-character text bounds and bounded traversal of text-bearing
structured content. It excludes HTML, media payloads, arbitrary properties and
unrelated headword senses. Identity includes dictionary and database ID. This
limits the payload transferred into the host and its DOM; it does NOT bound all
upstream translator/decompression allocations. Full mode uses the existing web
structured renderer and its documented complexity limits, not the extension's
entire audio/Anki/settings interface.

The Reader host must share one leased worker per origin/tab, respect cancellation
and close/retire it before opening a replacement. Origin-local web dictionaries
remain distinct from extension dictionaries. No silent import, authentication
forwarding, or permissive page-to-extension API is needed.

## Design evidence

- The Moe Way resources: https://learnjapanese.moe/resources/ — strong Yomitan
  recommendation; Takoboto appears among Android dictionaries. This is not a
  universal community ranking or evidence of a grammar-driven preference.
- Takoboto: https://takoboto.jp/ — Japanese/English, kana/kanji/romaji entry points.
- Jotoba tour: https://jotoba.de/tour — multiple lexical result types and useful
  inflection/segmentation affordances. A possible forgotten service, not confirmed.
- Jiten: https://jiten.moe/ — words, sentences and media in one search surface.
- W3C tabs: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/ — do not automatically
  activate slow async tabs on arrow focus. Reader uses pressed filter buttons.
- MDN IME: https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event

Native reference: Reader v3-hotfix `fca69a30047d48ca2d2a4271c841b084cb331ab0`
selects ManabiDictionaries `5495c5657c72da2914abed5b5e38f96c414bc11e`.
`JMDict+LookupResultsGenerator.swift` delays full lookups and preserves namespace,
entry ID, preferred surface, reading context and POS. `JapaneseRomaji.swift` is
explicitly presentation from a known reading, not an inverse lookup algorithm.
The web implementation takes those invariants as inspiration, not a Swift port.

## Qualification

Run `node --test test/search/search.test.mjs test/util/search-refresh-cases.js`.
Run main/web TypeScript, ESLint and existing extension search tests. The static
web acceptance now calls the real `search` RPC with the installed JMdict fixture,
checks compact payloads and then requests a full lookup. Unit or compilation
results alone do not establish browser/IME/manual visual acceptance.

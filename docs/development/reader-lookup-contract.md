# Document-provided exact lookup — preparation

Status: prepared source additions plus a hash-guarded frontend/scanner integration
recipe in the private handoff capsule. Generate/apply the combined patch using
that recipe; the additions alone do not register the bridge.

The generic `data-reader-lookup` JSON protocol contains a canonical term/reading,
original surface, original sentence and UTF-16 sentence offset. Optional lexical
namespace/sequence are provenance, NOT extension row IDs. No page-supplied
DictionaryEntry object is trusted. No SQL, file, general API or automatic Anki
mutation is exposed. The extension queries its own configured dictionaries and
uses its own existing popup and Anki UI. No proprietary plugin is loaded by the
extension. Sites without attributes continue through the normal scanner.

Only a trusted, unmodified activation is accepted. Text selection, links/forms,
long presses, drags, stale/detached anchors and disabled extension state are not
hijacked. Superseded work and option/dictionary updates invalidate late responses.
Original surface length is rebound for sentence/cloze templates without changing
canonical headwords or mutating cached dictionary results.

`deinflect: false` skips algorithmic deinflection, NOT dictionary redirects.
Matching headwords are now projected from mixed groups. Definitions are retained
only for those headwords and headwordIndices are remapped; pitch/frequency arrays
are filtered and reindexed too. Row IDs, sequences, ordering and definition data
are preserved; cached input objects are not mutated. Group-level transform chains
are cleared for a subset rather than attributed to discarded forms. An exact-match
miss displays an empty popup. Dictionary-sequence/homograph/sense identity still
requires separate qualification; canonical-term lookup alone does not guarantee
native-selected-entry parity.

## Before enabling/merging

Run existing JS/TS/unit suites and actual packaged Chromium/Firefox extension
checks. Verify capture-order arbitration with TextScanner, touch scroll, queued
hover results, popup retarget/dismiss, author ruby and vertical text. Test actual
Anki templates/audio/media/duplicate checks using inflected surfaces longer than
the lemma. Nothing in this patch writes to Anki automatically.

A later optional batched lexicon-evidence interface requires a separate reviewed
permission/origin/budget/generation contract. It is not part of this preparation.

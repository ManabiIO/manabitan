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
permission/origin/budget/generation contract. It is not implemented here. Do not
expose arbitrary extension API calls as a shortcut. File/worker separation alone
is not a GPL license exception; review the intended distribution and interaction
before connecting a proprietary analysis engine through new detailed interfaces.

Run prepared pure protocol tests:
`node --test dev/tests/reader-lookup-contract.mjs`

## Shared document sentence context

The receiver also accepts a compact word attribute with contextID (and no inline
sentence) together with the nearest data-reader-lookup-context owner. That owner's
JSON is `{protocol:1,id,text}`. IDs must agree, bounded text and UTF-16 offsets must
validate, and actual rendered base text must match. This avoids copying a full
sentence into every word. Mutation/removal of the context invalidates in-flight
presentation just like mutation/removal of the anchor. This remains untrusted
page data and grants no general extension or Anki-write capability.

A real pointer must not have moved beyond the gesture threshold and back before
clicking. Links, form controls, role=button, editing, modifiers, selection and
long presses remain ordinary browser interactions. No proprietary dependency
or skeletal dictionary install is added to this extension. Website setup owns
website analysis resources; extension settings installation is a separate action.


R3 context validation verifies the actual base-text offset of the specific anchor,
including repeated identical words. Matching sentence text and substring alone is
insufficient. Changing/reordering a context invalidates the pending presentation.
Pure projection and DOM receiver tests are not full packaged-extension or Anki tests.
Run all prepared protocol suites with `node --test dev/tests/reader-*.mjs` as well
as the existing project checks before enabling the source integration recipe.

For the extension's general development and installation context, see the [project README](../../README.md).

# Reader Lookup Contract

The reader bridge is installed in the `develop` frontend and shares the existing
scanner, dictionary lookup, popup and Anki UI. Pages without reader attributes
continue through the normal scanner. The bridge does not install dictionaries or
load a page's analysis engine.

## Document Protocol

An element's `data-reader-lookup` attribute contains JSON:

```json
{
  "protocol": 1,
  "term": "食べる",
  "reading": "たべる",
  "surface": "食べた",
  "sentence": "私は食べた。",
  "offset": 2
}
```

`term` and `reading` are canonical lexical forms; `surface` is the original
rendered text. `offset` is a nonnegative safe integer measured in **UTF-16 code
units** within `sentence`. The substring at that offset must equal `surface`.
The integration converts this offset to code points for display/mining consumers;
page producers must still send UTF-16 offsets, including for supplementary Unicode
characters.

Alternatively, omit `sentence` and supply `contextID`. The nearest ancestor with
`data-reader-lookup-context` must contain
`{ "protocol": 1, "id": "sentence-1", "text": "私は食べた。" }`, with a matching ID.
Inline `sentence` and `contextID` cannot be combined. The receiver verifies the
owner's actual base text and the specific anchor's position, not just a matching
substring. Repeated words must identify the correct occurrence. Ruby annotations
(`rt`, `rp`, `rtc`), scripts and styles do not contribute base text.

Lengths are bounded in UTF-16 units: term/reading/context ID 512, surface 2048,
sentence 16384, lookup JSON 32768, context JSON 65536. Optional `namespace` is
`jmdict` or `jmnedict`; optional `entryID` is a positive decimal string of at most
20 digits. These fields are provenance, not extension database row IDs or a
guarantee of dictionary-sequence, homograph or sense identity.

## Activation And Results

Only trusted, unmodified primary activation is accepted. Pointer gestures must
stay within 8 CSS pixels and complete within 700 ms; moving away and returning
still counts as a drag. Trusted keyboard/assistive clicks may activate without a
pointer gesture. Synthetic clicks, modifiers, active text selection, prevented
clicks, links, form controls, button roles and editable content are left alone.
Disabled extension state and invalid/detached anchors cannot activate lookup.

Accepted activation supersedes scanner work. Mutation of lookup/context data or
base text, detachment, a newer activation, page hiding and frontend
option/dictionary invalidation make pending work stale. Asynchronous popup
publication must remain guarded by that current-request check. Reparenting a
context-based anchor invalidates work if it leaves the original context owner or
changes its validated base-text position. Moving a connected inline-sentence
anchor without changing its lookup data or surface does not itself invalidate it.

The extension queries its own configured dictionaries with exact term matching,
the requested reading and algorithmic deinflection disabled. Dictionary redirects
are not disabled by `deinflect: false`. Exact headwords are projected out of mixed
groups: only attached definitions, frequencies and pronunciations remain, with
relationship indices remapped. Original ordering, definition IDs and sequences
are preserved. Subset projection clears group transform chains rather than
attributing unrelated transformations to the selected form.

Mining uses the original surface span and sentence, not the lemma's length.
Cached dictionary entries are not mutated. An exact miss produces an empty popup.
Page data remains untrusted: no supplied dictionary entry, arbitrary extension
API, SQL, filesystem access or automatic Anki write is exposed. A batched
lexicon-evidence API would require a separate reviewed permission, origin, budget
and generation contract, plus distribution/license review where applicable.

## Verification

The routinely discovered Vitest suites preserve protocol/projection assertions
and cover receiver activation, invalid contexts, mutations, detachment, ruby,
modifiers, selection and drag rejection:

```sh
npx vitest run test/reader-lookup-contract.test.js test/reader-context-contract.test.js test/reader-projection-contract.test.js --maxWorkers=1 --no-file-parallelism
npx eslint test/reader-lookup-contract.test.js test/reader-context-contract.test.js test/reader-projection-contract.test.js
```

DOM handler fixtures cannot qualify real trusted input or packaged-extension
behavior. Chromium/Firefox checks still need to verify scanner capture-order
arbitration, touch scrolling, queued hover results, asynchronous popup
retarget/dismiss, author ruby and vertical text. Actual Anki checks need templates,
cloze offsets (including supplementary Unicode), inflected spans longer than the
lemma, audio/media and duplicate detection. No unit result substitutes for those
browser/Anki checks.

See the [project README](../../README.md) for development and installation.

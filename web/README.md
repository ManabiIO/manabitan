# ManabiTan web runtime (API version 1)

This static web target uses the existing ManabiTan DictionaryDatabase, DictionaryImporter, Translator, TextScanner and StructuredContentGenerator. It does not imitate browser-extension globals or require an application server. The extension target remains separate.

Build with Node 24.21.0: `npm ci`, `npm run build:libs`, then `node web/build.mjs`. Serve `builds/manabitan-web/` as immutable, versioned static files. `manifest.json` records the exact source revision and every asset's byte size/SHA-256. It also describes the separately distributed verified Jitendex archive; the archive is not a runtime asset and must not be shell-precached.

Load `web/client.js` only on actual dictionary use. Create ManabiTanWebClient, await open(), then call lookup(), importDictionary(Blob), status(), setEnabled(), deleteDictionary() or close(). Request options support AbortSignal and import progress. `web/scanner.js` adapts the real scanner to a specified document container; its includeSelector restricts Reader-controlled gestures. `web/render.js` renders returned definitions with the shared structured renderer and a host-local media adapter. Load the supplied structured-content CSS. The media disposer must run when replacing/closing results.

## Storage ownership and recovery

A dedicated Worker holds an exclusive Web Lock for the complete dictionary database lifetime, including SQLite's SAH pool and record/content sidecars. A second independent owner gets `storage_busy`; it must show this to the user and retry after the first owner closes. There is no in-memory persistence fallback. The lock is not released merely because a database method returns: worker teardown releases all remaining handles. Abrupt termination leaves the existing import journal for the next owner to recover.

Import completion reports the actual committed result, bounded warnings and cancellation-after-commit separately. Cancelling before publication rolls back. Cancelling after successful publication is not reported as though the persisted dictionary had disappeared. Operation watchdogs terminate a stalled worker and require reopening/recovery, rather than retaining an invisible permanent owner.

Preferences are origin-local and independent of an installed extension. Deleting/declining the default dictionary is retained. No code automatically reinstalls it. Storage usage is an origin estimate, not an invented per-dictionary byte figure; persistent storage is not guaranteed against eviction.

## Security and scope

Only a narrow, versioned worker protocol is exposed. External dictionary ZIPs stay local. Renderer limits bound displayed content complexity; links are constrained and imported media is image-only, never a top-level same-origin SVG document. The current web UI supports term lookup/deinflection, structured definitions and frequency information; full extension Anki/audio/kanji-stroke-order interfaces are not included. The unused stroke-order font is omitted from the web target. Fonts needed by shared dictionary media conversion remain optional runtime assets.

The compressed archive cap and renderer caps are not a complete bound on every dictionary decoder's expanded allocation. Do not advertise arbitrary-ZIP denial-of-service resistance or universal device compatibility on this basis. No COOP/COEP requirement is added. Target-browser qualification and the Reader application's cold-offline cache integration are separate acceptance gates.

## Executed acceptance

A clean Chromium profile without any extension passed 21 runtime scenarios in run 35418283851: full official JMdict English (527,095 rows), real scanner/renderer/deinflection, frequency metadata, second-tab exclusion/handoff, cancellation, abrupt-tab-death recovery, structured media, verified full Jitendex (435,448 rows), browser restart, explicit dictionary preferences, deletion and an already-open worker's offline lookup. This is a runtime host test, not a claim that the Reader UI or a cooperating extension bridge has already passed its own integration suite.

The Jitendex test exposed a genuine shared queued-OPFS append-offset defect, fixed independently in PR #62. Its deterministic stateful storage regression fails before the correction and passes after it.

## Licensing

This runtime is GPL-3.0-or-later. Preserve its license and provide corresponding source for the exact distributed revision. The original Reader's BSD notices remain applicable to its original files; embedding this runtime does not turn it into BSD code. Jitendex and each custom/preset dictionary retain their separate licenses and attribution requirements. `presets.ts` reuses the existing ManabiTan recommendation catalog; recommendation is not blanket redistribution approval for every listed dictionary.

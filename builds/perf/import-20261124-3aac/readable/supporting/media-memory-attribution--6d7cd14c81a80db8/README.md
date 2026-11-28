# PR #875: bounded memory-attribution audit

## Finding

The valid first pair in Jitendex memory replication 2 fails the prospective private-memory bound: **+11.5409% private and +9.2188% PSS**. This bounded source and retained-process audit found **no concrete new retention owner or arena allocation explaining the increase**. The failure remains a reason to hold the candidate. It must not be dismissed as noise or assigned to garbage collection without evidence.

Evidence is from `import-memory-3aac-media-jitendex-rep2-45471351138-1`, source A `bbccabd520972cc351a65d9f545bd5369b6e9747` / tree `f81fc2c29b58f1c2329de6b8fa6b2a91015b6b07`, source B `fb71a03f4611bcfa71e135693bebd1fe778153bf` / tree `0939bd1eec85dc0b3f15ef002a8f0f5111c80103`. Local reviewed commit `33594ec55b34b8c88fe2c50e30c1302d50ee5847` has exactly B's tree. The second pair remains unqualified because A2 exceeds the frozen 250 ms covered-scan-gap limit; it is not substituted into the first-pair analysis.

## Process-level localization

| Respective qualified maximum | A1 | B1 | B − A |
|---|---:|---:|---:|
| Whole tree private | 1,050,076 KiB | 1,171,264 KiB | +121,188 KiB |
| Extension renderer private | 879,308 KiB | 991,180 KiB | +111,872 KiB |
| Browser private | 94,768 KiB | 104,384 KiB | +9,616 KiB |
| Remaining processes private | 76,000 KiB | 75,700 KiB | −300 KiB |
| Whole tree PSS | 1,281,213 KiB | 1,399,326 KiB | +118,113 KiB |
| Maximum scan relative to import start | 718.5–821.6 ms | 1,105.8–1,185.5 ms | Different times |

Both maxima occur during term parsing. The extension renderer accounts for 109.25 MiB of the total 118.35 MiB private increase. Both observations have the same nine process roles. Process-level sampling cannot attribute memory among worker threads, JS isolates, importer data, compression buffers, or engine internals sharing the extension process.

B1's extension-private footprint is 843,864 KiB in the preceding qualified scan, 991,180 KiB at its maximum, and 848,772 KiB in the following scan. That establishes a sampled transient increase, not its cause. These scans are non-atomic and do not measure exact peaks. Instrumented timings are not used to claim a speed improvement.

## Retained counters

| Counter | A1 | B1 |
|---|---:|---:|
| Maximum reported parser WASM heap | 76,087,296 bytes | 76,087,296 bytes |
| Total owned content | 389,707,807 bytes | 389,707,807 bytes |
| Parser worker count | 3 | 3 |
| Pipeline groups per worker | 3 | 3 |
| Peak queued owned content | 142,152,189 bytes | 144,963,118 bytes |

Peak queued content differs by 2,810,929 bytes. That does not account for the much larger process-memory difference. All other non-time parser and import/finalization counters in this pair agree. Aggregate maxima do not identify which individual buffers were live during the maximum process scan.

## Source lifetime and allocation review

- `ext/js/dictionary/term-bank-wasm-parser-worker.js`, `parse`: the new `preloadedSource` argument is consumed synchronously. Baseline already passes the same capability in parser options and reads it after the parse await for profile construction. The candidate does not create a later explicit lifetime endpoint.
- `ext/js/dictionary/term-bank-wasm-parser.js`, `copyWasmBackedColumnChunk` and `tryProjectNativeGlossaryImagePath`: the synchronous map callback does not escape. The capability is not returned, added to row/chunk fields, cached, or posted. Returned metadata and transfer collection remain unchanged.
- `decodeJsonStringToken` / `decodeParserText`: successful projection copies only the path token when the source is shared and returns its string plus a one-element array. The previous collector decoded and parsed the complete glossary. General fallback keeps that previous behavior. BigInt/scalar temporaries are new, but no retained source owner is attached to them.
- `getWasm`: one optional export reference is added to the same already-cached WASM instance; no second module, memory or decoder is created.
- `ext/js/dictionary/wasm/term-bank-parser.c`, `project_single_glossary_image_path` / `project_glossary_image_value`: the traversal uses automatic locals and bounded nesting; it calls no arena allocator, reset, or memory-growth function and adds no output column. The compiled binary is larger, but these process samples cannot isolate compiled-code or engine allocations.
- Existing ordered-result handling still clears `result.chunk` and `result.consume` before the sink await, releases its borrowed-content callback, and decrements queued owned bytes in `finally`. The candidate does not alter the bounded pipeline or this cleanup.

The media-lane agent independently reviewed the escaping-owner question and reached the same source-level conclusion. Its full production projection oracle covers VNDB, not Jitendex, so this audit does not claim exhaustive Jitendex projection activation counts.

## Reproduction and limits

`reconcile.py` reads the retained A1/B1 JSON, reselects qualified fully contained maxima, records exact per-process contributions and every qualified sample, and reconciles parser counters. `receipt.json` includes hashes of the original raw reports. It performs no browser launch, import, memory collection, or source mutation.

No speculative fix or additional memory acquisition is justified by this audit. The valid failure remains retained and the source candidate stays unchanged.

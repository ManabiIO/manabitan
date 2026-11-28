# Canonical checksum activation: static provenance review

Reviewed frozen runtime [`570ccc3968046269cb00d2053e49d3c32367031a`](https://github.com/ManabiIO/manabitan/commit/570ccc3968046269cb00d2053e49d3c32367031a) using existing source only. This review does not modify code, add instrumentation, or rerun a measurement.

## Finding and limit

No systematic inactive wiring, mandatory arena replacement after a successful native scan, or ordinary final-sidecar buffer rejection was found. This is a static source conclusion, **not a measured checksum invocation or acceptance census**. Existing canonical-scan metrics establish scanner/module use; they do not establish checksum activation.

## Current owner and call path

The import session callback in [dictionary-database.js](https://github.com/ManabiIO/manabitan/blob/570ccc3968046269cb00d2053e49d3c32367031a/ext/js/dictionary/dictionary-database.js#L1402) reads the current metadata arena on every checksum call. It does not retain the arena present at session startup. The setup cache clear precedes source-group scanning.

The normal dedup path reserves metadata capacity before calling the native scanner (database lines 9020 and 9178). [term-content-canonical-scan.js](https://github.com/ManabiIO/manabitan/blob/570ccc3968046269cb00d2053e49d3c32367031a/ext/js/dictionary/term-content-canonical-scan.js#L397) reads the current arena and registers the optional checksum helper in the memory-keyed WeakMap at lines 406–427. [term-content-metadata-arena.js](https://github.com/ManabiIO/manabitan/blob/570ccc3968046269cb00d2053e49d3c32367031a/ext/js/dictionary/term-content-metadata-arena.js#L70) creates a fixed, private WebAssembly.Memory; capacity growth replaces the owner rather than growing that memory.

Successful native staging supplies non-null staged metadata, so the later fallback reservation at database line 8494 is skipped. Publication at line 9906 updates existing slots and counts. The ordinary bulk-add cache clear at line 5084 runs only when no import transaction is open. These paths do not mandate a replacement between successful scanning and record append.

Database line 10135 calls the record-store append. The store's uniform/mixed-content paths at lines 2297, 2326 and 2369 reach encoding at line 2563, append at line 2576, and [_createLookupIndexChunk](https://github.com/ManabiIO/manabitan/blob/570ccc3968046269cb00d2053e49d3c32367031a/ext/js/dictionary/term-record-opfs-store.js#L6258). Its callback follows the original authoritative-field validation and container split. The scanner's current-memory lookup is at lines 292–295.

## Final byte ownership

The checksum inputs are the final lookup base, derived index and record fields, not the shared glossary transport:

- [term-bank-wasm-parser.js](https://github.com/ManabiIO/manabitan/blob/570ccc3968046269cb00d2053e49d3c32367031a/ext/js/dictionary/term-bank-wasm-parser.js#L1643) copies native lookup output into a new Uint8Array. Segmented preparation at line 1725 uses the same owned encoder.
- The worker uses the stable-copy path at [term-bank-wasm-parser-worker.js, line 162](https://github.com/ManabiIO/manabitan/blob/570ccc3968046269cb00d2053e49d3c32367031a/ext/js/dictionary/term-bank-wasm-parser-worker.js#L162); parser line 4194 additionally copies any prepared payload still sharing parser strings memory. Ordinary ArrayBuffers are transferred by the worker.
- Content-dictionary run splits at store line 2369 omit the whole prepared map and re-encode. The [JavaScript lookup encoder](https://github.com/ManabiIO/manabitan/blob/570ccc3968046269cb00d2053e49d3c32367031a/ext/js/dictionary/term-lookup-index.js#L349) allocates fresh Uint8Array output at lines 349 and 472. Its split helper at line 530 returns plain subviews of that private payload.
- All record formats allocate new Uint8Array output at store lines 5857, 5928 or 5941.

Thus these ordinary sizable final spans meet the private-view guard by construction, including when glossary content uses shared transport.

## Remaining intentional fallback cases

Combined spans below 3072 bytes, old or missing optional exports, modified guarded intrinsics, a native failure, and a current arena replaced across asynchronous/interleaved work without a subsequent scan can use the original JavaScript path. A successful scan alone cannot quantify any of those cases. This review supplies no per-corpus activation percentages and does not replace the frozen whole-import timing, semantic or memory gates.

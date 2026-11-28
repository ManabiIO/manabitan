# Independent source review: format4 on current parent

Reviewed parent `f28c2801fcfd9416f220b46b9cbafeee901c1cb2` to candidate `8c3ca42aa848b82a392ec96ea6b6f5ab21b80199` in `/home/agent/manabitan-reference-current-4d9f`. This is a source review, not a new test or corpus acquisition. No code was edited on the candidate branch.

No source-level blocker was found in the reviewed runtime, transactional floor, or independent full-file oracle. Current-parent build/test/browser evidence remains a separate requirement; the existing dcfc corpus data must retain its original source identity.

## Writer and ownership

Format4 remains default off and restricted to active import sessions. It uses the existing factory-origin, ordinary-object, exact typed-array-prototype and private-buffer proof; it does not admit arbitrary external, shared, accessor-backed or proxy inputs. The existing row-length pass validates each row's original reference key before the new output conversion. The new function rechecks the complete reference table, including unused entries, for narrow lengths and offsets representable relative to this exact split's base. Unrepresentable unused entries cause ordinary-format fallback instead of being silently dropped.

The writer preserves the full reference table and every original row ID. It does not create another deduplication/remapping policy. It chooses format4 only for a strict byte reduction relative to the already-selected compact representation. Signed-zero/fractional scores retain the earlier Float64 fallback; null-offset sentinels retain their existing values. Output arrays are freshly owned and no input writes occur.

The row-ID conversion uses the builtin byte-offset getter and an explicit Uint32 view, avoiding a caller-owned constructor/species callback. There is no await between the private value checks and emission. The preexisting split-origin inheritance proof remains in place; child rows retain the original complete-table identity only when their real byte range matches the parent slice. No value proof is retained across awaited appends.

## Readers and current-parent interaction

Format4 is recognized in the cold/full, scoped and authoritative repair paths. The shared field parser checks magic/version/counts, total byte length, nonzero bounded reference and score table dimensions, odd-reference padding, all reference keys and all score keys. Unsafe offset-base addition checks visit the full reference offset table. Content offset/length lookup uses the row's reference ordinal while scores continue to use the original row ordinal.

The new minimum index size uses four bytes per row because valid format4 can be smaller than the old eight-byte compact bound. Existing upper bounds, chunk/file dimensions and checksums remain in force. The f28 indexed score-key validation loop is retained verbatim in the shared parser; it has not regressed to the earlier iterator loop.

The lazy content metadata ID representation from f28 has no direct dependency on persisted record-field format4: neither this encoder nor its readers access that metadata ID column. The f28 compact-block witness/reference handling remains untouched.

## Publication, rollback and older readers

The writer increments `referenceTableFieldChunkCount` only after adding a format4 chunk to the authoritative pending lookup index. Errors in queued writes/finalization prevent successful store completion before publication. The counter and experiment state reset on prepare, import start and rollback; the toggle resets on end-import cleanup.

`finishBulkImport` reads the actual emitted count after both content and record stores finish. It raises `PRAGMA user_version` to12 inside the same existing SQLite publication transaction as the generation summary and durable publication receipt. It never lowers a previously installed floor; a later packed-media-only import does not lower12 to11. Failure before commit uses the existing rollback path, and failure after commit retains the existing durable publication/recovery distinction. A default-off or all-fallback import does not raise the floor merely because the experiment was requested.

The maximum supported schema increases to12. Existing parent readers reject that newer schema through their early installed-version gate; the added tests and planned browser verifier must establish that this refusal occurs without changing files or deleting published dictionaries. The source review does not substitute for that file-preservation acquisition.

## Independent actual-file oracle

Reviewed `corpus/actual-fields.mjs` and `corpus/expanded-file-oracle.mjs` used by the frozen acquisition helper. The first decodes actual format4 bytes with DataView, compares the entire reference table to the producer's table, and compares every stored row ID without remapping. It independently expands actual4 to the previous2 layout, preserving score order and score-key bytes.

The second rereads every final index chunk using bounded exact ranges, validates descriptor/index generation linkage and header dimensions, binds payload/field/envelope hashes to captured encoder receipts, checks all row keys, and hashes the expanded full-file stream. Only the already-linked generation bytes are normalized. The unchanged checksum function is reused to reconstruct envelope checksums, while independent SHA-256 and exact comparison with the disabled writer establish the complete file-content oracle. Every observed encoded chunk must occur exactly once in the final files, and total actual index savings must equal the sum of emitted field savings.

These helpers support exact logical/persisted-data equivalence for their documented term-sink boundary. They do not independently establish restart activation, schema-floor publication, browser performance, media persistence or downgrade behavior; those remain separately reported gates.

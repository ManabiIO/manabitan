# Cache/gather ownership assessment

Read-only review of baseline `d829f5b6e6a75ee8859d38d537d224ec33c4930e`. No code or timing changes were made for this assessment.

## Result

There is no existing independently owned raw JavaScript slab that can be adopted by the recent-content cache on the measured shared-parser route. Reusing a Zstd gather allocation requires a new cross-worker ownership protocol; feeding the private cache allocation into the existing compression path changes admission or adds cloning. Neither is a small way to remove the duplicate shared copy while retaining all current policy and lifetime guarantees.

## Actual ordering

1. `DictionaryDatabase._bulkAddArtifactTermsChunkWithContentDedup` resolves/stages dedup metadata, then `_tryBeginPersistArtifactTermContent` starts the shared-span content append.
2. `TermContentBlockStore._beginAppendSharedSpans` starts compression asynchronously and independently reserves stable content-reference offsets through `beginAppendBatchWithDerivedPrefix`. Reservation does not wait for compressed output.
3. `TermContentCompressionPool.beginCompressWrappedSpans` snapshots offsets/lengths into one metadata SAB and dispatches each compression block. Each worker calls `prepareSpanCompression`, copies selected source runs into its own retained Zstd WASM allocation, emits `source-consumed`, compresses, then transfers only compressed output.
4. After storage reservation, the importer registers in-flight sources, publishes validated metadata, and calls `_cacheRecentPublishedTermContentSources`, which creates the exact-size private owned cache buffer. Worker gathering may be in progress or complete at this point; ordering is not guaranteed either way.
5. The importer drains content and record persistence. Borrowed parser bytes are released only after the existing content-completion cleanup; failures drain outstanding readers and roll back staged metadata/cache mappings.

## Why existing copies cannot be adopted

- The Zstd gather destination is `module.HEAPU8` at `buffers.source`, retained per compression context and overwritten by the next job. It belongs to a different worker realm and is not an independent transferable block. Retaining its view would violate the cache lifetime. Returning its bytes would require a fresh private copy before reuse, plus transfer/reassembly or a different cache layout.
- Worker gather compacts selected source spans into compression-block order. The cache retains the original minimum-to-maximum span range, including intervening gaps. The two layouts are not generally interchangeable. Per-block cache entries would also change eviction granularity unless additional coordination preserved the current batch behavior.
- The already transferred output is compressed; it cannot serve the raw-byte exact matcher without decompression or a changed cache representation. Reference slabs contain storage references, not the raw content.
- The fallback packer does allocate independent raw JavaScript slabs, but it is a failure/non-shared path. The measured JMdict route uses borrowed shared content in all 12 groups, so this is not an existing copy available on the target path.
- Cache-first reuse also fails locally: the cache buffer is an ordinary private ArrayBuffer, while `tryBeginAppendSpans` and `beginCompressWrappedSpans` explicitly require shared input. Transferring the cache buffer would detach the retained cache; cloning it would reintroduce copying. A new shared cache allocation or worker-writable destination would change the ownership protocol and require new publication barriers.
- Moving allocation/eviction before publication would require preserving the current admission decision over validated published entries and proving that old entries remain available for the same lifetime. Delaying compression until cache creation would also alter existing overlap. A memory-neutral claim cannot be made from the current code alone.

Relevant source locations: `dictionary-database.js` around 7949, 8032, 8133, and 9423; `term-content-block-store.js` around 739 and 780; `zstd-term-content.js` around 179; `zstd-term-content-compression-worker.js` around 58; `dev/lib/zstd-wasm.js` around 297 and 399.

## Stronger remaining bounded lead

The independent trace review attributes approximately 27–28 ms of importer self samples in both baseline traces to the native `postMessage` call in `TermContentCompressionPool._startDispatch`. These are sampled intervals, not message counts or a guaranteed saving. `beginCompressWrappedSpans` currently creates and posts one request per compression block even though source bytes, metadata SAB, dictionary, and options are shared for the entire batch.

A bounded experiment could send one ordered list of block descriptors to each existing worker while retaining per-block IDs, timeouts, source-consumed acknowledgments, results, and failure draining. That would reduce outbound `postMessage` calls from the number of blocks to at most the existing four workers per batch, without changing block boundaries, compression settings, worker count, or stored bytes. Each worker must preserve its current block order, and synchronous posting failures must settle every affected ID. Returning results and source-consumed acknowledgments per block initially keeps the ownership protocol unchanged.

This still needs new worker-protocol correctness tests and browser qualification. The profile gives a concrete target, but the theoretical reduction is limited to that dispatch work and may be partly hidden by other activity. No source change is proposed for cache/gather reuse in this iteration.

### Exact untimed dispatch count

`compression-dispatch-shape.mjs` restores all 12 frozen native snapshots, verifies each complete pre/post memory hash, and applies the unchanged production block planner to its pending lengths. The database overrides the block store's standalone default with a 1 MiB block target. There are 102 blocks with 99,878,881 pending content bytes; counts by group are `[9, 9, 9, 9, 9, 9, 7, 8, 8, 8, 8, 9]`. The existing modulo-four assignment yields 48 nonempty worker envelopes. This is a validated planner reconstruction, not a browser message-count instrument.

The current options snapshot has 13 Boolean properties, only one of which (`experimentalGenericSpanCompression`) is consumed by compression. Its JSON representation is 516 bytes versus 43 bytes for that flag alone: 52,632 versus 4,386 bytes across 102 calls. These are object payload sizes, not structured-clone wire measurements. Removing approximately 48 KiB and 1,224 property occurrences is a small cleanup; there is no evidence that it explains a substantial part of the sampled 27–28 ms. The transport-coalescing experiment therefore preserves the existing option snapshot unchanged.

The exact result is retained in `compression-dispatch-shape.json`, driver SHA-256 `3513a3dca98bf660aa525d9dfc847c6f4bc9c6383b941e87d67d70e6c3ded989`, using snapshot manifest SHA-256 `0b39ef7fd7347ef3deb122d895d81f16ce93fd9da135e0a16937ea946504b989`.

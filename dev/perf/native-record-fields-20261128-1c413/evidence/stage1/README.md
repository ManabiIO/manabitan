# Native compact record-field feasibility, stage 1

Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.

This is an isolated untimed experiment. It does not edit a product file, add a runtime await, publish a branch, or claim a speedup. One complete current JMdict import captures the actual stock record encoder calls. The original encoder supplies every consumed output. The full retained compression/reference/finalized-file oracle remains mandatory.

The capture observes the real private synchronous reference predicate through one diagnostic-only appended named export. A Node loader hook verifies the original file hash and adds only that export in memory; the original function bodies and on-disk product source stay byte-identical. The exact original and appended source hashes are recorded. This avoids guessing that an object has the private factory-origin witness. The hook is removed once the actual module is imported.

Each call records its actual group/order, row count, content base, complete raw input columns, output bytes, private-guard result, intrinsic element kinds, backing-buffer kinds, and hashes. Binary captures use deterministic gzip containers with a JSON header followed by all named raw spans. Calls are retained even if later validation fails. No source-group-to-sink split is inferred.

The standalone native prototype has separate bounded memory. Its common path requires the existing private predicate plus genuine intrinsic Int32/Uint32/Float64 brands, private fixed ArrayBuffers, ordinary data properties, current bounds, and no metadata shadows. It copies the four input columns, interns arbitrary int32 scores in first-occurrence order, writes the existing compact format, and copies output into independent owned storage. Unsupported inputs and malformed native returns fall back to the untouched stock encoder without changing caller data.

The native function checks memory ranges/alignment/disjointness, dimensions, indices, offset/base/delta validity, compact length eligibility, score cardinality, and the original compact-versus-legacy size rule. The helper does not emit floating-score or legacy formats. Those cases retain the original implementation. Scratch, input/output copy bytes, memory growth/maximum capacity, hash-table initialization and score dictionary sizes are reported per complete call. No kernel-only timing is acquired.

The complete-call parity replay reconstructs private chunks through the actual current factory and compares all helper bytes against the captured stock outputs and fresh untouched stock calls. Focused cases cover arbitrary int32 scores, deliberate hash collisions, first-occurrence order, null offsets, large bases, length/cardinality/size boundaries, malformed indices, changed/shared/resizable/accessor/proxy/forged-kind inputs, native errors, and output lifetime after memory reuse/growth.

Pinned Clang/LLD 21.1.8 build commands, exact C/WASM, capture and wrapper source bindings, attempts/failures, complete call receipts, and aggregate copy/scratch counts remain here. Any later hosted timing must include guards, all copies, table clearing, memory growth, and module/instance startup in its complete-observation boundary; this stage provides only source, work and correctness evidence.

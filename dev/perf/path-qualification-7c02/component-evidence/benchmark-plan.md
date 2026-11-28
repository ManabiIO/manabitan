# Native image-path batching: prospective component protocol

Status: preparation only. No fixture acquisition or timing has started. Parent review and a free execution lane are required before either stage.

## Frozen source and scope

The production baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The root-owned candidate parser SHA-256 is `69f6f44bb25b1ade2e77ad51a5c830ac359ec3d44f364a3c0ed6131728f54518`; its worker entry changes only the internal fresh-result copy call. This experiment does not modify either implementation, the parser WASM, dictionary grouping, or runtime defaults.

The first performance boundary is only native glossary image-path projection. Full key/content/record columns will not be captured. This screen cannot establish enclosing result-copy, browser import, media-storage, or memory gains. Passing may justify those later measurements; it does not qualify a PR.

The existing integrated media-projection oracle supplies the source-lifetime model: project from the worker's live inflated source before another native parse. Its old manual group reconstruction will not be reused. Acquisition instead runs the unchanged current `TermBankSourcePipeline` and parallel parser with the same options as the recent complete dense VNDB census. It records the actual dispatched groups and counts. In particular, media-row/projection calls are measured; they are not assumed equal to the 146,570 unique media files.

## Bounded complete-fixture acquisition

Use the locked VNDB ZIP, verifying its whole-file size/SHA-256 and unchanged fixture lock. Use the production `readDenseZipFileMap`, `RawZipPayloadReader`, current compressed-run planning, and actual parser workers. The baseline source tree, source-bound parser WASM, original worker adapter, experiment scripts, and candidate source are identified by SHA-256 before and after acquisition.

The only observer is a test-only worker source copy with one synchronous hook immediately after the unchanged `copyWasmBackedColumnChunk` call. The hook receives the raw chunk, still-live preloaded source, request metadata, and already-copied result. Every other worker statement and import remains unchanged. The adapter changes transport and selects that explicitly recorded observer module; it does not alter parse options or work distribution. A separate parser copy appends a private-helper export without changing any function body.

For every actual worker group, the hook writes one compressed fixture and releases its temporary data before returning. The fixture contains:

- Actual bank filenames, parser group identity, source row count, and original source pointer/length.
- Every media row's original column index, glossary string, raw glossary bytes, original source-relative offset, native versus foreign backing classification, and content-byte length.
- Exact baseline private-helper output and the unchanged enclosing copy's projected path output.
- Counts of total media rows, eligible source-backed rows, native single-token projections, accepted image paths, empty/foreign/general fallbacks, and unescaped ASCII tokens.
- Complete compressed/uncompressed fixture digests and raw glossary/output digests.

Only path-related data is persisted. No full inflated bank, content slab, lookup arena, or record-column snapshot is retained. Raw bytes are encoded inside per-group compressed JSON for simple inspectable replay. A native heap-end/buffer-size check and raw-span digests verify the extra projection calls did not mutate source bytes or allocate native memory. The raw-byte total and compressed storage requirement are measured; the approximately 84 MB expectation is not an acceptance criterion.

The capture must include all 6,648,310 source rows and every actual planner group. Group bank lists are checked against the separately completed frozen dense census, independent of callback completion order. Per-group projected paths from the extra helper must match the unchanged already-copied paths wherever native projection succeeds. Every failure remains in the acquisition receipt; a killed or incomplete capture supplies no aggregate fixture.

## Replay shape and provenance

Replay one captured group at a time with the checked parser WASM. Restore source-backed glossary spans at their original absolute offsets in that module's memory, retaining original source bounds and alignment. Unused source gaps are zeroed outside measurements; foreign/private views retain their non-native classification. No other source bytes are accessed by these helpers. The source pointer, memory buffer, and raw spans remain stable across all arms for that group.

Only a nonzero/zero content-length sentinel is needed by the isolated candidate; no term-content parsing is included. Original glossary strings and raw bytes remain exact. Baseline and candidate fixtures are identical. A baseline adapter maps the existing private per-row helper over media rows with the same nonempty-content condition as the production copy path. The candidate calls the new batch helper. Empty groups normalize to the same null result outside the measured semantic comparison; their count remains reported.

Arms A and C are byte-identical frozen baseline parser modules loaded at distinct module URLs. Arm B is the exact root-owned candidate parser. The observer appends only private-helper exports. All dependencies and WASM remain common and source-bound. Every arm must reproduce the complete captured per-group output before and after timing. Full in-memory raw-span hashes, fixture file hashes, source/probe hashes, plan, and driver are checked after the cohort.

## Proposed fixed component schedule

Use the six orders once: `ABC`, `CBA`, `BCA`, `ACB`, `CAB`, `BAC`. Every arm appears in every position twice.

For each source group, load/decompress/reconstruct outside timing. Each arm receives two excluded warmup observations of eight complete projection calls. Then acquire all six three-arm blocks for that group, eight complete calls per observation. All groups use the same fixed schedule. Aggregate each block/arm by summing its recorded group intervals, yielding 18 complete-corpus component observations; retain every individual group interval too.

Process CPU and monotonic wall enclose only the repeated projection call and minimal result consumption. Optional thread CPU is diagnostic. Explicit GC occurs before observations, outside timing. Incidental GC and compilation inside an interval remain included. The measured wall sum is a sum of component call intervals, not elapsed whole-corpus replay time. No native parsing, ZIP I/O, source reconstruction, decompression, output hashing, or source verification lies inside the timing boundary.

No retries, replacement observations, truncation, additional pairs, threshold tuning, or outcome-dependent changes are allowed for this frozen source. Failures and all partial observations remain recorded.

## Proposed gate, subject to pre-acquisition review

- Complete locked fixture acquisition and complete six-block component cohort, with exact pre/post outputs and unchanged identities.
- Median paired component CPU and wall improvement at least 15% versus both A and C, with at least 5/6 faster blocks against each.
- Median paired CPU saving at least 15 ms per complete VNDB path-projection corpus versus each unchanged arm.
- Identical C/A median CPU and wall drift within 5%. Controls remain separate and are never subtracted.

Passing only supports considering a complete-media browser oracle and independent hosted comparison. Failing any prospective control or source gate ends this unchanged candidate component screen. No whole-import percentage or process-peak-memory claim is inferred from this component.

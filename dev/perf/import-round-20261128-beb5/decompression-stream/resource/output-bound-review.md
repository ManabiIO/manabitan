# DecompressionStream output-bound review

Date: 2026-11-28. Research review only; no product edits or timing runs.

## Finding

For the Chromium source associated with the pinned Chrome 153.0.8010.12, the frozen helper's 1,024-byte compressed slices give a defensible **per-transform decoded payload bound of 1,065,282 bytes** (about 1.016 MiB). That is at most 17 newly allocated output arrays, each no larger than 65,536 bytes. Native decoder state and scratch are additional fixed storage. Serial TransformStream writes with readable high-water mark zero prevent a second ordinary transform from running while the preceding output batch is queued.

This establishes a small, fixed bound on the current implementation's actively retained decoded batch. It does **not** establish the existing native inflater's hard declared-output-capacity property, a portable DecompressionStream allocation guarantee, or a constant bound on actual resident backing-store memory. The 65,536-byte input variant has a much larger conservative batch bound: 67,641,666 bytes, about 64.51 MiB.

The immediate conclusion is therefore narrower than either “unbounded on this Chromium implementation” or “equivalent to native output bounds.” A fixed live-payload allowance is supportable for this pinned implementation. A production claim that preserves the current hard capacity contract is still blocked by allocation occurring before the consumer's size check, and by the absence of a portable bound on opaque decoder buffering. Garbage-collection residency also needs separate measurement; the proof below is not an RSS bound.

## Exact sources and frozen helper

The helper reviewed is `decompression-stream-browser/dev/perf/decompression-stream-chromium/gzip-inflater.mjs`, SHA-256 `76f2b7dd8c41da7296592552aa8736c90743c4e3c0e1d688515ba30ebbbf6c79`.

Direct Gitiles retrieval resolved tag `153.0.8010.12` to Chromium commit `971a7443b0c9b0a9b2860529b33331b76077ec62`, tree `f3b8516f22967cf75d95541bf324421ed6c0be4a`. This is the source tag associated with the benchmark's browser version, not a reproducible-build proof of the downloaded binary. Exact downloaded source bytes, Git blob IDs, URLs, and SHA-256 hashes are recorded in `ds-bounds-sources/chrome153/manifest.json` beside this report.

The relevant primary source files are:

- [Blink inflater](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/modules/compression/inflate_transformer.cc) and [header](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/modules/compression/inflate_transformer.h).
- [Native TransformStream](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/core/streams/transform_stream.cc).
- [Zlib build selection](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/zlib/BUILD.gn), [selected x64 optimized inflater](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/zlib/contrib/optimizations/inflate.c), [fast loop](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/zlib/contrib/optimizations/inffast_chunk.c), [saved state](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/zlib/inflate.h), and [code-table construction](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/zlib/inftrees.c).
- [Typed-array allocation](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/core/typed_arrays/dom_typed_array.h).
- [RFC 1951](https://www.rfc-editor.org/rfc/rfc1951), [Compression Standard](https://compression.spec.whatwg.org/), and [Streams Standard](https://streams.spec.whatwg.org/).

The x64 build selects `contrib/optimizations/inflate.c`; this review checked that implementation as well as the generic source. The optimized window allocation is 32,768 plus 16 padding bytes. Its saved state uses a fixed table of 1,924 four-byte entries, fixed code-length work arrays, scalar state, and pointers; an x64 ABI layout mirror totals 9,080 bytes. This layout calculation is explanatory, not a measured browser allocation receipt.

## Per-transform payload derivation

Let S be the compressed bytes supplied to one ordinary native transform, and let H be already buffered input bits. A DEFLATE match emits at most 258 bytes. It requires at least one literal/length code bit and at least one distance code bit. The single-distance-code exception still uses one bit. Literals, stored blocks, block headers, and code-table construction have lower output expansion per input bit. An absent Huffman alphabet does not provide zero-bit matches: zlib constructs invalid one-bit entries and rejects their use.

Saved decoder state contains one length/offset/mode, not a queue of decoded matches. A partially decoded match can be completed using later input, so allow an additional 258 output bytes independently of the new-bit accounting. A stored block can have a larger remaining length, but copying it requires the corresponding new source bytes. Further encoded matches can reside only in the saved bit accumulator; allowing H = 64 is deliberately conservative. The optimized fast loop returns unused whole input bytes and masks its saved carry.

Thus a conservative bound is:

`E(S) = 258 * floor((8*S + 64) / 2) + 258`.

| Input supplied | Conservative new decoded payload | Maximum 64 KiB output arrays |
| --- | ---: | ---: |
| 0 bytes | 8,514 bytes | 1 |
| 8-byte trailer | 16,770 bytes | 1 |
| 1,024 bytes | 1,065,282 bytes | 17 |
| 65,536 bytes | 67,641,666 bytes | 1,033 |

These are ceilings, not observed expansion or allocations. The zero-input row is a conservative general carry-state bound; the actual helper's completed ordinary-transform boundary permits the tighter conclusion below.

Blink supplies a reusable 65,536-byte native output buffer to `inflate`, copies each produced span into a fresh DOMUint8Array, and holds all those arrays in a local vector. It finishes processing the input slice before enqueuing any array. Every non-final iteration fills the 64 KiB buffer; there is at most one partial final array. This is why a reader-side size check cannot interrupt a malicious slice's current output batch.

## Pending matches, flush, and backpressure

The saved mode can represent one partially decoded match or literal. It cannot store an arbitrary list of matches that suddenly expand on a later input. The separate carry-bit allowance covers encoded tokens not yet interpreted.

The optimized inflater drains everything possible given its input and available output. Blink repeats the call whenever the output buffer fills, including another call after input exhaustion if necessary. Therefore a normally completed ordinary transform leaves either end-of-stream or a state requiring more compressed input. Any output-blocked match has already been drained. A later empty `Z_FINISH` does not unlock additional output; it changes completion/error handling. For a truncated source it reports failure. This is stronger than the conservative `E(0)` allowance above.

This flush point matters because TransformStream close/flush does not wait on readable backpressure in the same way as an ordinary write. Without the checked zlib/Blink draining behavior, relying on write backpressure alone would miss possible flush output.

The native TransformStream factory passes writable high-water mark 1 and readable high-water mark 0. Its sink-write algorithm waits on the backpressure-change promise before invoking the next transform. The readable-side pull releases that wait. In this helper, a single sequential reader copies each returned chunk before requesting the next one. The input `pipeTo` machinery can hold the next compressed slice, but it cannot run that slice's transform while prior output remains queued. Input-source high-water mark zero alone would not establish this property.

The resulting active payload consists of one decoded batch, the 64 KiB native scratch buffer, the 32 KiB padded window, fixed decoder state, and conservatively one previously delivered 64 KiB array retained by the consumer/async machinery. This is approximately 1.18 MiB of payload and explicit decoder storage for the 1 KiB variant, before stream/object/vector bookkeeping, allocation rounding, or garbage-collector effects. It is per active inflater; production has multiple workers, although banks within a worker are sequential.

## Limits of the result

1. **Declared output is still weaker than the native path.** The helper checks `value.byteLength` against the remaining declaration before copying into the parser heap. The current transform has already allocated its complete output batch. A tiny dishonest declaration can therefore trigger roughly 1 MiB of decoded allocation before rejection. Native `term-bank-inflate.c` passes the exact declared capacity into libdeflate, which writes directly into that bounded destination and also checks produced and consumed lengths.

2. **Logical liveness is not resident memory.** DOM output arrays and their wrappers are managed objects with fresh backing stores. Releasing a reader reference does not force collection or return pages to the operating system. Already consumed chunks can remain resident until collection. Over a bank, the cumulative decoded backing-store allocation can scale with the bank's decoded size even though the actively retained output queue is bounded. No fixed RSS/PSS or external-memory ceiling follows from this proof.

3. **The API standard leaves internal context and buffering opaque.** It permits a decoder to withhold output across calls and emit it later. A compliant implementation that buffers until member completion would defeat a per-input-slice allocation bound while preserving the specified bytes and errors. Input slicing and stream high-water marks cannot constrain that hidden buffering. The current Chromium source addresses this implementation specifically; browser support as a whole needs separate evidence or a different mechanism.

4. **Failure and cancellation do not undo an allocated batch.** Overflow is rejected before parser-heap copying, and the helper cancels the reader, but already allocated native/DOM buffers are outside that check. Sequential banks and exclusive parser ownership avoid concurrent mutation; they do not change the browser allocation model.

The existing MDict pako output-limit document describes a separate importer and cannot silently redefine the term-bank native contract. If a revised resource contract permits a small fixed live-payload allowance per worker, the pinned Chromium analysis supports evaluating the 1 KiB variant under that explicit allowance. It does not justify labeling the current research helper production-ready or treating ordinary-fixture peak-memory observations as a proof for all malformed inputs and supported engines.

## Review status

The independent history/review agent checked the expansion arithmetic and agreed with the carry-match allowance and the distinction between source high-water mark and TransformStream sink backpressure. No performance measurements or product changes were made for this review. The whole-glossary prefix candidate remains frozen; the corrected hosted cohort is separate from the three preserved pre-timing package-gate failures.

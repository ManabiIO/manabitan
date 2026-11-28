# Conditional production hook for browser inflation

Analysis only. No product source is changed. The frozen component campaign must
pass conformance and show useful copy-inclusive improvement, and the separate
output-bound review must establish an acceptable resource contract before this
outline becomes an implementation task. Fixed 1 KiB slicing alone does not close
that question.

## Smallest initial scope and hook

The first eligible path would be the existing parser worker's private source
packet, containing more than one bank, all using ZIP compression method 8, and
ineligible for the existing deferred glossary CRC policy. This covers the pinned
JMdict corpus measured by the component. Single-bank joining, stored/mixed banks,
deferred CRC, standalone/public callers and unsupported browser implementations
continue through the existing native operation. No worker count, group planner,
lead window, compression policy, budget or user experiment knob changes.

Place the internal hook in `inflateCompressedTermBankSourcesWasm`, after its
current source validation, byte totals, `getWasm()` and deferred-CRC decision, but
before it allocates/copies compressed input. The worker supplies a private,
code-created inflation callback closing over its exclusively owned source packet;
ordinary callers supply no callback. This adds one internal optional callback
parameter and the private worker helper, rather than broadening admission based
on arbitrary `Array.isArray` or `instanceof` values. A separate internal wrapper
can retain the original exported signature if preferred during implementation;
the existing native allocation/body/error mapper remains the authoritative path.

The callback receives the **exact cached wrapped WASM object** from `getWasm()`.
It must not instantiate another copy as the component prototype does.
`parseCore` explicitly rejects `preloadedSource.wasm !== wasm` around line917 of
`term-bank-wasm-parser.js`, then retains that same heap while allocating parser
metadata/content. Returning a direct `instance.exports` object also fails this
identity requirement even if its memory happens to be equivalent.

## Authority and asynchronous source lifetime

Authority comes from the private worker producer and transport protocol, not the
shape of a generic source object:

1. `runParallelParserJob` builds explicit primitive metadata records. It copies
   shared, partial or duplicate input backings into ordinary owned ArrayBuffers,
   then transfers the source buffers to the selected worker.
2. Worker `parse()` accepts ArrayBuffers from its structured-cloned message and
   creates fresh Uint8Array views and fresh plain metadata records before calling
   inflation. No dictionary-controlled getters/functions survive that boundary.
3. The DS helper closes over these private views and primitive metadata snapshots;
   it does not reread externally supplied object properties after an await.
   The initial route should require fixed ordinary ArrayBuffers. Resizable/shared
   or otherwise unsupported inputs use the original native operation.
4. The parent loop awaits each complete worker job, then any borrowed-content
   release, before sending another job to that worker. The worker transaction
   therefore owns the arena throughout decode, parse, result construction and
   the existing borrowed-result lease. A decoder-only active flag is insufficient
   as the lifetime argument by itself.

Keep the original generic API's getter/read/mutation behavior on its native path.
Do not silently grant fast-path authority to an arbitrary caller that happens to
provide a plain-looking array. The private callback is selected by trusted worker
code from its actual message packet; no source metadata or experiment field can
request it. Tests should exercise the worker transport, including overlapping or
cancelled jobs, rather than substitute a synchronous parser capture with different
options (the earlier VNDB Float64 capture correction demonstrates why).

The cached parser memory is shared: its module uses atomics/shared-memory flags.
Chromium's DecompressionStream input conversion disallows SharedArrayBuffer.
Therefore feed the original transferred **private** compressed views, as in the
component. Do not first snapshot compressed input into the native heap and then
assume those SAB subviews can be fed to DS without another private copy. If an
implementation requires such a copy, it belongs in the measured boundary and its
resource accounting.

## Native allocation and return contract

For an eligible, validated group with total decoded size U and N banks:

- Reset the existing parser heap exactly once for the attempt.
- Allocate `8 * N` bytes for the ordinary bank-span table and `U + 2` bytes for
  the source output, using the existing aligned checked allocator.
- Do not reserve the native compressed-input arena or its five metadata arrays
  on the successful gzip path. CRC/size values are already private primitives
  used to build each small gzip footer. The initial method8-only scope needs no
  extra native CRC scratch or signatures array.
- Create all native allocations before caching typed views. Write complete banks
  contiguously; record each exact original offset/length. No array joining,
  whitespace compaction, decoded concatenation or second source copy occurs.
- Return the same cached `wasm` object, output pointer/length, source count and
  bank spans, with `crcSignaturesPtr=0` and `crcStatsPtr=0`. All source CRC checks
  have already finished; the parser must not schedule another CRC scan.

The new output address can differ from the native layout because compressed input
no longer precedes it. Existing parser code consumes explicit pointers and bank
spans; it must not depend on that obsolete relative layout. Verify this through
complete actual-worker output identity, not only the component's decoded bytes.

## Per-bank ordering and failure path

For each bank, in original order: create the fixed header/footer; feed bounded
private compressed slices; copy each decoded chunk only after the remaining-size
check; require successful stream completion (including gzip CRC/ISIZE and strict
single-member/trailing-input validation); require exact decoded length; then
check the original JSON-array wrapper using only the four JSON whitespace bytes.
Only after all banks succeed may parsing or publication begin.

On any DS construction/decode/CRC/size/wrapper/attempt-allocation failure, stop the
reader loop, cancel/release its stream resources, discard all provisional native
pointers and run the **unchanged original native operation over the entire group**.
It resets the same arena, copies original private inputs and produces the original
result or original error. Do not merely rename a TypeError, resume at the failing
bank, or compare final length/CRC to excuse a strict-stream failure.

Full native replay preserves same-bank ordering (native inflate result, decoded
size, trailing consumption, CRC, wrapper), cross-bank ordering (an earlier CRC
failure must precede a later malformed stream), and the current distinction
between `DictionarySourceIntegrityError`, parser-admission `Error`, metadata
`TypeError` and `TermBankWasmResourceError`. A browser-only false rejection can
then fall back successfully without converting a valid archive into a hard error.
A DS false acceptance is different and cannot be repaired by this failure path;
strict capability and conformance gates are mandatory.

Original compressed views must remain alive and unmodified until the attempt
either succeeds or replay finishes. No decoder callback may write to native
memory after failure cleanup starts. DS never receives a pointer to native
output; all writes happen in the one awaited reader loop, so stopping that loop
before resetting the heap is the relevant ownership boundary.

## Capability, cancellation and accounting

Use the same captured native constructor for a worker's probe and later calls.
A small self-contained probe should verify valid output, wrong CRC/ISIZE,
trailing data and the hidden-second-member adversary. It must not use/reset the
parser heap. It can run alongside existing native initialization, with readiness
awaiting a settled supported/unsupported result. Unsupported or rejecting probes
select native inflation; they are not archive-integrity errors. The production
cost of this probe is additional work absent from the component's separately
isolated conformance browser and must be included in later whole-import results.

Keep the existing 25 ms cancellation checks and worker termination path; no extra
worker, background decoder job or outstanding write survives pool termination.
Reopen/warm-pool lifetime tests must ensure readiness/probe state belongs to the
right worker generation. The component's 64 KiB or 1 KiB choice is not a tunable
production setting; choose a resource-proven design only after evidence exists.

The current `inflateMs` begins after native allocation/input copy. A production
comparison must retain a common enclosing timing boundary for both paths when
interpreting this phase. Count failed DS work plus native replay; do not report
only the successful fallback's inner C time. Separate diagnostic activation and
fallback counts can verify the real worker path without contaminating a frozen
ordinary A/B cohort. File-to-UI time remains the qualification outcome.

For the current ordinary JMdict diagnostic, the 459.3 ms aggregate
`parserSourceInflateMs` already includes immediate CRC and wrapper checking in
`inflate_and_join_term_banks`. Its separate `parserSourceCrcMs` is zero because no
group enters deferred CRC. A CRC function's sampled time within that native call
is an attribution of the same work, not an additional amount to add to 459.3 ms.
The frozen component's enclosing inflate/CRC/copy clock avoids this overlap.

## Required evidence before a PR

- Chromium conformance and the frozen component controls must pass and leave
  enough gain to pay for capability checking and the stricter output-bound design.
- The output-bound review must address current-transform payload, queued/live
  buffers, actual allocator/GC residency and dishonest declared lengths. A
  current-Chromium per-transform bound is not a portable CompressionStream API
  hard memory guarantee and does not by itself equal native declared capacity.
- Source-bound tests must compare complete worker outputs, integrity/admission
  errors and failure ordering, source preservation, unsupported capability,
  cancellation, warm-pool reuse and borrow-release behavior.
- Complete-browser fresh and warm imports must retain exact outputs, all media,
  storage and unchanged memory-coverage/growth gates. The component's serial work
  saving is not an estimate of parallel file-to-UI improvement.

At present this is a conditional implementation map, not an approved product
replacement. The frozen research cohort remains unchanged.

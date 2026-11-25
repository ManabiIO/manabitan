# Independent native publication preflight review

Reviewed local commit `d61a49f03b48b2b9cb1cd704aa0c2a994820f46d`, corresponding to hosted study commit `b2e816c4714f42f87cbb6a1ebc7fe1a2d2fd863b` and tree `be5b6a8d9c24915516d6edd8167a071e0449d793`, against baseline `7d1643e6147a10cb2165e9744cf0e63b59e46632`.

Result: no blocking correctness finding in the reviewed change. This is a read-only source review, not a performance or memory qualification. The study commits remain explicit even if the publishing branch subsequently receives formatting-only changes.

## Call-site admission and equivalence

The existing publication fast path still requires ordinary, nonshared typed columns, an exact staged reservation count, nonnegative first index, sufficient source-column lengths, and destination bounds. Its preexisting input/output and output/output overlap checks run before native admission.

Native admission additionally requires the validated-metadata witness, exact arena-column identity, and disjoint external publication columns. ID, offset, dictionary-name, and recent-source arrays cannot borrow the arena buffer. Hash slots and signature columns must match the arena fields. The helper rejects any source column borrowing the arena buffer and any authoritative arena view below its reserved prefix.

The copy uses four dense count-sized columns inside existing scratch. No authoritative row is changed by the native call. The kernel checks consecutive reservation IDs, pending state, both hashes, and lengths, matching the skipped JavaScript loop. Offset validation remains covered by the existing `metadataValidated` admission contract. A native rejection returns to the existing scalar publisher, preserving its partial-publication and error behavior for late invalid metadata.

## Scratch ownership and reentry

The active-scratch registry is keyed by the actual memory, shared across scanner instances, and counts overlapping scan scopes. Ownership starts before scratch/configuration writes and remains held through synchronous callbacks, output adoption, exact-match awaits, and error unwinding. Publication therefore falls back to JavaScript while a scan could still need the prefix.

On an arena change, the scanner releases its prior memory and acquires the current memory. The scope finally block releases the last owner. Only the current memory is retained by the ownership record; historical arenas are not accumulated. A new arena with no cached native instance takes the ordinary fallback until initialization. Optional exports permit an older compatible module to continue through the JavaScript check.

## Native bounds and publication ownership

The kernel uses 64-bit arithmetic for page-derived byte size, first-plus-count, and capacity-times-element-width. Each authoritative column must be aligned, start beyond the fixed 8 MiB prefix, and remain inside memory. The count is capped at the fixed 100,000-row scratch capacity, so all four copied columns fit in the prefix. The new kernel does not grow memory or publish table state.

The JavaScript owner retains all authoritative fill/set operations and pending/published counter updates. Existing synchronous journal rollback and outer rollback paths are unchanged. Tests cover late hash, length, ID and state failures, rollback/retry, borrowed scratch inputs and metadata columns, awaited callbacks, rejection cleanup, arena replacement, and malformed raw kernel layouts.

## Hosted acquisition bookkeeping

Timing run: `45645363685`. Memory run: `45645371602`. At the initial independent check, all three timing jobs and all six memory jobs were queued, with no artifacts. No cancellation, replacement acquisition, product edit, or rerun was performed by this reviewer. Frozen preformat study results must be attributed to `b2e816c4714f42f87cbb6a1ebc7fe1a2d2fd863b`; any subsequent AST-equivalent formatting head and its source CI are separate receipts.

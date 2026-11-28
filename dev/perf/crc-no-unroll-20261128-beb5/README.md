# One-pragma CRC scheduling screen

This is one prospective research component screen on baseline
9e10d3b3fcf66d344ab31bc42c9b522fa5215da2. It changes no tracked product file.
The build adds only "#pragma clang loop unroll(disable)" before the existing
eight-lane inner CRC loop, in an artifact source copy. Its source and production
WASM must match the previously frozen hashes in registration.json.

The paired-32-bit extraction idea already exists in PR #817 and did not establish
a repeatable material import benefit. Different lane counts were also screened
elsewhere without a winner. Neither is repeated here. The eight lanes, 64-byte
step, tables, 256 KiB threshold, final fold and scalar tail are unchanged.

## Why this exact candidate

Local code-generation diagnostics, completed before the executor became
unavailable, showed excessive native stack traffic in Node 22 TurboFan's
schedule of the unrolled loop. The single pragma preserved a smaller inner loop.
Liftoff added loop/state overhead, so the optimized-code observation does not
establish a speedup under the default engine.

The pragma materializes a 32-byte state initializer. That adds 32 constant data
bytes and shifts static addresses and the initial stack/heap base by 32 bytes.
The original assumption of identical non-code sections failed and was recorded.
The hosted build verifies that exact layout delta and normalized equality of
every other parser-source assembly function. This is not proof of peak memory or
runtime correctness.

No local correctness or timing result survived the interrupted next stage.
This hosted screen is the first completed correctness/performance attempt for
the candidate, if it reaches those gates. It is not a replacement timing cohort.

## Gates before any timing

The job verifies its sole baseline parent, exact added research paths, all
registered source-file hashes, LLVM/LLD 21.1.8 and both mandatory production
module hashes. The unchanged baseline must rebuild byte-for-byte. Generated
sources, production modules, test-only modules, assembly, compiler hashes,
package versions and build/failure receipts remain in the artifact.

The exact capture.mjs and fixtures.mjs helpers are reused from frozen
70f3cda48ba768979a117f58a3901334d402f700. They verify the pinned JMdict archive,
capture every bank in the unchanged three-worker/twelve-group partition, and use
Node zlib to establish decoded sizes, original ZIP CRCs, complete output digests
and row counts. Every group is below the current deferred-CRC admission ratio;
the actual production API must use immediate whole-bank CRC.

A separate correctness process checks:

- 837 deterministic CRC vectors, including published, empty, alignment,
  threshold, every 64-byte tail and large inputs, against Node zlib. Guard bytes
  and input digests must remain unchanged. Only these checks use the repository's
  existing TERM_BANK_CRC_TEST export.
- 157 stored/DEFLATE source-conformance cases through the exact production modules,
  including CRC, size, truncation, trailing input, hidden-member input, wrapper
  and earlier-error precedence. Error class and message must match the baseline
  expectations. The helper's 14 standalone DecompressionStream format records
  are outside this CRC study and are not counted as tested.
- All 53 actual JMdict banks, all 12 production groups, 528,299 rows and
  171,617,523 decoded bytes through both exact production modules. Every complete
  bank/group digest and span must match. Actual allocated WASM capacities must
  agree on these corpus groups.

A failure stops before timing and retains the failed context and completed
journal. A passing suite is limited to these cases; it is not full import,
cancellation, persistence or broad product qualification.

## Fixed default-engine cohort

There are six adjacent treatment pairs and six separate identical-code pairs,
interleaved with balanced AB/BA and AC/CA ordering. A and C load identical baseline
production bytes; B loads the frozen production candidate. All 24 arms are fresh
Node 22.22.0 processes with no V8 flags, forced GC, code-cache environment setting,
algorithm warmup, retries, replacements or outlier removal.

Each arm compiles its validated production module once, creates three fresh
worker isolates and instantiates a private parser module in each. Initialization
invokes no CRC export. The compiled module is shared as in the product worker
setup; a first invocation in a later worker is not an independently cold compiler.
After initialization, each worker reads and verifies its four assigned source
groups outside the timer. The actual production
inflateCompressedTermBankSourcesWasm(sources, {}, true) call is timed inside its
owning worker. It includes allocation/growth, metadata preparation, compressed
input copying, native inflation, original-source CRC and wrapper validation.

Groups are dispatched one at a time in fixed source order, assigned round-robin
across the three workers. The private instance owns its heap until output/span
verification finishes and the parent dispatches another group. This deliberately
measures summed owning-phase work. It does not model the product's concurrent
next-available scheduling or estimate browser import wall time.

Each arm runs one complete first pass and one complete second pass. No pass is
discarded as warmup. The two passes have separate paired summaries; neither is
pooled with the other. First invocation per instance is visible in raw records.
The second pass is called "second-pass", not guaranteed optimized execution.
All 576 group observations require complete output digests after their timers.
Output copying/hashing for the oracle and original-input digest rechecks are
outside both arms' timers; all production input copying remains inside.

Initialization wall time includes module compilation, worker creation, imports
and parallel instance initialization. Module-byte file reading/hash verification
happens before that timer. Source-file preparation is separate and excluded.
"Startup plus first-pass owning work" is an explicitly mixed component diagnostic,
not concurrent import elapsed time. The nested nativeInflateAndCrcMs counter is
included in owningMs and must never be added to it.

The screen reports every pair, median paired ratio, equal-work ratio and win
count for first pass, second pass and startup plus first pass. A/A remains visible
and is not subtracted. There is no automatic PR or browser-study promotion.
Only a clear default-engine benefit beyond same-code variation could justify
another separately approved study. A favorable forced-codegen count is insufficient.

## Failure retention and reproduction

Every completed worker message is journaled before parent validation. An arm
failure or fixed 180-second arm timeout stops the campaign without replacement.
The workflow uploads all available evidence on success or failure. The original
job log is also required when auditing acquisition failures.

Run in a clean checkout of the exact research commit with Node 22.22.0,
dependencies from its lockfile, and LLVM/LLD 21.1.8:

    python dev/perf/crc-no-unroll-20261128-beb5/build.py EVIDENCE
    node dev/perf/crc-no-unroll-20261128-beb5/capture.mjs FIXTURE_CACHE FRESH_INPUT_DIRECTORY
    node dev/perf/crc-no-unroll-20261128-beb5/verify.mjs FRESH_INPUT_DIRECTORY EVIDENCE
    node dev/perf/crc-no-unroll-20261128-beb5/campaign.mjs FRESH_INPUT_DIRECTORY EVIDENCE

A reproduction is a new cohort. It cannot replace or be pooled silently with the
original fixed observations. No source/pragma location, lane count, threshold,
worker count, group sizing, compression policy or durability setting is swept.

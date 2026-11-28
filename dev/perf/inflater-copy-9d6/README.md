# Native DEFLATE match-copy experiment

This is an unqualified component experiment against
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. It tests one small native decoder
change before considering any complete browser import experiment or runtime PR.

## Candidate and motivation

The current libdeflate backend already uses 64-bit bit buffers and word copies
on WASM32. Its fast match loop writes forty bytes at a time using five forward
eight-byte loads and stores. The candidate adds a WASM SIMD path for match
distances of at least sixteen bytes: two sixteen-byte copies followed by one
eight-byte copy. It retains the same forty-byte step and maximum write overrun.
The existing paths handle shorter distances.

Each wider load reads either existing history or bytes already written by the
previous copy. For distance sixteen, the second load reads the first store's
output; the final eight-byte load reads the second store's output. Distances
above sixteen preserve the same forward expansion rule. The output-space and
distance checks remain before copying, and the generic tail loop is unchanged.

An untimed counter diagnostic decoded every term bank from the locked archives.
JMdict had 4,130,770 eligible matches out of 4,228,772 (97.68%), covering 99.63%
of matched bytes. Jitendex had 9,284,833 eligible matches out of 9,467,232
(98.07%), covering 99.79% of matched bytes. Both the baseline and instrumented
decoder matched Node zlib, archive CRCs and output canaries for every bank.
These are reach measurements, not speed measurements.

The patch contains eighteen added native lines and a focused test extension.
The extra test suffix keeps known-distance matches inside the fast loop;
otherwise a match at the end of a synthetic stream can exercise only the
generic tail. Tests cover the sixteen-byte distance boundary, forty-byte copy
boundaries, overlapping forward expansion and output ending at physical WASM
memory. Existing invalid, truncated, trailing-byte and CRC tests remain intact.

## Frozen source and native identities

`candidate.json` binds the baseline commit, exact changed source/test files,
patch bytes, measurement scripts and native modules. The native compiler and
linker must both report 21.1.8. Every host first rebuilds the original checked-in
dictionary modules and requires exact equality with the production manifest.

Both timing modules add a direct `term_bank_inflate` export used by separate
local parity diagnostics. The timed endpoint is the existing production
`inflate_and_join_term_banks` export. The baseline timing module differs from
production only in the export section: all code, data, memory, type, function
and other noncustom sections must be identical. The candidate timing module
must match its independently frozen SHA-256 exactly.

| Native module | SHA-256 |
| --- | --- |
| Production baseline | `8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee` |
| Timing baseline | `674741af5e0ee70afa9f902b52870041ffd95a20dccc6e898f03f49dba339c31` |
| Timing candidate | `f2a8aac2961b6ee806a5fe33f23ccff6fc240fad64ec528ce1f20d2780a0c3d5` |

Candidate source is prepared in a detached worktree from the frozen baseline.
Only the declared patch is applied, and changed paths and hashes are checked.
The measurement branch's unrelated runtime edits are never used.

## Inputs and endpoint

The primary corpus is the locked November 22 JMdict archive, SHA-256
`3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`.
Its 53 term banks contain 171,617,523 uncompressed bytes. `source-groups.json`
records the twelve production source groups from the verified baseline capture.
The companion `capture.json` pins the exact capture run, commit, artifact ID,
size and digest. Preparation verifies the downloaded report against the fixture,
baseline native source, complete row count and group geometry. Dispatch IDs are
transient; bank grouping and order must agree exactly.

The timer covers native inflation and immediate CRC validation for those twelve
groups, replayed sequentially in one WASM instance. Input packing, allocation
order and output addresses follow the production source helper. Allocations,
input copies, column preparation, explicit GC and per-group output verification
are outside timing. Every pass checks returned spans and the complete source
byte digest:
`343a73cf768e5feaa5a1e557de40b3742a3de404524d164884c4787c668c6be8`.

This endpoint excludes native term parsing, three-worker scheduling, content
compression, persistent storage and UI. It is a component screen, not an import
speed or browser-memory measurement. A component signal would need a complete
browser import comparison before a performance claim or PR.

## Fixed observation protocol

Use Node 24.22.3. Each host retains all six A/B/C permutations: ABC, ACB, BAC,
BCA, CAB and CBA. A and C use byte-identical baseline modules; B uses the sole
candidate. The second independent host swaps A and B in that fixed schedule.

- Cold primary: eighteen fresh child processes, no warmups and one corpus pass
  per child.
- Warm separately: eighteen fresh child processes, four excluded passes and ten
  measured passes per child.

All observations, exact module and script hashes, per-group timings and memory
receipts are retained. Source-identical controls are reported separately. There
are no tail exclusions, control subtraction or automatic reruns. Failure leaves
the incomplete cohort and failure receipt intact.

The `screen.mjs` and `screen-child.mjs` files are byte-identical to the fixed
local screen. The portable driver prepares sources and inputs, copies these
unchanged measurement files beside the verified modules, and invokes them.

```sh
node dev/perf/inflater-copy-9d6/run.mjs \
  /absolute/baseline \
  /absolute/verified-capture \
  /absolute/dictionary-cache \
  /absolute/new-output \
  AB
```

Prepare baseline dependencies with `npm ci` and `npm run build:libs`, and fetch
the pinned archive with `node dev/perf/prepare-dictionaries.js jmdict`.
`MANABITAN_CLANG` and `MANABITAN_WASM_LD` may name installed pinned executables.
The hosted workflow uses Ubuntu 26.04's Clang/LLD 21 packages, then rejects any
version or produced native byte mismatch. Two isolated hosts run AB and BA.
The AB host runs the two focused test suites after timing.

## Current evidence and qualification status

The candidate exactly matched all 53 JMdict and 219 Jitendex term banks and
passed 96 focused tests. An initial added physical-end test omitted the span
output pointer, causing the legacy joined-output capacity check to reject it
before decoding. That failed test source and log were retained locally; the
harness was corrected without changing the native candidate.

The one complete local cohort had exact parity across all 36 observations but
did not establish a performance gain. Cold B/A and B/C medians were +3.31% and
+8.47%, with a +10.97% C/A baseline-control drift. Warm medians were -1.15% and
-3.70%, with only three wins out of six against each baseline and +2.23% C/A
control drift. Large tails remain in the raw receipts. The isolated hosted
cohort resolves this uncertainty; the unchanged local cohort is not repeated.

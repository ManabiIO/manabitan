# Incremental CRC eight-plus-four tail: durable evidence

This bundle preserves the small source-gap CRC candidate and the retained
bounded local CRC investigation, including variants that were slower or
inconclusive. It supports review of a component optimization. No completed
browser-import gain is claimed.

## Source and result scope

Baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The measured production
checkpoint is `565ea5d2e712b44bd6a33db65f5a8d3d34d8db6a`; its parser WASM hash is
`b362d9b0106c28e9cb495d66c650463c771e165cb8ebadc4a66adda973466fd9`.
The current trial head is `3080deb631a7536fabe8ccb2f77f8f55e11ef061`; only test
formatting changed from its initial published trial. Exact current and original
test snapshots are both retained, with their provenance.

The runtime adds 25 C lines to consume an optional eight-byte then four-byte
remainder using existing tables. It adds no allocation/table and changes no
admission, witness or grouping policy. The production WASM grows 284 bytes;
the other 50 function bodies remain identical. Independent Node-zlib tests
cover 8,160 lengths/alignments/preceding states, and complete compared VNDB
parser outputs match across all 6,648,310 rows.

The exploratory captured-gap replay improves 21.21% for its CRC-only workload.
The two full sequential parser runs reduce the summed CRC phase by 62.01 ms
(8.65%) and 49.87 ms (6.82%). Unchanged inflation also drifts, so the larger
whole-component changes are not attributable to CRC. The selected direct
production-verifier diagnostic is less decisive: geometric −3.19%, descriptive
95% interval [−7.38%, +1.74%]. Local two-bank grouping scans 872 MB in 332 groups;
the production census scans 568 MB in 170 groups with three workers. Do not
apply the local percentages to complete-browser time or worker-duration sums.

Wider slicing32 loses in the complete parser and verifier; table padding is
inconclusive. Those negative observations, sources, native modules, scripts and
logs are retained. The separate whole-bank braid-lane diagnostic is also
retained as a non-winner and is not part of the eight-plus-four candidate.

The initial hosted run passed full units/native/build, then failed test-only
line-wrap lint. That complete failure log is included. Current-head run
46107723369 has now passed validation job 140864123481, including native
reproduction, full units, builds, lint and types. Its browser jobs
140885249404 / 140885249416 / 140885249418 remain queued in the final receipt.
The prior queued snapshot and earlier reviews retain their historical status;
no pending browser gate is presented as passed. A narrowly scoped draft review
is distinct from merge qualification.

The first rejected slicing32 full-parser acquisition predates the driver's
self-hash field. Its raw group observations, exact product/native identities
and output comparisons are retained, but the exact original acquisition driver
cannot be certified from this evidence. The later checkpoint and reversed-order
drivers are preserved; their hashes match the two promoted eight-plus-four
receipts. The five-arm production-verifier driver also matches its recorded
hash. This limitation concerns the earlier rejected exploration and must not
be described as a fully source-bound original scripting record.

## Integrity and omissions

Existing file contents and workspace-relative paths are preserved. Every
archive member is listed by SHA-256/bytes in the external manifest, which also
binds the complete archive. Tar ownership/timestamps and gzip time are
normalized. The separate `.sha256` binds both archive and manifest.

Omitted large inputs are explicit in that manifest:

- The 8,817,187-byte packed raw-gap capture is omitted; its exact hash and size
  are recorded during packaging. The compact span-index input is retained.
- The production-verifier source/metadata/witness snapshots were removed
  earlier under the recorded cleanup decision. Their per-file hashes, sizes,
  capture script, expected output hashes and cleanup receipt are retained.
- The 291,705,969-byte VNDB ZIP and its media/source banks, node_modules, compiler
  distribution, browser packages and physical imported databases are omitted.
  The pinned fixture lock gives the source URL, SHA-256 and expected inventory.

The small `native-checkpoints.pack` preserves the two local native commits and
their changed Git objects, including the rejected slicing32 state. It has no
published ref and requires the stated baseline repository for connectivity.
This lets the original verifier scripts retain their exact `git show` commit
lookups without inventing replacement identities.

```sh
python3 evidence/durable-bundles/package-evidence.py \
  --verify-manifest /absolute/path/crc8_4-evidence-20261128-1b47-v2.manifest.json
```

## Reconstruct source and validate

Set `BUNDLE` to the extracted archive root, `REPLAY` to a fresh workspace, and
`FIXTURES` to the pinned dictionary cache. Do not overwrite archived reports.
Use the recorded Node 24.22.3 and Clang/LLD 21.1.8 for like-runtime diagnostics.

```sh
git clone https://github.com/ManabiIO/manabitan.git "$REPLAY/manabitan"
git -C "$REPLAY/manabitan" checkout --detach 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2
git -C "$REPLAY/manabitan" index-pack --stdin < "$BUNDLE/evidence/durable-bundles/crc8_4/native-checkpoints.pack"
git -C "$REPLAY/manabitan" worktree add --detach "$REPLAY/crc8_4" 565ea5d2e712b44bd6a33db65f5a8d3d34d8db6a
git -C "$REPLAY/manabitan" worktree add --detach "$REPLAY/crc-slicing32" 92815fb8a5df090db95025c1b2d26e2677dc1d5a
```

Install dependencies with each checkout's pinned package lock. Set
`MANABITAN_CLANG` and `MANABITAN_WASM_LD` to the pinned toolchain, then run
`npm run build:dictionary-wasm -- --check` and `npm run build:libs` in each
checkout. The original checkpoint test intentionally retains its historical
formatting; the current trial's format-only file is under `source-current`.
Use that exact file when checking current-head lint. Do not merge the rejected
slicing32 source into the eight-plus-four product.

## Reproduce bounded component inputs and measurements

First regenerate the omitted raw gaps in a fresh directory by copying the
unchanged `capture-gaps.mjs` there; it writes adjacent output files:

```sh
node "$REPLAY/new-gap-capture/capture-gaps.mjs" "$REPLAY/manabitan" "$FIXTURES" 12 1
```

Compare its gap and span bytes with the external omission/member hashes before
timing. Copy the original `corpus-screen.mjs` and its four archived probe WASMs
into that fresh directory, then run it there. It writes a new report. The
original probe sources and build script are retained. The build script records
historical absolute compiler paths; `rebuild-probes.py` supplies a portable,
path-only equivalent with the same flags and verifies each resulting WASM
against the archived bytes. No new probe was compiled for packaging.

The full-parser checkpoint driver accepts explicit roots and source identity:

```sh
node "$BUNDLE/evidence/crc-tail/full-vndb-parser-replay-checkpoint-v1.mjs" \
  "$REPLAY/manabitan" "$REPLAY/crc-slicing32" "$FIXTURES" \
  "$REPLAY/new-tail8_4.json" 0 565ea5d2e712b44bd6a33db65f5a8d3d34d8db6a \
  "$BUNDLE/evidence/crc-tail/checkpoint8_4/term-bank-parser.wasm"
node "$BUNDLE/evidence/crc-tail/full-vndb-parser-replay.mjs" \
  "$REPLAY/manabitan" "$REPLAY/crc-slicing32" "$FIXTURES" \
  "$REPLAY/new-tail8_4-reversed.json" 0 565ea5d2e712b44bd6a33db65f5a8d3d34d8db6a \
  "$BUNDLE/evidence/crc-tail/checkpoint8_4/term-bank-parser.wasm" BA
```

Those receipts bind the loaded eight-plus-four WASM independently of the
slicing32 worktree's current native files. The complete parser comparison is
sequential native work, not browser import/persistence/media qualification.

For the selected production-export replay, recreate the removed snapshots:

```sh
node "$BUNDLE/evidence/crc-tail/capture-verifier-inputs.mjs" \
  "$REPLAY/manabitan" "$FIXTURES" /tmp/manabitan-1b47-crc-inputs-reproduction
```

The destination must be new and use the script's required prefix. Compare every
record hash/size against `verify-inputs-manifest.json`; the complete metadata
JSON may contain different host paths. The original five-arm and opposite-order
drivers are retained. Their padded-variant manifest contains absolute workspace
paths; in a separate replay copy, relocate only `sourcePath` and each build's
`wasmPath` to the corresponding included files. Preserve all source/module
hashes, original manifest and new mapping receipt. The native Git pack above
keeps the original hard-coded checkpoint identities valid.

Run `replay-production-verifier-five-arm-v1.mjs` with arguments
`NEW_INPUTS NEW_REPORT BASELINE_ROOT SLICING32_ROOT`; the later driver accepts
the additional `tail-padding-opposite` cohort name. The original frozen raw
records, not a rerun on another host, support the reported findings. Timings
will vary; exact CRC/state/output checks must continue to pass.

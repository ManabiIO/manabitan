# Bounded 64-bit Zstd match counting: frozen research protocol

This is a research-only build and correctness workflow. It changes no extension
runtime file, default, compression level, dictionary, grouping, batch size, cache,
or persisted format. The workflow does **not** collect timing. No optimization PR
is qualified by this setup.

Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
Upstream Zstd: `82d322c4973d9e2968d94047a40892bc6d9a9bdf`.
Pinned input, patch, and toolchain identities are in `source-pins.json` and
`toolchain.json`; the exact reviewed source-file set is in `source-files.json`.

## Mechanism and source evidence

The production WASM uses 32-bit `size_t`. Upstream `ZSTD_count` therefore compares
four bytes per iteration even though WebAssembly provides native 64-bit loads,
XOR, and trailing-zero count. The proposed `__wasm32__` branch compares eight bytes
when both the existing segment contract and the remaining input permit it. A
nonzero XOR locates the same first differing byte. The remaining four-, two-, and
one-byte comparisons preserve the exact longest prefix. Other compilation targets
retain their original source body.

The change has no match-selection heuristic. It neither skips source positions
nor changes hash tables, compression parameters, dictionary handling, frame flags,
or output capacity. Wasm is little endian, and the nonzero guard makes
`__builtin_ctzll` defined. Calling the upstream `ZSTD_countTrailingZeros64` helper
would be insufficient: its current builtin guard requires `__LP64__`, so wasm32
uses two 32-bit operations there.

The caller must bound both operands. Ordinary prefix matches precede the current
input within the same segment. Dictionary callers use `ZSTD_count_2segments`,
whose first limit is `min(inputEnd, input + (matchEnd - match))`; it continues from
the prefix only after reaching the dictionary end exactly. The existing upstream
64-bit implementation already relies on this same eight-byte operand contract.

Read-only inspection of the checked production module
`ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc`
mapped function 101 to `ZSTD_compressBlock_fast` and 149 to
`ZSTD_compressBlock_fast_extDict`: the complete compressor dispatch table at
linear-memory address 2096 agrees with upstream's four-by-ten table, function-table
slots 3/12 point to 101/149, and caller 94 reads that table. Function 101 contains 32
`i32.ctz` sites; 149 calls the two-segment counter in function 5, whose bounded
four-byte loops contain four more `i32.ctz` sites. Neither counter uses `i64.ctz`.
The sampled profiles identify these as hot paths; their interval weights contain
long and negative deltas and are **not CPU durations or removable wall time**.

Repository/PR searches for `ZSTD_count`, Zstd match-counter/length/word changes,
and i64/SIMD work found no duplicate. Nearby work concerns inflater kernels,
compression staging, context/dictionary reuse, or initialization. The previous
raw-CCtx-template experiment failed its control comparison and is not revived.

## Immutable available toolchain and the production confound

The original provenance only recorded Emscripten `5.0.1-git`. This research uses
the official 5.0.1 SDK selected from primary upstream metadata:

- [SDK release commit 14c18b56](https://github.com/emscripten-core/emsdk/commit/14c18b569f55138fe4963924162244251f454fb0)
  pins releases-build `bf32ae8b61ac8efeb7eca01b54c8307f992724f7`.
- [The immutable official checksum table](https://github.com/emscripten-core/emsdk/blob/14c18b569f55138fe4963924162244251f454fb0/bazel/revisions.bzl)
  gives Linux x86_64 archive SHA-256
  `bda6917b630fcc604cca39af433180adfd7195e378075331ceac926553684249`.
- [The tagged Emscripten version file](https://github.com/emscripten-core/emscripten/blob/8c5f43157a3f069ade75876e23061330521eabde/emscripten-version.txt)
  contains `5.0.1-git`. That matching label is not treated as exact build identity.
- [The pinned compiler documentation](https://github.com/emscripten-core/emscripten/blob/8c5f43157a3f069ade75876e23061330521eabde/site/source/docs/tools_reference/emcc.rst)
  describes `--emit-symbol-map`, which is used to retain actual function names.

The runner verifies the SDK archive before extracting it. It records command
lines, tool versions and executable hashes, both amalgamated sources, the applied
patch, loaders, production WASM, symbol maps, named mirrors, and disassembly.
Named mirrors append the compiler's function-name mapping as a custom section;
all noncustom sections must remain byte-identical to their production variant.
They are diagnostic mirrors, not separately optimized builds.

| Arm | Definition | Interpretation |
| --- | --- | --- |
| P | Checked-in baseline WASM and loader from 9e10 | Actual production control |
| A | Unmodified pinned Zstd rebuilt with the selected immutable SDK | Compiler/build control |
| B | Same command/toolchain as A plus only `count64.patch` | Algorithm candidate |
| C | Exact file copy of A, loaded from a separate module URL/instance | Identical-code runtime control; **not an independent rebuild** |

The build records P/A full WASM, noncustom-section, and loader identity explicitly.
`--emit-symbol-map`, toolchain details, or their combination may affect the rebuilt
output. A mismatch is retained as a result. B/A or B/C does not establish improvement
over production; B/P is required separately. Compiler-only effects are never
attributed to the new counter.

## Frozen corpus reconstruction

No large fixture blobs enter git. `corpus-manifest.json` is the unchanged original
expected manifest, SHA-256
`2401251afd5a5525df50652d4820bd93a2fc95137fa71a0fb058331b1f90da45`.

The hosted runner downloads the locked JMdict archive, checks its full size/hash,
then runs the untouched baseline parser through the original capture/packing
algorithms. The retained original drivers match the hashes in the expected
manifest. Portable copies change only module/root paths and the owned temporary
spill-directory location/creation; their exact diffs are retained.

The expected input covers 528,299 rows, 362,032 globally exact unique content entries,
100,300,626 uncompressed bytes, and 31 unchanged 4 MiB whole-entry packing blocks.
Every block's SHA-256, byte length, entry count and group must match. The complete
logical digest, row/unique/duplicate/collision counts, group membership, source
identities, and all other semantic manifest fields must also match.

The reconstructed manifest remains separate. Only capture-script hash, Node
version, RSS, record-manifest hash and packer-script hash may differ as declared
environment/portable-driver receipts. The original expected manifest is copied
unchanged as `expected-manifest.json` **after** full semantic verification.
Gzip-container timestamps/bytes are not an acceptance criterion; uncompressed
canonical bytes are exact. Candidate code never participates in reconstruction.

This is a canonical compression component fixture. It is not a browser import
capture, physical OPFS block-layout guarantee, or full importer oracle.

## Build and correctness gates

The hosted workflow performs one build/correctness acquisition and retains all
logs, failures and artifacts. It does not rerun failed observations or invoke the
dormant timing driver.

1. Verify frozen baseline runtime, dependency lock, parser WASM, source pins and
   exact expected corpus; reconstruct every input block as above.
2. Download/check the immutable SDK; fetch exact upstream Zstd; apply only the
   hash-checked 21-line wasm32 patch to B; build A/B and copy A to C.
3. Compile the exact patched helper with a native scalar/guard-page oracle. Check
   zero/tiny/long inputs, every short mismatch position with varying bit flips, logical end
   offsets 0–15, both allocation ends, overlapping repeat offsets, and all
   external-dictionary seams. This oracle is correctness evidence, not native
   performance evidence or proof of the production WASM code generation.
4. Run every canonical block through actual P/A/B/C WASM at unchanged level −1 and
   the pinned JMdict dictionary. Require identical frames and complete checksummed
   block envelopes, and decode every result both with its arm and unchanged P.
5. Check empty/tiny values, powers-of-two boundaries, 128 KiB and 4 MiB seams,
   dictionary switches/reuse, tiny raw and malformed dictionaries, and wrong-
   dictionary readback parity. Errors must match unchanged production.
6. Run separate same-toolchain actual-WASM exports of the exact count helpers
   against scalar expected prefixes, including true linear-memory-end traps and
   both sides of dictionary seams. These test exports are not added to runtime
   modules. Recheck all runtime artifact and canonical-input hashes afterward.

Any failed source, boundary, decode, frame/envelope or identity gate blocks timing.
Build-only success still does not qualify a PR.

## Prospective timing protocol — approved before any data

The parent approved this exact gate on 2026-11-28 before timing. The build workflow
does not call `benchmark-wasm.mjs`; after artifact/source review, one explicitly
authorized invocation may use its frozen `--frozen-screen` mode.

Load every canonical block and all four modules outside timing. Each module owns
four reused native compression contexts assigned round-robin to the same blocks;
execution is serial. A/C use independent module URLs and instances. Run complete
frame/envelope oracles before and after the cohort, and recheck input/module/
driver identities afterward. Two full-corpus warmup passes per arm are excluded.

Acquire exactly eight blocks with orders:

```text
PABC  ABCP  BCPA  CPAB  CBAP  PCBA  APCB  BAPC
```

Each arm occupies each position twice. One observation compresses all 31 blocks
once. The identical timed adapter includes source/dictionary copies into WASM,
the existing `ZSTD_compress_usingDict` call, error/length checks and minimal result
consumption. Compilation, fixture loading, context allocation, forced GC, output
copying, envelope hashing, output verification and filesystem work are outside
the interval. Incidental GC/JIT work inside remains included. CPU and monotonic
wall cover the same work. Report absolute ms per complete canonical corpus.

Advancement requires all of:

- All 32 observations, exact pre/post frame/envelope oracles, and unchanged hashes.
- Median paired CPU **and** wall improvement of at least 5% against each of P, A, C.
- At least 7/8 faster blocks for each metric/comparison and negative equal-work
  change in each comparison.
- Median paired CPU saving of at least 10 ms per complete canonical corpus against
  each of P, A, C.
- Identical C/A median CPU/wall drift within 5%. If P and A WASM are byte-identical,
  their A/P median CPU/wall drift must also be within 5%.

No dropped tails, control subtraction, retries, added blocks, thresholds changed
after data, or pooling with the earlier native-template experiment. Any failed
gate ends this unchanged screen. Passing supports a later complete-browser
comparison and memory/lifecycle qualification; it establishes no whole-import
speed, production peak-memory, or cross-engine claim by itself.

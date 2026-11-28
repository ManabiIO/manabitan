# WASM word width component experiment

This temporary experiment evaluates a pinned Zstd compressor on captured JMdict canonical content. It does not measure a full import, worker scheduling, OPFS storage, browser latency, lookup performance, or whole-process memory.

Run on an isolated host with Node 24.22.3, Python 3, Git, tar, and network access:

```sh
node dev/perf/wasm-word-width-v2/run.mjs BASELINE_ROOT CAPTURE_DIR OUTPUT_DIR AB
```

The narrowly scoped `import-codec-width-v2-9d6.yml` workflow reuses the frozen capture artifact described in `capture-artifact.json`. It validates artifact metadata, source run/attempt/head, and the downloaded archive SHA-256 before extraction.

Use a separate host with `BA` for the reversed order. `CAPTURE_DIR` must contain `report.json` and `group-NN.bin.gz` files generated from the pinned current-source canonical planner. The scripts read the actual database block target, currently 1 MiB, and preserve each captured source's shared-buffer ownership when invoking the unmodified production JS compression wrapper.

The build downloads Emscripten 5.0.1-git from the immutable release URL in `manifest.json`, checks the archive SHA-256, and builds the pinned Zstd revision. It requires the baseline JS and WASM artifacts to reproduce byte for byte. Each candidate also has an expected exact hash. Only the C match counter changes; exports, compression levels, dictionary bytes, corpus grouping, source ownership, and block planning stay fixed.

Verification runs in separate processes before measurement. It compares every wrapped compressed byte for the 103 current JMdict blocks, cross-decodes with baseline and candidate, and exercises short inputs, tail lengths, unaligned inputs, raw dictionaries, no dictionaries, random content, repetitive content, and multiple compression levels. The production wrapper has an additional exact-byte parity pass.

Each warm screen creates four fresh wrapper instances: A/C baseline and B/D candidate. After two complete warmup passes per instance, eight fixed balanced rounds retain all four arms. The raw results include gathering, compression with envelope/output copy, total wrapper time, and retained buffer capacities. The run also collects all six permutations of three arms in separate fresh Node processes (A/C baseline, B candidate), with no compressor execution warmup. Cold initialization and first-corpus execution remain separate from warm measurements.

Upload the output JSON files and, if useful, `wasm-*/zstd-simd-module.wasm` and `wasm-*/zstd-simd-module.js`. Do not upload `sdk/` or `zstd-source/`, which are reproducible toolchain/source intermediates. Local developers may reuse an exact SDK through `MANABITAN_EMSCRIPTEN_UPSTREAM` and a pinned source checkout through `MANABITAN_ZSTD_SOURCE`; all artifact hash gates still apply.

## Variants

- `count16` compares bounded 16-byte groups using WASM SIMD byte inequality, a lane mask, and trailing-zero counting. It keeps an 8/4/2/1-byte tail. SIMD mask costs differ between x64 and ARM; this screen cannot establish ARM performance.
- `cstream64` independently widens only the compression bit accumulator to 64 bits and bases sequence flush decisions on that width. The decoder, pointer sizes, offset splitting, match counter, and separate Huffman stream implementation stay unchanged.

The CStream64 prototype has a known tight-output limitation: its larger tail reserve can report `dstSize_tooSmall` for capacities where the baseline succeeds. Local testing found 72 such status differences across 1,110 capacity/canary cases, with no canary corruption. All production `compressBound` allocations succeeded with identical bytes. This prototype is not release-qualified; a material performance signal would justify preserving the original tight-capacity behavior before product review.

The v2 verifier adds entropy-heavy inputs, exact/tight capacities, leading/trailing canaries, and successful-frame round trips. It records capacity-status differences rather than hiding them. These scripts currently accept the JMdict capture. Before extending to Jitendex, use the production dictionary-name resolver: Jitendex also uses the JMdict compression dictionary and level.

Zstd is pinned to `82d322c4973d9e2968d94047a40892bc6d9a9bdf` and retains its upstream BSD 3-Clause license. The Emscripten version, archive hash, wrapper source hash, envelope helper hash, baseline artifact hashes, and candidate artifact hashes are recorded in the manifest and run outputs. No result from this experiment alone establishes a browser or whole-import gain.

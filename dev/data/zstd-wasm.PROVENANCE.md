# Zstd WASM provenance

`zstd-simd.wasm` and `zstd-simd-module.js` are generated from the Facebook Zstandard
repository at commit `82d322c4973d9e2968d94047a40892bc6d9a9bdf`, with
`zstd-wasm32-match-count.patch` applied before amalgamation. This patch uses
bounded WebAssembly SIMD loads to count equal bytes in compression matches.
The compression parameters, frame format, and decoder are unchanged.
The build also links Manabitan's `zstd-block-envelope.c` helper, which writes
the existing checksummed term-content envelope inside the WASM output buffer.

The current checked-in assets were produced with Emscripten `5.0.1-git` using
`-O3 -flto -msimd128`. The exact Emscripten commit is
`8c5f43157a3f069ade75876e23061330521eabde` (SDK release
`bf32ae8b61ac8efeb7eca01b54c8307f992724f7`). The generated WASM SHA-256 is
`60319137e8014265d975e493c1fbc1d24a9aa8a773a401f5cb072e4a3a74fb7a`.
The generated JavaScript remains byte-identical to the unpatched build.

Zstandard is distributed under the BSD 3-Clause license;
see the upstream repository for its license text.

Verify the checked-in assets byte-for-byte:

```sh
npm run build:zstd-wasm
```

Regenerate them after an intentional source or toolchain update:

```sh
npm run build:zstd-wasm -- --write
```

# Zstd WASM provenance

`zstd-simd.wasm` and `zstd-simd-module.js` are generated from the Facebook Zstandard
repository at commit `82d322c4973d9e2968d94047a40892bc6d9a9bdf`.
The build also links Manabitan's `zstd-block-envelope.c` helper, which writes
the existing checksummed term-content envelope inside the WASM output buffer.

The current checked-in assets were produced with Emscripten `5.0.1-git` using
`-O3 -flto -msimd128`. Zstandard is distributed under the BSD 3-Clause license;
see the upstream repository for its license text.

Verify the checked-in assets byte-for-byte:

```sh
npm run build:zstd-wasm
```

Regenerate them after an intentional source or toolchain update:

```sh
npm run build:zstd-wasm -- --write
```

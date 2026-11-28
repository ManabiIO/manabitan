# Zstd WASM provenance

`zstd-simd.wasm` and `zstd-simd-module.js` are generated from the Facebook Zstandard
repository at commit `82d322c4973d9e2968d94047a40892bc6d9a9bdf`.
Before amalgamation, the build applies `zstd-wasm32-count.patch`. This local
specialization compares match spans in 16-byte SIMD units, followed by bounded
8/4/2/1-byte tails, on wasm32 builds with SIMD enabled. An early return preserves
the upstream zero result when a dictionary caller supplies a reversed virtual
input limit. Other targets use the original scalar function body.

The build also links Manabitan's `zstd-block-envelope.c` helper, which writes
the existing checksummed term-content envelope inside the WASM output buffer.

The current checked-in assets were produced with Emscripten `5.0.1-git` using
driver revision `8c5f43157a3f069ade75876e23061330521eabde` and
`-O3 -flto -msimd128`. The SDK release is
`bf32ae8b61ac8efeb7eca01b54c8307f992724f7`. Zstandard is distributed under the BSD
3-Clause license; see the upstream repository for its license text.

| File                         | SHA256                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| `zstd-wasm32-count.patch`    | `9bd9847abd7b0fec06ebe6f13d372e9796faeb363865671baf1ec10ed65fd816` |
| `zstd-simd.wasm`             | `13890c7e75e7a2ff5fa00bd65f1e518e15f545da85154719be6a2eaa2a773a22` |
| `../lib/zstd-simd-module.js` | `9ec18a2a02698c24e797882ffcee1ef8d97dd7b00e5fa58aa5a0365c7234fe48` |

Verify the checked-in assets byte-for-byte:

```sh
npm run build:zstd-wasm
```

Regenerate them after an intentional source or toolchain update:

```sh
npm run build:zstd-wasm -- --write
```

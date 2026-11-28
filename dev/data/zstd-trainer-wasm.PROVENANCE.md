# Zstd trainer WASM provenance

`zstd-trainer.wasm` is generated from the Facebook Zstandard repository at
commit `82d322c4973d9e2968d94047a40892bc6d9a9bdf`, linked with Manabitan's
`zstd-trainer-adapter.c` helper using Emscripten `5.0.1-git`.

The trainer is an optional post-import optimization worker. Its executable and
loader ship in the browser package with the exact upstream BSD license at
`ext/js/dictionary/zstd-trainer.LICENSE`; the legal page links to that notice.
The release-package audit requires this notice in every browser package that
contains the trainer.

Verify the checked-in assets byte-for-byte:

```sh
npm run build:zstd-trainer-wasm
```

Regenerate them after an intentional source or toolchain update:

```sh
npm run build:zstd-trainer-wasm -- --write
```

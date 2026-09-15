# libdeflate portable DEFLATE subset

Source: [libdeflate v1.26](https://github.com/ebiggers/libdeflate/releases/tag/v1.26), released August 22, 2026. License: MIT; the complete notice is retained in `COPYING` and the upstream files.

Official source archive: `libdeflate-1.26.tar.gz`.
SHA-256: `125856d4656e0feab660f94842f835923410c9281fedbcee64598c918da42b5a`.

The retained upstream files are `COPYING`, `libdeflate.h`, `common_defs.h`, `lib/lib_common.h`, `lib/deflate_constants.h`, `lib/deflate_decompress.c`, and `lib/decompress_template.h`. This is a build-time source dependency, not a runtime network download. The extension build compiles it into `term-bank-parser.wasm`.

## Integration boundary

`../../term-bank-inflate.c` compiles only the portable full-buffer raw DEFLATE implementation with the upstream `FREESTANDING` support. The build does not link an allocator, host imports, architecture-specific dispatch, gzip handling, a compressor, or the upstream checksum implementations. The existing importer still validates the original bank CRC, exact compressed consumption, expected decoded length, array boundaries and output capacity.

The wrapper owns one static decompressor per WebAssembly instance. Parser workers instantiate independent modules; calls within one instance are synchronous and non-reentrant. Heap-arena reset does not reset the decoder, and every call may follow either a valid or rejected stream. No decoder pointer escapes the wrapper. Worker teardown releases the entire instance.

This deliberately depends on the pinned internal decompressor construction contract: zero-initialized tables and `static_codes_loaded` are sufficient for decoding; the unused `free_func` is never called because the static object is never passed to the upstream free API. A future reentrant/shared-instance execution model requires a different ownership design.

## Upgrade requirements

Review the upstream constructor, decoder state after failure, internal structure and full-buffer result semantics before replacing files. Preserve license notices and record a new immutable source hash. Do not disable safety checks or accept trailing bytes. Rebuild and require zero WebAssembly imports.

Run `test/term-bank-inflater.test.js`, the existing parser/worker/import suites, and the native sanitizer companion `test/native/term-bank-inflater-sanitizer.c`. The latter covers the portable decoder with the native host ABI; it is not a substitute for the production wasm32 tests. Requalify complete checksum-pinned dictionary imports, stored content, memory and package costs. A faster isolated decoder is not sufficient evidence of a faster complete import.

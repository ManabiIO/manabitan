# Dictionary WASM build lock

Normal builds copy the modules listed in `manifest.json` after validating source and artifact hashes. The manifest covers the term-bank parser, canonical-content scanner, and compact record-field encoder.

`manifest.json` binds their hashes to every native C/header input, the compilation recipes, and Clang/LLD 21.1.8. Build validation rejects changed inputs and damaged modules before copying any output. CI independently rebuilds them with the pinned compiler and linker and requires identical bytes.

After an intentional native source or toolchain change, run:

```sh
MANABITAN_CLANG=/path/to/clang-21 MANABITAN_WASM_LD=/path/to/wasm-ld-21 npm run build:dictionary-wasm -- --write
npm run build:dictionary-wasm -- --check
```

Both executables must report exactly the versions in the manifest. The linker path is supplied explicitly to Clang with `-fuse-ld=<absolute path>` for every target. Regeneration uses a fresh temporary directory; ordinary builds need no native compiler. Review the source and module changes together and qualify changed runtime bytes before publishing them.

The native implementation and these generated modules retain their existing source licenses, including the portable libdeflate inflater's notices. No license is changed by checking in the compiled artifacts.

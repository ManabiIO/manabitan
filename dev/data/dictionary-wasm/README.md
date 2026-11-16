# Dictionary WASM build lock

Normal builds copy these verified modules rather than compiling with whichever compiler is first on the host PATH. They are the exact modules qualified in the published `26.11.16.0` browser packages at source `b2a77f7f0e752b03f1ef80169275498a38c1ecc3` ([19-job qualification](https://github.com/ManabiIO/manabitan/actions/runs/43863767986)).

`manifest.json` binds their hashes to every native C/header input, the compilation recipes, and Clang/LLD 18.1.3. Build validation rejects changed inputs and damaged modules before copying any output. CI independently rebuilds them with the pinned compiler and linker and requires identical bytes.

After an intentional native source or toolchain change, run:

```sh
MANABITAN_CLANG=/path/to/clang-18 MANABITAN_WASM_LD=/path/to/wasm-ld-18 npm run build:dictionary-wasm -- --write
npm run build:dictionary-wasm -- --check
```

Both executables must report exactly the versions in the manifest. The linker path is supplied explicitly to Clang. Regeneration uses a fresh temporary directory; ordinary builds need no native compiler. Review the source and module changes together and qualify changed runtime bytes before publishing them.

The native implementation and these generated modules retain their existing source licenses, including the portable libdeflate inflater's notices. No license is changed by checking in the compiled artifacts.

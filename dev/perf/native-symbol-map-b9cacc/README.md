# Exact dictionary WASM symbol mapping

This is a symbol identity diagnostic for product commit
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. It runs no dictionary import and
supports no timing, memory, or optimization claim.

The current parser module has SHA-256
`8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee`.
The older retained symbol proof refers to a different parser module beginning
`913da48a`; its internal index names cannot safely be reused. Export names in the
current module directly identify parser function 36 as
`parse_and_encode_term_bank_token_binary_dedup` and canonical function 4 as
`scan_canonical`. The other internal names require the proof produced here.

## Procedure

1. Preserve this tooling, then check out the exact clean product baseline.
2. Verify the native source-set digest, all 14 C/header inputs, both locked
   modules, and the manifest's Clang/LLD 21.1.8 versions.
3. Run the repository's existing `npm run build:dictionary-wasm -- --check` with
   explicit compiler/linker paths. This gate reproduces the original stripped
   bytes before any names-enabled compilation.
4. Compile each manifest target into the diagnostic output directory with only
   the single `-Wl,--strip-all` argument removed. Every other argument and source
   file remains in the original order.
5. Compare the complete ordered encoding of every non-custom section, including
   the WASM header. Any instruction, data, type, export, function-order, memory,
   or other non-custom difference rejects the mapping.
6. Parse the `name` custom section and associate every function index with its
   name, export aliases, type index, code-body length, and code-body SHA-256.
   Require complete, unique, in-range names and unchanged body/export identity.
7. Verify frozen inputs and tracked product cleanliness again. Preserve the
   original and named modules, exact sources, command arrays/stdout/stderr, tool
   versions, per-section hashes, complete maps, and failure receipts.

The workflow installs the same compiler/linker package names on the same Ubuntu
26.04 runner family as the repository's native reproduction CI. It verifies the
actual versions rather than accepting whichever patch release is available.
No dependency installation, extension package build, source mutation, browser,
dictionary import, flag tuning, or threshold change is performed.

## Local validation

Run from a repository containing the frozen source objects:

```sh
python -m unittest discover -s /path/to/native-symbol-map-b9cacc -p 'test_*.py' -v
```

The tests only parse small synthetic modules and the checked-in frozen binaries.
They cover exact export indices, unchanged body mapping, unrelated custom
sections, executable drift, missing/duplicate/out-of-range names, truncation,
invalid varuint32 values, and unexpected imported-function ABI changes.

For coordinator review, publish the Python/test/README files under
`dev/perf/native-symbol-map-b9cacc/` and the YAML under
`.github/workflows/native-symbol-map-b9cacc.yml`. This diagnostic does not open a
product pull request.

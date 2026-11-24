# Native projection validation

`receipt.json` records every command, exit status, and log digest. The logs are
retained without editing. Source-corpus parity is correctness evidence, not a
timing benchmark.

The original full unit invocation had two compiler setup failures. Correcting
the compiler environment exposed a missing include path in a test that compiles
the complete C source through standard input. A follow-up test-only change adds
the existing native source directory to that command. Both affected suites then
pass all 21 tests. The first invocation and intermediate retry remain failures
in the receipt.

The follow-up also formats the new evidence README and JSON according to the
repository rules. Its four-file diff changes no runtime source, generated WASM,
source fixture, or browser measurement harness. Complete product subtree hashes
are included in the receipt alongside local and published commit mappings.

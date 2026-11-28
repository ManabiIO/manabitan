# Native compact record fields component prototype

This experiment replaces only compact record field encoding. Existing record run validation remains necessary. The native module copies fresh private input columns, validates its compact subset, interns scores in first-use order, and writes the existing bytes. Unsupported input returns null and uses the current JavaScript encoder. No storage format, batch size, worker count or compression policy changes.

Build with the repository's pinned Clang and LLD 21.1.8 executables:

```sh
MANABITAN_CLANG=/path/to/clang-21 MANABITAN_WASM_LD=/path/to/wasm-ld-21 node build.mjs
node edge-check.mjs --repository /path/to/manabitan
```

The prototype is deliberately separate from product code. `prototype.mjs` accepts trusted test vectors; the product integration must additionally enforce current factory origin and unshared exact typed-array ownership before marshaling.

The runner accepts explicit repository, fixture directory, native module and dictionary. It verifies locked archive SHA-256, source-bound parser WASM, and the prototype source/module manifest. The native parser supplies actual scores, canonical IDs, and encoded content lengths. Resolved persisted offsets are reconstructed consecutively above 2^40, without compression or global deduplication. This is a component screen, not an end-to-end import result.

```sh
node screen.mjs --repository /path/to/manabitan --cache-dir /path/to/fixtures --wasm /path/to/record-fields.wasm --dictionary jmdict --parser-workers 3 --pairs 6 --repetitions 8 --out /path/to/jmdict.json
```

One production-shaped group is parsed and retained at a time. The output preserves every alternating A/B observation and same-code control pair, with compilation, instantiation, and each group's first invocation recorded separately. Exact byte parity is checked outside timing. Use `--bank-limit 1 --pairs 1 --repetitions 1` for a bounded setup check. Full dictionary campaigns should run on a dedicated hosted runner.

Native scratch is private, reused, capped at 8 MiB and returned output always copied to owned JavaScript bytes. Current admission bounds are 262,144 rows/unique definitions and 1,024 distinct scores. These are implementation limits only; every refusal retains the original encoder.

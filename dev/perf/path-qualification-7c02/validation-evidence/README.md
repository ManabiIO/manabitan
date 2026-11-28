# Local image-path candidate validation evidence

This package preserves local correctness and build validation for runtime
candidate `a8194e107c741dc1fd7e38cd9602e1aaacfc95ee`. Validation used
**Node 24.22.3**. Hosted Node 22, browser import, performance, and memory
qualification are separate; this package establishes none of those results.

The two runtime files remained byte-identical throughout these checks. Only
test JSDoc and whitespace changed after the first lint attempt. Exact runtime,
test, parser-WASM, manifest, and package-lock hashes are in
[source-hashes.json](source-hashes.json). Both versions of the test source are
preserved, together with the original Acorn executable-AST equivalence receipt.
The initial generic AST serializer's BigInt setup failure is recorded in that
receipt; packaging did not rerun the AST comparison.

## Results and retained failures

- Scoped ESLint initially failed on seven test documentation/formatting errors.
  After the test-only repair, the same scoped check passed.
- Main and test TypeScript checks passed.
- The complete unit invocation with `--maxWorkers=2` exited **1**: **15,138
  tests and 667 suites passed**; two native suites could not discover a WASM
  compiler, leaving 21 cases unexecuted. There were no assertion failures or
  test timeouts. The original report has 68 skipped tests, including those
  21 unexecuted cases.
- The first targeted native repair still failed discovery. The pinned Debian
  Clang driver invoked `wasm-ld-21`; the restored toolchain exposed `wasm-ld`,
  and the test helper did not consume `MANABITAN_WASM_LD`. The suppressed
  compiler error and exact driver invocation are retained.
- A private PATH alias to the verified pinned linker repaired discovery without
  modifying the shared toolchain. The two native suites then passed all
  **21 tests** using Clang/LLD 21.1.8.
- Combined unique coverage is **15,159 passing tests, 47 inherited skips, and
  all 669 suites executed successfully across attempts**. This does not
  relabel the original failed full invocation as a clean full-suite pass.
- The first all-target dry build failed before target builds because the
  repository refuses a symlinked `ext/lib` output directory. After replacing
  only this validation checkout's generated-output symlink with a real
  directory, the dry build passed all seven configured targets: Chrome,
  Chrome dev, Chrome Playwright, Firefox, Firefox dev, Firefox Android, and
  Edge.

The exact consolidated summary is preserved without modification at
[receipts/validation-summary.json](receipts/validation-summary.json). Original
absolute paths inside receipts are provenance from the local acquisition;
`sourceRelativePath` in the manifest maps each original file to this package.
No check was rerun while creating this package.

The package also retains the contemporaneous browser-availability failure
and immutable VNDB archive-restoration receipts referenced by the original
summary. These are environment records, not browser observations or timing
results. No missing browser qualification is imputed as a pass.

## Complete logs and integrity

Every complete unit, native-repair, dry-build, scoped-lint, TypeScript, and
compiler-discovery log is included as deterministic gzip. Empty successful
TypeScript logs are included as well. Compression uses level 9, a zero mtime,
and no original filename. The manifest records compressed and uncompressed
SHA-256, byte size, and uncompressed line count for every log.

`manifest.json` inventories every payload, including this README and the
portable verifier. `verification.json` records the packaging verification.
The manifest and verification receipt are excluded from their own inventory
to avoid self-referential hashes. The manifest hash is in the verification
receipt. No original evidence file was rewritten.

Run `python3 verify.py` from any directory to verify inventory, gzip headers,
complete expanded log hashes and counts, receipt/source consistency, unit
coverage arithmetic, the seven dry-build targets, and the preserved style
source hashes. The verifier does not execute tests, rebuild code, contact the
network, or repeat the AST comparison. During packaging it was additionally
run with `--source` pointing to the original evidence directory, confirming
every copied receipt and expanded log against its acquisition bytes.

# Combined-runtime correctness and layout witnesses

`integration-receipt.json` records the exact combined tree, source hashes, commands, test result, and build result:

- Base: `1e235059a4c05c2509e8757fccba43a2d60222df`.
- Local integration commit: `8a9cc4360c32f4bf0ba0d1004905acec28ae1c41`.
- Tree: `0fd0a2a237b66eb95061d3072d07d2c432abe1a5`.
- **21 focused test files, 782 tests passed**, followed by a successful all-target dry-run build.

The exact temporary `dictionary-importer-owned-shared-media.review.test.js` witness and its derivation record are preserved. The witness exercises every frozen pooled image-diagnostic test with owned shared content and checks the returned backing type. It was removed from the product worktree after testing and is absent from the committed tree.

## Reproduce the integration check

`reproduction.patch` is a packaging-time, full-index Git diff between the recorded base and integration commit. It is derived from committed source; the original test receipts are unchanged. It makes the integration source reproducible even if the local commit ID has not been published as a Git ref.

Create a fresh checkout at the base above, apply the patch to the index, and check the resulting tree:

```sh
evidence=/absolute/path/to/round2-component-evidence
checkout=/absolute/path/to/fresh-integration-checkout
git -C "$checkout" apply --index "$evidence/integration/reproduction.patch"
git -C "$checkout" write-tree
# Expected: 0fd0a2a237b66eb95061d3072d07d2c432abe1a5
```

Use Node 22.22.0, the locked `npm ci`, generated `npm run build:libs` assets, and clang/LLD 21.1.8. Configure `MANABITAN_CLANG` and `MANABITAN_WASM_LD` for that toolchain. Copy the temporary witness into `test/`, execute the exact `validation.testCommand` array from `integration-receipt.json` with `NODE_OPTIONS=--max-old-space-size=1536`, then remove the temporary witness. Execute the receipt's `validation.buildCommand` in the same checkout. These are ordinary correctness/build commands, not timing runs.

For example, after environment setup:

```sh
cp "$evidence/integration/dictionary-importer-owned-shared-media.review.test.js" \
    "$checkout/test/dictionary-importer-owned-shared-media.review.test.js"
python3 - "$evidence/integration/integration-receipt.json" "$checkout" <<'PY'
import json, os, pathlib, subprocess, sys
receipt = json.loads(pathlib.Path(sys.argv[1]).read_text())
checkout = pathlib.Path(sys.argv[2])
environment = {**os.environ, 'NODE_OPTIONS': '--max-old-space-size=1536'}
try:
    subprocess.run(receipt['validation']['testCommand'], cwd=checkout, env=environment, check=True)
finally:
    (checkout / 'test/dictionary-importer-owned-shared-media.review.test.js').unlink()
subprocess.run(receipt['validation']['buildCommand'], cwd=checkout, env=environment, check=True)
PY
```

## Reserved-layout correctness witness

`reserved-layout-witness.mjs` uses actual pinned Jitendex banks 1, 110 and 218, the native parser and real Zstd, and unchanged initial reservation admission. It checks **4,534 distinct spans across 5,448 rows**. Every compressed block and decoded content span matched after source overwrite and cache invalidation; physical reference-prefix/reference-suffix placement differs. The original per-span JSON is preserved losslessly in `reserved-layout-witness.json.gz`, with both compressed and original hashes in `reserved-layout-witness-file-identity.json`.

This is a correctness-only explanation for a possible offset difference. **It does not clear the hosted browser digest failure or prove that failure was offset-only.** Actual full semantic output/readback qualification is still a separate requirement.

To regenerate the witness, first regenerate the CRC sample inputs using `../crc/prepare-reproduction.py`, then use the integration checkout and a fresh output path:

```sh
NODE_OPTIONS=--max-old-space-size=1536 node \
    "$evidence/integration/reserved-layout-witness.mjs" \
    "$checkout" "$crc_output/inputs.reproduced.json" \
    /absolute/path/to/new-layout-witness.json
```

The harness checks parser Wasm and bank hashes and records all runtime/library source hashes. It performs no timing campaign. The original JSON records the original CRC-input path/hash; relocated inputs preserve the underlying sample identities while correctly producing a different inputs-manifest hash.

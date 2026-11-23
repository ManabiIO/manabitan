# Consecutive content-reference validation experiment

Published runtime candidate: `6a558cb4d48e781418a37cf27637c428fb929712`, based on develop `5e1f8c12f7ff798ba407323aff675cb23b22af02`. The local measured commit is `61b3db4caa76a8d6af2af147d88d0dc85a6f356a`; the parent published the same tree, and the runtime source hash below identifies the exact measured file.

The candidate validates each consecutive run of the same resolved content ID once inside the existing synchronous shard-planning traversal. It still reads every row's content ID, encodes every term, and reselects/revalidates the columns after every awaited append. Fixed-span overrides, malformed shapes, accessor-backed or untyped columns, typed subclasses, and shared buffers use the original per-row validation path.

## Scope

This is a component experiment, not a full import benchmark. Inputs preserve the native parser's actual row-to-content IDs, scores, sequence values, strings, and prepared lookup indexes from every pinned term bank. Offsets are translated raw content-slab offsets; they are not offsets measured from compressed persistent storage. The fixtures use the unmodified production grouping planner with `navigator.hardwareConcurrency = 9`, no device-memory hint, and its resulting five-worker policy, then parse those groups sequentially.

The oracle invokes the real record encoder for every row and hashes all emitted record-field bytes, lookup bytes, segment counts, record IDs, offset bases, and formats. Encoding and append are stubbed only during timing, which measures the synchronous validation counter and enclosing planning wall time. It does not measure OPFS writes, media work, persistent restart, compression, or full import completion.

## Measured source and fixtures

| Item | SHA-256 |
| --- | --- |
| Baseline `term-record-opfs-store.js` | `564fe2c4449a98f6d761950bc6664842565e3d7d0e0bb4778d9025719b273701` |
| Candidate `term-record-opfs-store.js` | `355f1b5011e6aa9d785daffe12e1460af291e19de3dfbb5fdb7245199be11ef0` |
| Parser JS used to prepare fixtures | `fe17c565339b27701f75af881b14da2347dd80aa9273fd9f4cec34c0220b1e23` |
| Parser Wasm | `cc749c53fc32dfb28eefbd69f99868f8c303caa1a3f1354231516dfa5a6e1b0f` |
| Fixture lock from tooling `4e568fcde29fb93df9a856eab5d177b741d99bce` | `9c0698d7b16e282f51823ea9b85b3fd5b809ebcb84e7a3ced49127b032cc3573` |

All three archives are size-checked and SHA-256-checked against that lock before parsing. Original manifests record archive identities, each prepared group's banks and row count, prepared lookup keys, and the serialized fixture hash. The capture was run on Node `v24.22.3`.

## Results

| Corpus | Rows | Validation runs | Repeated span validations eliminated | Baseline median validation | Candidate median validation | Median paired change | Faster pairs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| JMdict | 526,942 | 517,833 | 9,109 (1.729%) | 8.55 ms | 7.36 ms | -12.17% | 8/12 |
| Jitendex | 435,448 | 363,908 | 71,540 (16.429%) | 7.98 ms | 5.60 ms | -26.95% | 8/12 |
| VNDB | 6,648,310 | 158,009 | 6,490,301 (97.623%) | 98.64 ms | 11.75 ms | -87.89% | 12/12 |

The work counts apply to these captured native groups and their production prepared-index boundaries. All 7,610,700 rows produced identical complete record-field and lookup-byte digests. The short JMdict and Jitendex timings have substantial noise; the receipts retain all observations and ranges. Full browser import, memory/storage, and restart qualification remains separate.

## Reproduction

Use Node `v24.22.3` for the closest reproduction. Prepare checkouts for the baseline, runtime candidate, and pinned fixture-lock commit above. Each source checkout needs its locked dependencies and generated `ext/lib` assets (`npm ci`, then `npm run build:libs`). The fixture checkout needs its locked dependencies to resolve `@zip.js/zip.js`. Place the verified archives at:

```text
<fixture-checkout>/builds/e2e-dictionary-cache/JMdict.zip
<fixture-checkout>/builds/e2e-dictionary-cache/jitendex-yomitan.zip
<fixture-checkout>/builds/e2e-dictionary-cache/vndb_characters_by_bee.zip
```

Set these paths to the local checkouts and this evidence directory. The runners do not contain hardcoded local paths and can live outside the repository:

```sh
study=/absolute/path/to/validation-run-study
baseline=/absolute/path/to/baseline-checkout
candidate=/absolute/path/to/candidate-checkout
fixtures=/absolute/path/to/fixture-checkout

for dictionary in jmdict jitendex vndb; do
    NODE_OPTIONS=--max-old-space-size=1536 node --expose-gc \
        "$study/prepare-inputs.mjs" "$dictionary" "$baseline" \
        "$study/reproduced-$dictionary" "$fixtures"
    NODE_OPTIONS=--max-old-space-size=1536 node --expose-gc \
        "$study/compare-validation.mjs" "$study/reproduced-$dictionary" \
        "$baseline" "$candidate" "$study/reproduced-$dictionary-comparison.json"
done
```

Run the timing on an otherwise idle host. Each process performs both full-row byte oracles first, four warmup passes per arm, then 12 alternating AB/BA pairs with five corpus repetitions per observation. GC runs outside timed arms. Raw results preserve every observation; no outliers are excluded.

The `.v8` files are reproducible intermediate inputs and need not be published. Preserve the runners, original `*-comparison.json` receipts, and each original corpus `manifest.json`. Serialized fixture hashes can depend on the Node/V8 version; output bytes/counts and source/fixture identities are the substantive oracle. Absolute checkout paths in the original receipts are provenance, not runner requirements.

Verify all original receipt arithmetic, runner hashes, full-row oracle matches, and the current candidate source file with:

```sh
node "$study/verify-receipts.mjs" "$study" "$candidate"
```

The runtime candidate also passed 219 focused unit tests, scoped ESLint, main TypeScript, and test TypeScript locally. Full unit/build/browser gates are handled separately in the published candidate's qualification.

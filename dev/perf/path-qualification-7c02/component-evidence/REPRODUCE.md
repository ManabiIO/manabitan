# Reproduce the component in a fresh study directory

The saved-data verification in `verify-evidence.py` is sufficient to recompute every reported comparison without a benchmark. A new runtime experiment requires a fresh study and must preserve this complete cohort unchanged. A new result is independent evidence, not a replacement observation.

## Exact source prerequisites

Use a clean baseline checkout at `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`, its exact package lock, and the checked source-bound parser WASM. Prepare its dependencies and generated libraries using the repository's build instructions. The original component used Node 24.22.3, native parser SHA-256 `8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee`, and the production planner with `hardwareConcurrency=4` and `deviceMemory=8`.

Provide the candidate source tree containing parser SHA-256 `69f6f44bb25b1ade2e77ad51a5c830ac359ec3d44f364a3c0ed6131728f54518` and worker SHA-256 `b368f85dc737f4cd2567fa1723e69f3276f6f8c0441085af3b94ac80ed2a0057`. The original driver checks these exact bytes, the baseline runtime, fixture lock, and census before and after its work. The candidate and baseline runtime identities are fully listed in `frozen-inputs.json`.

Place the locked VNDB archive in the baseline checkout's `builds/e2e-dictionary-cache/vndb_characters_by_bee.zip` path. Its size is 291,705,969 bytes and SHA-256 is `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`. The capture independently checks the lock, archive size, and full archive hash before parsing.

## Layout

Create a new study directory with these files:

```text
STUDY/path-component/path-component.mjs
STUDY/path-component/capture-worker.mjs
STUDY/path-component/benchmark-plan.md
STUDY/reserved-envelope/vndb-dense/manifest.json
```

Copy the two unchanged `.mjs` files from `reproduction/` and the unchanged plan from this bundle. Decompress `baseline-planner-census.json.gz` into the listed census path and verify its SHA-256. Do not copy the historical `frozen-inputs.json` into this fresh run directory: it intentionally binds the old absolute paths and must remain unchanged in the evidence bundle.

The baseline and candidate source roots, new fixture directory, and output report are positional arguments. For example, with task-specific shell variables pointing to those directories:

```bash
node --expose-gc "$PATH_STUDY_ROOT/path-component/path-component.mjs" freeze "$PATH_BASE_ROOT" "$PATH_CANDIDATE_ROOT" "$PATH_STUDY_ROOT/fixtures-vndb" "$PATH_STUDY_ROOT/path-component/frozen-inputs.json"
node --expose-gc "$PATH_STUDY_ROOT/path-component/path-component.mjs" capture "$PATH_BASE_ROOT" "$PATH_CANDIDATE_ROOT" "$PATH_STUDY_ROOT/fixtures-vndb" "$PATH_STUDY_ROOT/fixtures-vndb/manifest.json"
node --expose-gc "$PATH_STUDY_ROOT/path-component/path-component.mjs" run "$PATH_BASE_ROOT" "$PATH_CANDIDATE_ROOT" "$PATH_STUDY_ROOT/fixtures-vndb" "$PATH_STUDY_ROOT/component-result.json"
```

The freeze step creates test-only probe/observer modules adjacent to the baseline parser, with unchanged production sources. The capture uses the full production planner, dense directory, actual parser workers, and source-bound native projector. It requires all 6,648,310 rows and 170 original planner groups, verifies every accepted projection against the already-copied baseline output, and records actual media/projection counts. The run step requires a successful complete capture, restores one native source group at a time, checks overlapping raw spans, and uses the fixed six counterbalanced A/B/C blocks and original gates.

These commands are documentation only; bundling this evidence did not execute them. A new capture may use different native source addresses, compression-container bytes, or callback completion order. Its own frozen identities and complete oracles must pass; do not silently substitute it for the exact original fixture manifest. Keep all new failures and partial receipts, and do not overwrite this original evidence or selectively replace observations.

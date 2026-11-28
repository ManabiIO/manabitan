# Hosted complete path-copy correctness oracle

Prepared for review only. No workflow or files in this package have been published by the profiling agent. No new local corpus acquisition is authorized by this package.

## Source and environment

Use a separate push-only research branch with the exact path-batching candidate runtime already reviewed. The job checks out the complete branch, records and verifies its commit, and creates a detached baseline worktree at `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.

- Baseline parser SHA-256: `31854cfb3d20ba60b701ec31cf19de26bd55cc745cc4f998cb33f0554ec83cca`.
- Candidate parser SHA-256: `69f6f44bb25b1ade2e77ad51a5c830ac359ec3d44f364a3c0ed6131728f54518`.
- Candidate worker SHA-256: `b368f85dc737f4cd2567fa1723e69f3276f6f8c0441085af3b94ac80ed2a0057`.
- Unchanged parser WASM SHA-256: `8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee`.
- Node 22.22.0 on a dedicated Ubuntu 26.04 runner.
- Exact package lock via `npm ci`. Baseline `build:libs` validates native source/manifest/module identities before copying the checked artifacts; no compiler or new native binary is needed for this JS-only correctness comparison.

The candidate source tree must have no additional production-JS change beyond the two frozen parser/worker files. Runtime source hashes, helper/driver/package/reference hashes, lock identity, and baseline source identity are rechecked after the complete oracle.

## Complete input and fixed comparison

Download only the locked 291,705,969-byte VNDB archive, SHA-256 `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`. Verify its complete size/hash and fixture-lock hash before parsing. The bundled immutable reference manifest is the successful complete source-bound path capture: SHA-256 `810c067eabf70271a5440775751420ce065e3bfc1ce2a47bfd2cb61c4876a8a2`.

Use ordinary persistent parser workers. The production dense directory, source pipeline, byte-balanced planner, and worker parse options remain unchanged. The source-byte threshold enables exact lookup routes as in the real VNDB importer. The actual candidate worker/parser pair runs together, with one before-copy and one after-copy observer hook.

For every group, snapshot all raw JSON and semantic input columns plus native heap/buffer identity before the actual batched copy. Afterward:

1. Verify input bytes, semantic columns, and native state are unchanged.
2. Compare every output value and byte with the frozen baseline copy helper.
3. Compare every object/view/buffer alias relationship, including zero-byte views, with the candidate module's public unbatched copy. Traverse the original root and original byte views without substituting objects. Hash only the declared live region of the exact `contentBytesBuffer` view while retaining its full original offset/length and backing identity; never hash that view's unused heap slack. The bundled source proof establishes that its false branch folds to the baseline body for the actual native plain-array inputs.
4. Require exactly one prepared index and one prepared route for every group, and exactly 170 of each in the complete aggregate. Verify the complete projected path digest against the independent reference manifest.

Every one of the 170 original planner groups, all 6,648,310 rows, and all 146,725 group-local media rows must pass. All group file lists and compressed-source sizes must match the independently completed acquisition. Retain complete group receipts and a final manifest with a tagged JSON receipt in the workflow log.

This is untimed correctness work. It does not establish import, enclosing-copy, scheduling, or memory gains. No media-file payload check is substituted for the separate full-media browser validation in the qualification campaign.

## Prepublication review and smoke

The hosted-only helper was tightened after review to traverse the original graph instead of a shallow replacement root, retain the full content view's original identity and metadata, and require nonzero exact route counts. The older local v2 helper and all prior receipts remain unchanged. Eight targeted graph checks and two two-row real-WASM groups passed on local Node 24.22.3, including both private and shared content-copy modes, strict same-module aliases, frozen-baseline bytes, and one prepared route per group. This smoke validates the revised oracle seam only; the complete hosted check still requires the pinned Node 22 runner and all 170 production groups.

## Prior attempts remain separate

The original cross-module alias failure is retained, together with the real-WASM diagnosis showing the module-local empty-singleton difference. A later ordinary-worker local run was killed after 135 successful groups; a fresh-worker transport attempt was killed after 79 groups. A startup-only invalid-execArgv failure ran zero groups. None supplies a complete oracle, and no partial group is reused here.

The previously suggested settled-slot retention explanation was retracted: frozen 9e10 explicitly clears `result.chunk` and `result.consume` before its sink callback. The local terminations remain unclassified host/adapter resource failures. This job returns to ordinary worker lifetimes on a separate runner; it does not claim a proven memory repair.

## Publication mapping

Place `workflow.yml` at `.github/workflows/path-copy-oracle-7c02.yml`. Place every other package file under `dev/perf/path-copy-oracle-7c02/`, including an identical copy of `workflow.yml` so its bytes remain covered by the immutable package manifest. Publish only after root review, to `research/parser-path-copy-oracle-20261128-7c02`; no PR is needed for this study.

One job runs once. Failure or termination preserves partial artifacts and supplies no complete result. The workflow has `contents: read`, never modifies the remote repository, and uploads all successful or failed evidence for 14 days.

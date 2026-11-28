# Compact score validation restoration: durable evidence

This bundle supports the two-line restoration of indexed `Uint16Array`
score-key validation in `parseCompactRecordFields`. It is a component result:
the observed warm validator saves approximately 1.57–1.60 ms for one traversal
of all 12 captured JMdict field buffers. It does not establish a complete
sidecar, browser import, storage or memory improvement.

## Frozen identities and findings

- Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
- Candidate runtime SHA-256:
  `63942c3dc97eab215293bf04a138844d505605386bc61322b3f2f29e20d1d769`.
- Published trial: `915268441352c3c7aa50fc0fbd44f73f5a826d79`.
- JMdict fixture: 528,299 rows, 53 banks, ZIP SHA-256
  `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`.
- Actual captured fields: 12 buffers / 4,239,960 bytes. They are included.
- Direct probe: 24 balanced A/B/C blocks, eight traversals per observation,
  two excluded warmup triplets. Arm medians are A 2.5594 ms, B 0.9852 ms,
  C 2.5867 ms per captured corpus; B beats A in 23/24 and C in 24/24 blocks.
  The paired same-code C/A median is +0.88457%.

The complete local public-sink comparison is also retained, including both
warmups and all eight opposite-order pairs. Its apparent overall improvement
is not attributable to this loop: owning record phases are flat while unchanged
parser, inflation and compression phases move. It remains inconclusive.

Local complete validation passed 669 suites, 15,135 tests, 47 source-accounted
conditional skips, all target dry builds, scoped lint, main types and test
types. Earlier missing-prerequisite/compiler failures are retained. Hosted
run 46106456744 passed its exact-head validation job, including pinned native
reproduction; its three browser comparison jobs were queued in the archived
API receipt. This bundle contains no completed browser qualification claim.

## Included material

Original workspace-relative paths and every existing file's bytes are
preserved. The external `.manifest.json` lists **every archive member** with
SHA-256 and byte count and binds the complete `.tar.gz`; it is external to avoid
a circular self-hash exception. Tar ownership/timestamps and the gzip timestamp
are normalized. The accompanying `.sha256` binds both archive and manifest.

The payload includes source snapshots, the exact loop diff, existing boundary
tests, capture and timing scripts, their Node boundary adapters, all numeric
inputs, all direct observations, all enclosing sink observations and logs,
failed attempts, source/history/claim reviews, full local validation receipts,
fixture/dependency locks and hosted status receipts. The initial score-cache
experiment is a separate mechanism and is not included here.

Omitted: dictionary ZIPs, node_modules, compiler distributions, generated
extension packages and full OPFS database files. Exact source/fixture locks,
stored-file digests and byte sizes are retained. Reconstructing the full capture
requires the pinned ZIP and a baseline checkout; the direct numeric validator
probe does not require downloading the dictionary. The Node public-sink shim
does not emulate native browser SyncAccessHandle durability or SQLite
publication.

## Verify the archive

Use the retained packager after extraction, or inspect the JSON independently:

```sh
python3 evidence/durable-bundles/package-evidence.py \
  --verify-manifest /absolute/path/score-restoration-evidence-20261128-1b47.manifest.json
```

Verification checks the archive hash, exact member set, sizes and every member
digest without extracting files. The manifest's source hashes also bind the
baseline and restored runtime snapshots.

## Reproduce in a fresh workspace

Keep the extracted evidence read-only. Set `BUNDLE` to its root, `REPLAY` to a
new workspace, and `FIXTURES` to a directory containing the locked JMdict ZIP.
The examples below do not overwrite archived observations. Use the recorded
Node 24.22.3 for like-runtime component comparisons; timings remain host-specific.

```sh
git clone https://github.com/ManabiIO/manabitan.git "$REPLAY/manabitan"
git -C "$REPLAY/manabitan" checkout --detach 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2
git -C "$REPLAY/manabitan" worktree add --detach "$REPLAY/score-validation-experiment" 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2
cp "$BUNDLE/score-validation-experiment/ext/js/dictionary/term-record-opfs-store.js" "$REPLAY/score-validation-experiment/ext/js/dictionary/term-record-opfs-store.js"
```

Install the pinned package lock with `npm ci` in each checkout, then run
`npm run build:libs`. Use a private ordinary `ext/lib` directory for each
checkout. If native reproduction is required, install Clang/LLD 21.1.8 and set
`MANABITAN_CLANG` / `MANABITAN_WASM_LD` to the actual executables; the recorded
portable wrapper locates its bundle relatively and must not be moved alone.

The direct probe reads archived actual inputs and checks the exact two-line
source difference before creating source-derived diagnostic modules:

```sh
node "$BUNDLE/evidence/score-validator-real-input-probe.mjs" \
  "$REPLAY/manabitan" "$REPLAY/score-validation-experiment" \
  "$BUNDLE/evidence/score-validation/fields" "$REPLAY/new-validator-probe.json"
```

To recapture the original numeric inputs from the complete unchanged public
sink, choose new output locations:

```sh
MANABITAN_SCORE_CAPTURE_DIR="$REPLAY/new-fields" \
node "$BUNDLE/evidence/node-score-capture-replay.mjs" \
  "$REPLAY/manabitan" "$FIXTURES" "$REPLAY/new-baseline-capture.json" jmdict 0 1
```

The fixture hash, source digest, 12 field hashes and all persisted-file digests
must match the archived manifest. Capture timings are not benchmark results.
The candidate correctness replay can use `node-score-verify-replay.mjs` with
the same arguments and a new result path. The original eight-pair runner is
retained unmodified; it expects sibling `manabitan` and
`score-validation-experiment` checkouts, a fresh output directory, and the
fixture path `/tmp/manabitan-1b47-fixtures`. If reproducing it elsewhere, change
only those locations in a separate copy and retain that copy's source hash.

Full validation commands and original failure/correction receipts are under
`evidence/score-validation/full-validation`. The captured measured source
stayed fixed throughout those prerequisite corrections.

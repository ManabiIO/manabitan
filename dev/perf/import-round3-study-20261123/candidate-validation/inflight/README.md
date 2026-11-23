# JMdict in-flight source registration study

This is a component study of one synchronous validation loop. It supports removing repeated checks from the normal typed reservation path. It does **not** establish a whole-import speedup, a memory reduction, or a regression result for Jitendex or VNDB. The candidate remains a draft pending a fixed hosted import comparison.

## Observations

The locked JMdict archive contains 526,942 rows in 53 term banks. The unmodified production planner, with `navigator.hardwareConcurrency = 9` and `deviceMemory` unavailable, creates 20 groups. The native parser emits 365,184 unique definitions across those independently resolved groups.

The component replay retains all 24 observations in their recorded order: four warmups, two A/A control pairs, and eight order-balanced A/B pairs. Each observation repeats all registration calls 20 times. All eight candidate pairs were faster; the median paired elapsed change was −71.176%, and the median paired CPU change was −68.807%. The A/A elapsed changes were +4.433% and −1.277%.

The absolute warmed Node cost was small: the median time for one corpus of registration calls was 5.232 ms in the baseline and 1.533 ms in the candidate. These figures exclude archive parsing, canonical resolution, compression, transfers, OPFS, and import wall time. Do not extrapolate their percentage to total import time.

The full parity receipt checks every one of the 365,184 resolved source lookups, containing 100,797,101 bytes, in three modes: baseline generic validation, current candidate fast validation, and current candidate generic validation using an unmarked copy of the span object. All offsets, lengths, source identities, complete byte digests, sorted bounds, and release states match. An untimed diagnostic counts 1,095,552 integer checks in each generic mode and 365,184 in the fast mode.

## What the optimization proves

The private WeakSet marks only objects constructed by the resolver. It does not cache a validation result. Registration still reads current own data descriptors, requires ordinary fixed typed metadata and an identical source/persisted length column, checks every current source bound and safe persisted offset, and requires strictly ascending offsets. The fast path is admitted only with no older active batch. Accessors, proxies, shared or resizable metadata, changed shapes, duplicate or nonascending offsets, and invalid values use the unchanged generic validator before any batch is published.

The source slab may be shared; its bounds are checked relative to the actual Uint8Array view. The metadata columns must be private and stable during the synchronous call. Tests cover malformed tails, sentinel values, safe-integer limits, zero and empty spans, nonzero view byte offsets, duplicate keys, active aliases, accessors, proxies, and mutation after an await.

## Source identity and post-screen correctness corrections

`source-identity.json` pins the baseline commit and both candidate source hashes. The timing receipt used `measured-runtime.patch` on baseline `5e1f8c12f7ff798ba407323aff675cb23b22af02`.

The first correction retains the native `ArrayBuffer.prototype.resizable` descriptor and calls `descriptor.get.call(buffer)`, instead of extracting the getter into an unbound variable. This satisfies the existing unbound-method lint rule. The intrinsic getter, receiver, admission policy, and row loop are unchanged. `lint-only-derivation.patch` preserves the exact two-line correction; `full-parity.json` checks that intermediate source.

Final review then found that optional admission must reject non-views before `instanceof` or prototype inspection. Otherwise, a replacement typed-array Proxy could run a `getPrototypeOf` trap before fallback and conceal malformed values. `guard-hardening.patch` records that ordering fix, and `full-parity-proxy-guard.json` retains its correctness result.

The final guard also uses the native TypedArray `@@toStringTag` getter to prove internal element kind, rather than inferring unsigned values from a mutable prototype. It checks exact prototypes before any `instanceof` traversal. Native ArrayBuffer capability getters distinguish private fixed storage from shared/resizable storage independently of altered buffer prototypes or shadow properties. `intrinsic-kind-hardening.patch` records this final correctness correction, with negative tests for forged signed-array prototypes and proxy prototype chains. Normal-view row checks and the row loop are unchanged. `candidate-runtime.patch` reconstructs the final checked source, and `full-parity-final.json` exhaustively checks it. The original timing receipt was retained unchanged and was not rerun after these correctness corrections. It is preliminary component evidence, not timing qualification of the final source. Hosted measurements must identify the checked source separately.

## Verify the retained evidence

Node v24.22.3 was used. This command verifies runner hashes, patch hashes, input-manifest identity, all observation ordering, every paired calculation, integer-check counts, and the exhaustive parity digests. It does not execute imports, benchmarks, or production modules, and it does not require the large generated inputs.

```sh
node verify-receipts.mjs
```

## Reproduce from source

Use Node v24.22.3 for the recorded V8 serialization format. Create new output directories; preserve the original receipts. The following assumes `EVIDENCE` is the absolute path of this evidence directory and `REPO` is an existing clone with the pinned baseline commit. All runner paths are arguments, so the package may live inside or outside the repository.

```sh
EVIDENCE="$(pwd)"
REPO=/absolute/path/to/manabitan
REPLAY_ROOT=/absolute/path/to/new-registration-replay
BASE="$REPLAY_ROOT/baseline"
MEASURED="$REPLAY_ROOT/measured"
CHECKED="$REPLAY_ROOT/checked"
OUTPUT="$REPLAY_ROOT/output"
mkdir -p "$REPLAY_ROOT" "$OUTPUT"

git -C "$REPO" worktree add --detach "$BASE" 5e1f8c12f7ff798ba407323aff675cb23b22af02
git -C "$REPO" worktree add --detach "$MEASURED" 5e1f8c12f7ff798ba407323aff675cb23b22af02
git -C "$REPO" worktree add --detach "$CHECKED" 5e1f8c12f7ff798ba407323aff675cb23b22af02
git -C "$MEASURED" apply "$EVIDENCE/measured-runtime.patch"
git -C "$CHECKED" apply "$EVIDENCE/candidate-runtime.patch"

(cd "$BASE" && npm ci && npm run build:libs)
ln -s "$BASE/node_modules" "$MEASURED/node_modules"
ln -s "$BASE/node_modules" "$CHECKED/node_modules"
mkdir -p "$MEASURED/ext/lib" "$CHECKED/ext/lib"
cp -a "$BASE/ext/lib/." "$MEASURED/ext/lib/"
cp -a "$BASE/ext/lib/." "$CHECKED/ext/lib/"
```

The shared dependencies and copied generated libraries are identical for these source variants. The native parser and canonical scanner modules must match the hashes in the input manifest; `build:libs` copies their pinned repository artifacts. No native compiler is needed for this study. Use real `ext/lib` directories: the build gate intentionally refuses a linked output directory. The first local dry-run encountered that setup check; `gates-before-build-setup.json` retains the failure, and `gates-final.json` records the passing rerun after copying the generated libraries, with unchanged source hashes.

Download the exact fixture from the baseline lock and verify it before use:

```sh
python3 - "$BASE" <<'PY'
import hashlib, json, pathlib, sys, urllib.request
base = pathlib.Path(sys.argv[1])
spec = json.loads((base / 'test/perf/dictionaries.lock.json').read_text())['dictionaries']['jmdict']
archive = base / 'builds/e2e-dictionary-cache' / spec['cacheFile']
archive.parent.mkdir(parents=True, exist_ok=True)
data = urllib.request.urlopen(spec['url']).read()
assert len(data) == spec['sizeBytes']
assert hashlib.sha256(data).hexdigest() == spec['sha256']
archive.write_bytes(data)
PY

NODE_OPTIONS=--max-old-space-size=1536 node --expose-gc "$EVIDENCE/prepare-inputs.mjs" jmdict "$BASE" "$OUTPUT/jmdict" "$BASE"
NODE_OPTIONS=--max-old-space-size=1536 node --expose-gc "$EVIDENCE/compare.mjs" "$BASE" "$MEASURED" "$OUTPUT/jmdict" "$OUTPUT/comparison.json"
NODE_OPTIONS=--max-old-space-size=1536 node --expose-gc "$EVIDENCE/verify-parity.mjs" "$BASE" "$CHECKED" "$OUTPUT/jmdict" "$OUTPUT/parity.json"
```

The generated `.v8` inputs occupy about 124 MiB and are intentionally excluded from the durable package. Their complete ordered hashes are retained in `jmdict/manifest.json`. They contain copied native columns and a compact source slab; each replay arm receives a private serialization buffer because Node may deserialize typed arrays as views of that buffer. The parser uses the real grouping plan but executes groups serially. The source slab is copied into a SharedArrayBuffer before resolution. Physical reference positions are modeled with the production 20-byte stride; the OPFS compressor and cross-group persisted deduplication are not reproduced.

A second capture was not run solely to assert byte-identical regeneration. Locator fields and measured timings naturally differ on another machine. The fixture hash, parser/module hashes, row and group counts, output digests, and per-group input identities provide the reproducibility checks. Keep all newly observed timings, including controls and failed guards, separate from the original receipt.

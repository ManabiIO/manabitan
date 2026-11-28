# Latest Jitendex/VNDB legacy read-context qualification

This is a separate, untimed helper derivative for the actual a300/#982 cold persisted-read path. It uses exact public parent `a300da36d00df8e353c5679b1528b50a1299b75f` and candidate `86cd5c18d325488b0ecb04c552d1dc83567de9d2`. All 42 runtime pins, locked fixtures, original parser/field/file/logical-metadata oracles and resource limits are unchanged.

## Why the boundary changed

The first latest-source run,46140311762, completed JMdict but both Jitendex arms failed at group4 and both VNDB arms at group11. A cold compressed-frame read now calls the unchanged production online-frame resolver, which validates the durable legacy root through SQLite even when the root is epoch0. The old scoped OPFS-only runner had no open SQLite connection. Every original artifact and failure is retained in `../20261128-4d9f-latest-metadata/attempt-1`.

The new attachment uses a real owned in-memory SQLite database and the exact ordinary generated SQLite module/WASM. It calls the production additive schema initializer and root seeder once, after both fresh OPFS stores prepare. It requires `legacy-root-v0`, epoch0, committed high-water0 and the normalized legacy manifest, with no snapshots, online caches/jobs, recovery, lifecycle teardown or unhealthy record state. The committed cursor is not reseeded as uncommitted legacy bytes grow.

No production reader, resolver, cache, codec, signature or byte-comparison function is replaced. Epoch0 still acquires no snapshot lease; real OPFS bounds/checksums, decompression and exact equality remain active. This small SQL schema is an unpublished read context; full dictionary SQLite publication, online layouts, UI/restart/lookup and browser memory/timing remain outside the census.

## Source preservation and gates

All15 original public fb9/a221 helper files are byte-identical. The new entry points are `run-with-legacy-context.mjs`, `launch-with-legacy-context.py` and `compare-results-with-legacy-context.mjs`, plus `legacy-import-read-context.mjs` and its contract file. The source transition receipt pins every original and added helper.

The fixed hosted workflow runs only Jitendex and VNDB. It explicitly selects Bash pipefail and requires a real exit37-through-tee negative control. Before importing either archive it verifies sources/assets/oracles, runs the26 unchanged helper contracts and runs14 real-SQLite/real-OPFS boundary contracts on each source arm. Controls include the original no-DB failure, cold exact reuse, same-hash/same-signature unequal bytes and ordered collisions, missing/inconsistent/malformed/online roots, corruption, stale read generation, closing/purging and foreign connection ownership.

Each corpus then gets one fresh A and one fresh B with the same 512MiB old-space limit, 512MiB temporary-space floor, 3GiB sampled RSS ceiling and20-minute child deadline. Actual sessions drain while workers and SQLite are alive; all workers join before the owned connection closes. The derived comparator enforces the complete original comparison plus every legacy-state and cleanup receipt.

JMdict is **not reacquired**. Its original latest-source12-group/528,299-row proof was independently revalidated from the original files and establishes exactly4MiB retained backing avoided. It is not relabeled as execution of this new helper. New Jitendex/VNDB claims require their own completed reports.

## Reproduction

Use the same exact Node v22.22.0 binary, clean source checkouts, locked `npm ci` and ordinary `npm run build:libs` documented in the adjacent original latest profile. Extract and hash-check the unchanged `verification-oracles.tar.gz` here using its member index. Acquire the locked archive by its declared URL, size and SHA256.

Set `META_HELPER`, `META_EVIDENCE`, `META_A`, `META_B`, `META_CACHE` and `META_OUTPUT` to absolute paths; `META_EVIDENCE` selects this directory and all output paths must be new. Run the unchanged three contract files, then run the new contract against each exact source:

```sh
MANABITAN_LEGACY_READ_SOURCE_ROOT="$META_A" \
MANABITAN_LEGACY_READ_SOURCE_COMMIT=a300da36d00df8e353c5679b1528b50a1299b75f \
  node --test "$META_HELPER/legacy-import-read-context.contract.mjs"

MANABITAN_LEGACY_READ_SOURCE_ROOT="$META_B" \
MANABITAN_LEGACY_READ_SOURCE_COMMIT=86cd5c18d325488b0ecb04c552d1dc83567de9d2 \
  node --test "$META_HELPER/legacy-import-read-context.contract.mjs"

python3 "$META_HELPER/launch-with-legacy-context.py" --node "$(command -v node)" \
  --source-root "$META_A" --source-id a300da36d00df8e353c5679b1528b50a1299b75f \
  --corpus jitendex --arm A --cache-dir "$META_CACHE" \
  --output "$META_OUTPUT/jitendex-A-1" --evidence-dir "$META_EVIDENCE" \
  --node-sha256 1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31

python3 "$META_HELPER/launch-with-legacy-context.py" --node "$(command -v node)" \
  --source-root "$META_B" --source-id 86cd5c18d325488b0ecb04c552d1dc83567de9d2 \
  --corpus jitendex --arm B --cache-dir "$META_CACHE" \
  --output "$META_OUTPUT/jitendex-B-1" --evidence-dir "$META_EVIDENCE" \
  --node-sha256 1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31

node "$META_HELPER/compare-results-with-legacy-context.mjs" \
  "$META_OUTPUT/jitendex-A-1" "$META_OUTPUT/jitendex-B-1" \
  "$META_OUTPUT/jitendex-comparison.json" --evidence-dir "$META_EVIDENCE"
```

Repeat only the fresh corpus pair with `vndb` and separate new output paths. Preserve every failed preflight, contract, acquisition and comparison. No oracle relaxation or automatic retry is part of this qualification.

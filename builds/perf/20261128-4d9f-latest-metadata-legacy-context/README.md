# Latest Jitendex/VNDB production-schema qualification

This is a separate, untimed helper derivative for the actual a300/#982 cold persisted-read path. It uses exact public parent `a300da36d00df8e353c5679b1528b50a1299b75f` and candidate `86cd5c18d325488b0ecb04c552d1dc83567de9d2`. All 42 runtime pins, locked fixtures, original parser/field/file/logical-metadata oracles and resource limits are unchanged.

## Why the boundary changed

The first latest-source run,46140311762, completed JMdict but both Jitendex arms failed at group4 and both VNDB arms at group11. A cold compressed-frame read now calls the unchanged production online-frame resolver, which validates the durable legacy root through SQLite even when the root is epoch0. The old scoped OPFS-only runner had no open SQLite connection. Every original artifact and failure is retained in `../20261128-4d9f-latest-metadata/attempt-1`.

The new attachment uses a real owned in-memory SQLite database and the exact ordinary generated SQLite module/WASM. It applies the normal production runtime pragmas and awaits the complete production `_initializeSchema()` once, after both fresh OPFS stores prepare. This creates the real glossary and health tables and registers the real terms virtual table; the initializer includes the same one-time legacy-root seed. It does not run destructive version-reset migrations. It requires `legacy-root-v0`, epoch0, committed high-water0 and the normalized legacy manifest, with no snapshots, online caches/jobs, recovery, lifecycle teardown or unhealthy record state. The committed cursor is not reseeded as uncommitted legacy bytes grow.

No production reader, resolver, cache, codec, signature or byte-comparison function is replaced. Epoch0 still acquires no snapshot lease; real OPFS bounds/checksums, decompression and exact equality remain active. This complete in-memory SQL schema is an unpublished term-sink/read context; full dictionary SQLite publication, online layouts, UI/restart/lookup and browser memory/timing remain outside the census.

The additive-only revision at `6eff7eeba7e94d80373448b890ccdd147ec78bb9` passed all14 cold-read controls but all four actual Jitendex/VNDB arms failed at public group0: `SQLite3Error: no such table: termGlossaryTokens`. Attaching a real database correctly enabled ordinary public glossary invalidation; the root-only setup had omitted its tables. Run46142163868 and both raw artifacts are retained in `attempt-1`. This revision uses the unchanged full production initializer and adds the missed nonempty public-sink control. It neither adds handcrafted tables nor bypasses invalidation.

## Source preservation and gates

All15 original public fb9/a221 helper files are byte-identical. The new entry points are `run-with-legacy-context.mjs`, `launch-with-legacy-context.py` and `compare-results-with-legacy-context.mjs`, plus `legacy-import-read-context.mjs` and its contract file. The source transition receipt pins every original and added helper.

The fixed hosted workflow runs only Jitendex and VNDB. It explicitly selects Bash pipefail and requires a real exit37-through-tee negative control. Before importing either archive it verifies sources/assets/oracles, builds ordinary tooling bundles, requires scoped ESLint on the four new JavaScript helpers, runs the26 unchanged helper contracts and runs15 real-SQLite/real-OPFS boundary contracts on each source arm. Controls include the original no-DB failure, cold exact reuse, same-hash/same-signature unequal bytes and ordered collisions, missing/inconsistent/malformed/online roots, corruption, stale read generation, closing/purging and foreign connection ownership. The new final control ingests a nonempty raw-v2 row through the public sink, exercises normal compression and cold exact reuse, then proves that ordinary glossary invalidation removes only the target dictionary's rows. Actual SQLite export hashes are recorded as diagnostics; root/epoch/high-water and user version are independently enforced.

Each corpus then gets one fresh A and one fresh B with the same 512MiB old-space limit, 512MiB temporary-space floor, 3GiB sampled RSS ceiling and20-minute child deadline. Actual sessions drain while workers and SQLite are alive; all workers join before the owned connection closes. The derived comparator enforces the complete original comparison plus every legacy-state and cleanup receipt.

JMdict is **not reacquired**. Its original latest-source12-group/528,299-row proof was independently revalidated from the original files and establishes exactly4MiB retained backing avoided. It is not relabeled as execution of this new helper. New Jitendex/VNDB claims require their own completed reports.

The first complete-schema freeze (`d4c3991`, run46143543189) stopped at scoped lint with11 helper errors, before the15 new controls or any corpus. Its26 unchanged controls and normal builds passed. Both exact raw artifacts are retained at `lint-attempt-1`. The narrow follow-up fixes formatting and records cleanup failures without replacing an original body error; cleanup-only failures remain fatal. No source/oracle/fixture/budget or production-schema behavior changes.

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

# Latest Jitendex/VNDB production-schema qualification

This is a separate, untimed helper derivative for the actual a300/#982 cold persisted-read path. It uses exact public parent `a300da36d00df8e353c5679b1528b50a1299b75f` and candidate `86cd5c18d325488b0ecb04c552d1dc83567de9d2`. All 42 runtime pins, locked fixtures, original parser/field/file/logical-metadata oracles and resource limits are unchanged.

## Why the boundary changed

The first latest-source run,46140311762, completed JMdict but both Jitendex arms failed at group 4 and both VNDB arms at group 11. A cold compressed-frame read now calls the unchanged production online-frame resolver, which validates the durable legacy root through SQLite even when the root is epoch 0. The old scoped OPFS-only runner had no open SQLite connection. Every original artifact and failure is retained in `../20261128-4d9f-latest-metadata/attempt-1`.

The new attachment uses a real owned in-memory SQLite database and the exact ordinary generated SQLite module/WASM. It applies the normal production runtime pragmas and awaits the complete production `_initializeSchema()` once, after both fresh OPFS stores prepare. This creates the real glossary and health tables and registers the real terms virtual table; the initializer includes the same one-time legacy-root seed. It does not run destructive version-reset migrations. It requires `legacy-root-v0`, epoch 0, committed high-water0 and the normalized legacy manifest, with no snapshots, online caches/jobs, recovery, lifecycle teardown or unhealthy record state. The committed cursor is not reseeded as uncommitted legacy bytes grow.

No production reader, resolver, cache, codec, signature or byte-comparison function is replaced. Epoch0 still acquires no snapshot lease; real OPFS bounds/checksums, decompression and exact equality remain active. This complete in-memory SQL schema is an unpublished term-sink/read context; full dictionary SQLite publication, online layouts, UI/restart/lookup and browser memory/timing remain outside the census.

The additive-only revision at `6eff7eeba7e94d80373448b890ccdd147ec78bb9` passed all 14 cold-read controls but all four actual Jitendex/VNDB arms failed at public group 0: `SQLite3Error: no such table: termGlossaryTokens`. Attaching a real database correctly enabled ordinary public glossary invalidation; the root-only setup had omitted its tables. Run 46142163868 and both raw artifacts are retained in `attempt-1`. This revision uses the unchanged full production initializer and adds the missed nonempty public-sink control. It neither adds handcrafted tables nor bypasses invalidation.

## Completed source-bound results

Run 46144729522 at exact tooling `8ec2c45d182dd7615317e1675197aadd494ae964` completed both fresh Jitendex and VNDB pairs. The strict workflow passed scoped lint, all 26 original helper controls and all 15 actual public-sink/cold-read controls on each source arm. Jitendex matched the original complete `16ea2af3…` oracle over 436,555 rows/22 groups and avoided4,194,304 bytes of retained metadata backing. VNDB matched `01aa55b3…` over 6,648,310 rows/170 groups and avoided1,048,576 bytes. Every actual state, drain, worker join, owned-connection close and ZIP/OPFS release receipt passed.

The raw ZIPs, full per-member SHA256 index and compact allocation summary are in `complete-schema-success`. The producer comparison JSON and all original A/B reports are retained inside the raw ZIPs; no producer report is rewritten. These are allocation/output proofs, not import-speed or whole-browser memory claims. JMdict remains the separately audited original latest-source 4 MiB observation; it is not reacquired or relabeled as this derivative.

An [independent read-only audit](independent-audit/README.md) then reopened both exact artifacts, verified all 42 source hashes per arm and 23 logical metadata columns, checked all 112 contract observations, and reran the frozen comparator against the original reports. It matched every original output oracle and retained the auditor's own initial wrapper-schema correction separately. No corpus was reacquired by the auditor and no producer report changed.

## Source preservation and gates

All15 original public fb9/a221 helper files are byte-identical. The new entry points are `run-with-legacy-context.mjs`, `launch-with-legacy-context.py` and `compare-results-with-legacy-context.mjs`, plus `legacy-import-read-context.mjs` and its contract file. The source transition receipt pins every original and added helper.

The fixed hosted workflow runs only Jitendex and VNDB. It explicitly selects Bash pipefail and requires a real exit37-through-tee negative control. Before importing either archive it verifies sources/assets/oracles, builds ordinary tooling bundles, requires scoped ESLint on the four new JavaScript helpers, runs the 26 unchanged helper contracts and runs15 real-SQLite/real-OPFS boundary contracts on each source arm. Controls include the original no-DB failure, cold exact reuse, same-hash/same-signature unequal bytes and ordered collisions, missing/inconsistent/malformed/online roots, corruption, stale read generation, closing/purging and foreign connection ownership. The new final control ingests a nonempty raw-v2 row through the public sink, exercises normal compression and cold exact reuse, then proves that ordinary glossary invalidation removes only the target dictionary's rows. Actual SQLite export hashes are recorded as diagnostics; root/epoch/high-water and user version are independently enforced.

Each corpus then gets one fresh A and one fresh B with the same 512 MiB old-space limit, 512 MiB temporary-space floor, 3 GiB sampled RSS ceiling and20-minute child deadline. Actual sessions drain while workers and SQLite are alive; all workers join before the owned connection closes. The derived comparator enforces the complete original comparison plus every legacy-state and cleanup receipt.

JMdict is **not reacquired**. Its original latest-source12-group/528,299-row proof was independently revalidated from the original files and establishes exactly4MiB retained backing avoided. It is not relabeled as execution of this new helper. New Jitendex/VNDB claims require their own completed reports.

The first complete-schema freeze (`d4c3991`, run 46143543189) stopped at scoped lint with11 helper errors, before the 15 new controls or any corpus. Its26 unchanged controls and normal builds passed. Both exact raw artifacts are retained at `lint-attempt-1`. The narrow follow-up fixes formatting and records cleanup failures without replacing an original body error; cleanup-only failures remain fatal. No source/oracle/fixture/budget or production-schema behavior changes.

The next control gate (`fbeefb1`, run 46143955956) passed scoped lint and the first14 parent controls, then rejected the public-sink fixture's premature resident `size` check. Prepared OPFS import writes intentionally do not cache appended records, and draining does not load persistent indexes. Candidate controls and corpus did not start. Both exact artifacts are retained at `public-sink-contract-attempt-1`. The corrected control calls the ordinary persistent dictionary loader and decodes the actual stored rows before asserting exact nonempty counts and IDs; no writer policy or expected row count is weakened.

The following gate (`8b4213d`, run 46144303709) passed the first authoritative row proof, then correctly rejected a second append to the record shard already finalized by the fixture. Candidate controls and corpus did not start; both artifacts are retained at `public-sink-contract-attempt-2`. The fixture now keeps one real record import session across both public chunks and finalizes it once, then loads and decodes both complete records. The content-only drain/cold-read boundary, exact duplicate/no-growth checks, ordinary glossary invalidation and all negative controls remain. No finalized-state reset or append-guard bypass is used.

## Reproduction

The complete standalone command wrapper is [reproduce-complete-schema.sh](reproduce-complete-schema.sh). It pins the executed tooling 8ec2c45, exact public sources and Node executable; the shell wrapper was syntax-checked, while its constituent commands are the hosted workflow commands. Use Linux x64 Node v22.22.0 on PATH and a fresh absolute directory per corpus:

```sh
bash reproduce-complete-schema.sh jitendex /absolute/new-metadata-jitendex
bash reproduce-complete-schema.sh vndb /absolute/new-metadata-vndb
```

The wrapper keeps every failed or successful output, runs the actual source/oracle/archive preflight and all gates, attempts both source arms, and compares only successful complete results.


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

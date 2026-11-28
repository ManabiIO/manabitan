# Current-base implicit metadata verification

Six fresh, complete corpus acquisitions passed on the exact current parent and candidate. They prove **4 MiB less retained metadata backing for JMdict, 4 MiB for Jitendex, and 1 MiB for VNDB**, with identical parser output, record fields, envelopes, normalized persisted files and independently reconstructed logical metadata. These are allocation and correctness results; no import-speed or browser-memory improvement is claimed.

| Corpus | Rows | Production groups | S1 backing avoided | Dictionary-name backing avoided | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | 528,299 | 12 | 2 MiB | 2 MiB | 4 MiB |
| Jitendex | 436,555 | 22 | 2 MiB | 2 MiB | 4 MiB |
| VNDB | 6,648,310 | 170 | 1 MiB | 0 | 1 MiB |

Every acquisition passed on its first attempt. JMdict and Jitendex keep both optional columns absent after every group. VNDB materializes its dictionary-name column in the second group, so only its measured S1 reduction is credited. The compact result is [`reports/current-corpus-summary.json`](reports/current-corpus-summary.json). Complete observations, commands, source receipts, group allocations, output hashes and the frozen executable helper are in `current-corpus-raw.tar.gz`; its 94 members are individually indexed in `current-corpus-raw-index.json`.

## Exact sources and public reproduction

The parent is `f28c2801fcfd9416f220b46b9cbafeee901c1cb2`. The acquisitions used local candidate `81e203e084c009e79057a36d0e2106ef669ab168` and helper `fb9d9612f34bdb002d846364ef089f25ed188b29`. The candidate is publicly available as [`68b29e5a959470e76ff67a93ec8b300cc53f1254`](https://github.com/ManabiIO/manabitan/commit/68b29e5a959470e76ff67a93ec8b300cc53f1254), with the **identical full Git tree** `167af1110023e4febad62921e13244b2c8bcb93c`. Its runtime `ext` tree is `9f19f03afba5eb6f2eedd32db813a206a8abee3d`. The repository publication receipt and manifest/protocol hashes are retained under [`reports/public-runtime-equivalence`](reports/public-runtime-equivalence).

Use the public commit for the frozen candidate checkout. The helper does not require the local `81e203e` Git object: it treats that identifier as a provenance label, checks the caller-supplied actual HEAD, checks that HEAD's complete runtime subtrees, and hashes every pinned runtime source and generated asset. Normal generated ZIP source-location comments receive only the already-declared 24-line normalization. All remaining runtime bytes must match. The public-equivalence receipt is a source inspection and publication-tree chain, not an additional executed public-checkout acquisition.

The later `172dfa0` test-only follow-up changes one JSDoc return annotation and leaves all runtime trees unchanged. Its exact patch and receipt are preserved under `reports/current-source-validation`; these acquisitions remain labeled `81e203e`, and final CI must cover that later test annotation.

The original `dcfc02a0`/`55e87bc` corpus proof remains separately in [`20261128-4d9f-signature1`](../20261128-4d9f-signature1), including its executable helper at `434855c`, fixed protocol and every observation. This current study independently repeats all three corpora against the newer parent; the old successes were not substituted for these six runs.

## Upstream representation and source changes

The current parent already contains the lazy Float64 record-ID column from #980, the indexed score-key validator from #978, physical reference prefetch from #976, and the in-flight producer witness. The exact four changed runtime paths between `dcfc02a0` and `f28c2801` are listed in `verification-manifest.json`; every complete source hash is pinned.

An empty `Float64Array` record-ID view means positive zero at every valid state-column index, including free entries and unused capacity. It is not a null-array sentinel. The independent decoder expands that representation to a fresh full-capacity Float64 column in **both** current arms. A physical full-capacity view remains unchanged, preserving signed zero and every source byte. The decoder neither calls a product getter/materializer nor mutates the source.

The physical upstream ID view and backing match in every A/B group and are excluded from this candidate's allocation total. The complete metadata property inventory must equal the retained logical oracle plus exactly the two candidate dictionary-name prefix scalars; unknown properties fail closed. All S1, prefix, field, envelope, file, source grouping and media-reference checks remain active. The complete logical output-oracle SHA256 values are unchanged:

- JMdict: `5a2d8167f046e313949af8005ed493b651d10a4de95bfc5a2de24699ec61a58e`
- Jitendex: `16ea2af33a07c79d163d5c16cc73276940a9d5ab46776c0b2d300d70514ae6ff`
- VNDB: `01aa55b3440a4bb5f6831a5e3c94eb20c2f7a672029824b00b31e3738043ea62`

## Reproduce from public source

Use three separate checkouts: the public parent, the frozen public candidate, and this PR's helper/evidence checkout. The last checkout supplies the helper and this evidence directory, so the public candidate commit does not need to contain later evidence files. Follow the common dependency and locked-archive setup in [`test/perf/signature1-corpus-verification`](../../../test/perf/signature1-corpus-verification): Node **22.22.0**, Python 3, `npm ci` and normal `npm run build:libs` in both runtime checkouts. The committed native assets are checked; native compilation is unnecessary for this replay.

Set these task-specific variables to absolute paths:

```sh
META_NODE=/path/to/node-v22.22.0/bin/node
META_PARENT_ROOT=/path/to/public-parent-checkout
META_CANDIDATE_ROOT=/path/to/public-candidate-checkout
META_HELPER_REPOSITORY=/path/to/this-pr-checkout
META_HELPER_ROOT="$META_HELPER_REPOSITORY/test/perf/signature1-corpus-verification"
META_CURRENT_EVIDENCE="$META_HELPER_REPOSITORY/builds/perf/20261128-4d9f-current-metadata"
META_CACHE=/path/to/locked-dictionary-archives
META_OUTPUT=/path/to/new-current-verification-results
```

Check the frozen public source identities and extract the complete oracle inputs:

```sh
set -e
test "$(git -C "$META_PARENT_ROOT" rev-parse HEAD)" = f28c2801fcfd9416f220b46b9cbafeee901c1cb2
test "$(git -C "$META_CANDIDATE_ROOT" rev-parse HEAD)" = 68b29e5a959470e76ff67a93ec8b300cc53f1254
test "$(git -C "$META_CANDIDATE_ROOT" rev-parse 'HEAD^{tree}')" = 167af1110023e4febad62921e13244b2c8bcb93c
tar -xzf "$META_CURRENT_EVIDENCE/verification-oracles.tar.gz" -C "$META_CURRENT_EVIDENCE"
```

Run the helper controls and complete pairs, always passing the current evidence directory explicitly:

```sh
"$META_NODE" --test \
    "$META_HELPER_ROOT/node-opfs-bounded.contract.mjs" \
    "$META_HELPER_ROOT/metadata-oracle.contract.mjs" \
    "$META_HELPER_ROOT/logical-record-ids.contract.mjs"

for corpus in jmdict jitendex vndb; do
    python3 "$META_HELPER_ROOT/launch.py" \
        --node "$META_NODE" \
        --source-root "$META_PARENT_ROOT" \
        --source-id "$(git -C "$META_PARENT_ROOT" rev-parse HEAD)" \
        --corpus "$corpus" --arm A --cache-dir "$META_CACHE" \
        --output "$META_OUTPUT/$corpus-A" --evidence-dir "$META_CURRENT_EVIDENCE"
    python3 "$META_HELPER_ROOT/launch.py" \
        --node "$META_NODE" \
        --source-root "$META_CANDIDATE_ROOT" \
        --source-id "$(git -C "$META_CANDIDATE_ROOT" rev-parse HEAD)" \
        --corpus "$corpus" --arm B --cache-dir "$META_CACHE" \
        --output "$META_OUTPUT/$corpus-B" --evidence-dir "$META_CURRENT_EVIDENCE"
    "$META_NODE" "$META_HELPER_ROOT/compare-results.mjs" \
        "$META_OUTPUT/$corpus-A" "$META_OUTPUT/$corpus-B" \
        "$META_OUTPUT/$corpus-comparison.json" --evidence-dir "$META_CURRENT_EVIDENCE"
done
```

Run sequentially with fresh output directories and stop on failure, preserving all failed acquisitions. The fixed 512 MiB Node old-space cap, 512 MiB temporary-space floor, 3 GiB sampled-RSS ceiling and 20-minute deadline are unchanged. The executable SHA256 is recorded and must match across arms; `--node-sha256 1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31` additionally enforces the recorded Linux x64 executable.

## Executed checks and boundaries

All **26 helper contracts** passed before the acquisitions. They include positive zero over the full capacity, physical signed zero, offset/backing accounting, rejection of null/wrong-width/wrong-size ID storage, explicit profile selection, unknown-property rejection, independent implicit-column decoding and bounded OPFS semantics. The first lint attempt's three helper-only style errors and the successful corrected lint/format checks remain in `reports/helper-validation`; no runtime source changed during that correction.

Separate current runtime validation records **318 focused tests**, main/dev/bench types, normal library build, all-target dry build, both real release packages, exact package-entry audit, and four CRC controls after correcting the pinned compiler environment. Local full-unit, test-type and final product-lint processes encountered the retained resource failures detailed in `reports/current-source-validation`; do not read those partial runs as passing gates. The complete 69-member source/validation archive is `validation-and-source-81e203e.tar.gz`, indexed by `current-source-validation-index.json`. Later hosted results and the test-comment follow-up belong to their own source receipts and PR checks.

The corpus replay covers sequential production-group term sinks and retained metadata backings. It does not qualify whole-browser latency, three-worker parser scheduling, process peak or settled memory, separate media-file persistence, settings UI, SQLite transactions, restart or lookup behavior. All raw observations and fixed protocols remain intact.

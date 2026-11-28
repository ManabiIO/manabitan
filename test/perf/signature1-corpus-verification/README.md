# Implicit metadata corpus verification

This helper verifies the complete term sink and logical canonical metadata for the pinned JMdict, Jitendex and VNDB archives. It records the actual native-arena, optional first-signature array, and optional dictionary-name array allocation separately. Every group records whether dictionary-name IDs remain a uniform prefix or have materialized. It is a correctness and allocation harness; its elapsed times and process RSS are not import-speed or browser-memory qualification.

The recorded results and input oracles live in [`builds/perf/20261128-4d9f-signature1`](../../../builds/perf/20261128-4d9f-signature1). The verification manifest pins the parent runtime at `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16` and the combined runtime at `55e87bc64c9b043a91f1d075f0324d3176c18c9a`. A later commit containing only helpers or evidence is accepted when its runtime source trees and every required asset still match those exact profiles.

## Prepare two checkouts

Use Node **22.22.0**, Python 3 and two separate source checkouts. Install the locked dependencies with `npm ci`, then run `npm run build:libs` in each checkout. Native compilation is unnecessary for this replay: the helper checks the committed native manifests and copied runtime WASM assets. Keep the parent checkout at the recorded parent runtime and use this PR's checkout for the candidate and helper.

Place the three archives listed in `test/perf/dictionaries.lock.json` in one cache directory. Use the exact lock-file URLs, sizes and SHA256 values. The runner validates every archive before parsing and never downloads or silently substitutes another release. Keep enough temporary storage for the complete VNDB index and bounded write snapshots; the run enforces a 512MiB free-space floor and a 3GiB sampled-RSS ceiling. Temporary files use the platform's temporary directory, including a caller-supplied `TMPDIR` when applicable.

The examples below use task-specific shell variables. Set them to absolute paths appropriate for your machine:

```sh
META_NODE=/path/to/node-v22.22.0/bin/node
META_PARENT_ROOT=/path/to/manabitan-parent
META_CANDIDATE_ROOT=/path/to/manabitan-candidate
META_HELPER_ROOT="$META_CANDIDATE_ROOT/test/perf/signature1-corpus-verification"
META_CACHE=/path/to/locked-dictionary-archives
META_OUTPUT=/path/to/new-verification-results
```

The complete recorded oracles are compressed to keep the PR diff readable. Expand the committed input archive once before running the helper:

```sh
tar -xzf "$META_CANDIDATE_ROOT/builds/perf/20261128-4d9f-signature1/verification-oracles.tar.gz" \
    -C "$META_CANDIDATE_ROOT/builds/perf/20261128-4d9f-signature1"
```

`verification-oracles-index.json` records the archive digest and every member's size/SHA256. The runner independently checks the extracted bytes against `verification-manifest.json` before use. No release ZIP or dictionary archive is included in this evidence archive.

## Run complete A/B verification

The Python launcher fixes the Node old-space cap at 512MiB and records the exact command, launch status, terminating signal, stdout and stderr. Output directories and sidecars must be new. A failed run is retained; choose a new name for any retry.

```sh
set -e
for corpus in jmdict jitendex vndb; do
    python3 "$META_HELPER_ROOT/launch.py" \
        --node "$META_NODE" \
        --source-root "$META_PARENT_ROOT" \
        --source-id "$(git -C "$META_PARENT_ROOT" rev-parse HEAD)" \
        --corpus "$corpus" --arm A \
        --cache-dir "$META_CACHE" \
        --output "$META_OUTPUT/$corpus-A"
    python3 "$META_HELPER_ROOT/launch.py" \
        --node "$META_NODE" \
        --source-root "$META_CANDIDATE_ROOT" \
        --source-id "$(git -C "$META_CANDIDATE_ROOT" rev-parse HEAD)" \
        --corpus "$corpus" --arm B \
        --cache-dir "$META_CACHE" \
        --output "$META_OUTPUT/$corpus-B"
    "$META_NODE" "$META_HELPER_ROOT/compare-results.mjs" \
        "$META_OUTPUT/$corpus-A" "$META_OUTPUT/$corpus-B" \
        "$META_OUTPUT/$corpus-comparison.json"
done
```

Run sequentially on an otherwise idle host. Each launcher has a 20-minute deadline. Stop and inspect a failure before continuing with further acquisitions. For an exact Linux x64 executable match with the recorded run, also pass `--node-sha256 1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31`. Otherwise the same Node version is required and the actual executable SHA256 is recorded; A/B comparison requires equal executable identities.

The helper locates the committed evidence relative to its own checkout. Use `--evidence-dir /absolute/copied/evidence` on both launch and comparison commands if the evidence was copied elsewhere. No developer-machine checkout, archive or output path is embedded in executable helper code.

## Verification boundaries

The replay uses the production compressed parser handler, dense ZIP catalog, source CRC/size validation, exact source grouping from a 4-core/8GiB capability policy, ordered public database sink, real codec workers, and the real import-index worker when the production size policy selects it. The parser transport adapter invokes the worker handler in-process and preserves structured-clone and borrowed-source lease behavior; it does not simulate three concurrent parser threads. The bounded filesystem OPFS adapter preserves committed visibility, lazy Blob snapshots and asynchronous fallback when synchronous access handles are unavailable.

Before the sink mutates a parser chunk, the runner hashes complete content spans, typed columns, unique-content metadata, key plans, lookup payloads and route filters. It independently decodes every record row and compares score and content reference with the input. It hashes every final persisted file, first raw and then with only independently linked random generation IDs normalized. All logical metadata properties are hashed; candidate presence marker 2 is decoded independently to the literal first word `0x3652424d`. A virtual dictionary-name column is independently expanded to its uniform prefix and zero capacity tail, including unused/free slots. Neither decoder calls a product getter or materializer. The complete property inventory must equal the baseline plus exactly the two prefix scalar properties; those scalars are validated and recorded in every allocation receipt, including after the physical column materializes.

Every run must match its recorded complete file-and-metadata oracle. JMdict additionally checks all original per-group record fields, lookup payloads and final envelopes, preserving the original `5a2d8167…` oracle. VNDB checks all 170 group lists, source sizes, row counts and media representatives against the independently retained corpus oracle, plus ordered and distinct image-path digests. The original Python directory oracle and receipt remain under the evidence directory. The portable directory-only helper can recompute that independent check:

```sh
python3 "$META_HELPER_ROOT/vndb-media-oracle.py" \
    --source-root "$META_CANDIDATE_ROOT" \
    --cache-dir "$META_CACHE" \
    --output "$META_OUTPUT/vndb-directory-oracle.json"
```

Its helper identity changes because it now accepts paths as arguments; its filename-count, byte-count and path-digest algorithm is unchanged. Compare those observations with the retained original receipt, rather than comparing the helper SHA256 itself.

Media requirements and media file persistence are outside the normal `skipImageMetadata=true` direct-artifact term boundary. The replay does not qualify settings UI, SQLite transactions, browser scheduling, restarts, lookups, browser peak/settled memory or whole-import speed. Read the evidence report for the precise measured allocation claim and retained failures.

## Focused helper checks

The bounded adapter's contracts can be checked without dictionary archives:

```sh
"$META_NODE" --test "$META_HELPER_ROOT/node-opfs-bounded.contract.mjs" \
    "$META_HELPER_ROOT/metadata-oracle.contract.mjs"
```

The helper preserves raw reports even when a source, file or metadata assertion fails. Generated `zip.js` source-location comments are normalized only for source-provenance comparison: exactly 24 anchored esbuild source comments may have a different installation-path prefix, and the entire normalized bundle must equal the pinned SHA256. Runtime JavaScript bytes outside those comments must match exactly. Actual raw asset hashes are retained before and after every run.

## Prior evidence and current scope

The helper directory retains its original S1 name. `reports/signature-only-README.md`, `reports/signature-only-protocol.json`, and `reports/signature-only-verification-manifest.json` preserve that earlier qualification separately. New combined acquisitions use new report directories; prior successes and failures are not relabeled as combined results. The candidate also snapshots signature primitives once before preparation and publication; focused controls cover private accessors and setters that mutate the source. Current import callers supply ordinary data objects.

The independent prefix run established a further 2 MiB backing reduction only for JMdict. The combined verifier observes all corpora without assuming dictionary-name uniformity: a compression-dictionary change or hole may correctly materialize the original Uint32 column. Comparison reports separate the S1 and dictionary-name portions and then total their actual owned backings. This is not a whole-process memory estimate.

## Separate current-base profile

The original combined acquisition used this helper at `434855c`. Its sources and complete observations remain immutable in that commit and the original evidence archive. The separately executed current qualification used helper `fb9d961` and adds the [`20261128-4d9f-current-metadata`](../../../builds/perf/20261128-4d9f-current-metadata) profile for `f28c2801` and integrated candidate `81e203e` (runtime identical to `fc431c3`).

Current upstream uses an empty Float64 record-ID view as an implicit positive-zero column. With the explicitly selected current profile, the independent helper reconstructs that full logical column in both A and B, including free entries and the unused tail. Physical values retain their exact bytes, including signed zero. Upstream ID allocation is recorded separately and never credited to the candidate's S1/name-column saving. The original profile retains physical-column behavior; it does not silently normalize the newer representation.

Pass the current evidence directory to every launcher and comparator with `--evidence-dir`, and add `logical-record-ids.contract.mjs` to the explicit Node contract command. The current profile README specifies its exact source bindings and limitations. Unknown metadata properties and representation modes still reject. Old corpus successes are not current-base results.

The current profile now contains six complete, first-attempt A/B runs, independently proving 4 MiB, 4 MiB and 1 MiB less retained S1/name-column backing for JMdict, Jitendex and VNDB respectively. Its README gives public-source reproduction using commit `68b29e5a959470e76ff67a93ec8b300cc53f1254`, whose complete tree equals the acquired local `81e203e` source. Keep the helper/evidence checkout separate from the frozen public runtime checkout; the local provenance commit need not exist in the reproducer's Git object database. No new executable helper change was needed for this packaging step.

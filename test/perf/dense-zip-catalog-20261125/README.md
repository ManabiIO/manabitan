# Lazy dense ZIP catalog

Baseline: `7d1643e6147a10cb2165e9744cf0e63b59e46632` (`develop`, November 25, 2026).

## Change and boundary

The ordinary importer eagerly retained an object and a raw filename view for every dense ZIP member. The pinned VNDB archive contains 147,237 members, including 146,570 images. The speculative media worker owns a separate catalog; the ordinary importer needs only 667 entries for the index and bank selection at this stage.

The candidate retains validated names, the existing compact filename arena, and six uint32 metadata words per member. `get` materializes and caches a real entry. Name iteration and bank classification leave unrelated images compact. Media requirements stop consulting the catalog after the prefetch entry budget is exhausted; cached-archive resolution keeps its existing path. Full entry enumeration remains supported. The compact table and reader reference are released when all placeholders are materialized, replaced, or deleted, and on `clear`.

The media worker retains its original array API and all source header, filename, offset, decoded-length and CRC checks. Stored data formats, worker counts, source batching and media selection do not change.

## Retained memory component result

The screen runs the production importer's archive setup and bank classifier in fresh Node 22.22.0 processes. Each observation records process memory before catalog construction, after bank selection, and after explicitly enumerating every member. Collection happens outside timing, twice across an event-loop turn at each memory boundary. These are retained component heap plus ArrayBuffer deltas, **not browser peak memory or complete-import measurements**.

The fixed protocol contains three excluded warmups and six counterbalanced A/B/C blocks (18 measured observations). A and C are identical baseline controls. Every observation, including larger ArrayBuffer-retention samples, remains in the archive.

| Boundary | Baseline A median | Candidate B median | Identical baseline C median |
| --- | ---: | ---: | ---: |
| Retained heap + ArrayBuffers after catalog and bank selection | 51,524,328 B | 18,689,256 B | 51,524,328 B |
| Retained heap + ArrayBuffers after full member enumeration | 62,125,664 B | 57,428,600 B | 62,125,664 B |

After selection, the median reduction is **32,835,072 B (31.31 MiB; 63.73%)**. Heap delta changes from 49,123,768 B to 12,755,008 B; the candidate adds a 3,533,688 B compact metadata table. The existing 2,400,540 B filename arena is retained in both versions. Exactly **146,570 image entry objects and persistent filename views are not materialized** at this boundary: 147,237 entries become 667.

Full enumeration exercises the fallback that eventually needs all members. Its median retained delta is 7.56% lower, and the compact metadata table is zero bytes after the last placeholder is consumed. The supplied reader remains available on already obtained entries after catalog clearing.

## Timing remains exploratory

Catalog/classification time and process CPU favor the candidate in this short screen, but unchanged A/C controls drift substantially. The C/A paired median wall-time difference is +29.61%, and its equal-work difference is +5.54%. Candidate median wall-time changes are −23.08% against A and −39.09% against C. These values do not support a qualified speedup percentage. No complete-import speedup or peak-memory reduction is claimed.

## Correctness

- All 147,237 member names, raw filename bytes, offsets, compressed and decoded sizes, compression methods, signatures, and flags match baseline in all 21 observations. Bank selections and order match as well. The complete metadata digest is `848bc44aa36a454a9d5f874a3b92570a5b8bf65a4a6780aabcf3cd5dcd573b19`.
- 113 focused tests pass across directory admission, lazy catalog behavior, bank selection, media prefetch, filename aliases, and cancellation. The earlier 111-test run before the all-materialized release addition also passed; both receipts are retained.
- Coverage includes duplicate names followed by a malformed later header, cancellation at the original read boundaries, stable entry identity, nonoverlapping filename views, Map insertion/deletion/reinsert and iterator behavior, `clear`, and fallback materialization/replacement/deletion accounting.
- Independent review checked actual archive-map consumers and found no missing Map operation or changed alias, CRC, local-header, read lifetime, or error-precedence behavior.

The screen proves complete directory metadata equality, not exhaustive persisted definitions or images. Whole-import behavior and broader static/unit/browser validation are separate checks.

## Reproduce

Prepare the locked VNDB archive and normal build output in each checkout, then run with Node 22.22.0:

```sh
node test/perf/dense-zip-catalog-20261125/screen.mjs \
  --baseline-root /path/to/baseline \
  --candidate-root /path/to/candidate \
  --cache-dir /path/to/verified-dictionaries \
  --out /path/to/results
```

The runner verifies the fixture's exact size and SHA-256, records source and harness hashes, checks every observation against the same complete metadata oracle, and rejects source changes during the fixed cohort. Each child uses `--expose-gc --max-old-space-size=384`.

Raw observations, process memory snapshots, source hashes, controls and test receipts are in [the evidence archive](../../../dev/perf/results/vndb-dense-zip-catalog-20261125.zip).

The [measured-source snapshot](../../../dev/perf/results/vndb-dense-zip-catalog-20261125-sources.zip) preserves both product versions and the original measurement scripts, verified against every source and harness hash recorded in the results. C uses the same product source as A. Subsequent lint cleanup adds production JSDoc annotations, formats the runner, and changes the worker's Promise executor to omit its unused return value. The historical observations come from the archived original scripts; they are not presented as a rerun of the cleaned-up runner. The raw evidence archive is unchanged.

A preceding shared-media-copy prototype was rejected: reducing copy calls from 146,570 to 144 added 6.78 MB of copied gap bytes and 64 KiB of WASM capacity without establishing a CPU benefit. Its code is excluded from this candidate and its measurements are not combined with this catalog cohort.

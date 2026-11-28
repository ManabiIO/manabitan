# Native raw-alias browser proof helpers

This is a research harness overlay, not a product patch. No browser observation has yet used these helpers. Unit tests establish the helper behavior with synthetic inputs; they do not establish corpus correctness or speed.

## Frozen source and protocol

- Baseline: `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`, tree `d911260f1a57f518d59b3a12127fcc3b2293c918`.
- Candidate: `2c02336b135ee01661ca2a788395afec75e66712`, tree `17995fab3d9e2fd226f0cc37d306f5dfc7e39505`.
- Prospective protocol: Git blob `7801b5fd696fffe4f250b98a19d6d80406518705`. The old 9e10 protocol remains superseded evidence.
- Stock browser harness: `test/chromium/extension-two-dictionary-import.e2e.js`, SHA256 `d0ae122bd22f7b460cedb11f06d2cb018224674abf9669e0fed567b5f3a870cf`.
- Stock receipt validator: `dev/perf/import-memory-20261125-a7f7/qualification_receipts.py`, SHA256 `4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51`.
- Stock synthetic receipt fixture: `test_qualification_receipts.py` in that directory, SHA256 `381b0a66ad64b7464c573e350fe740c23b2d64ec5e0be3cbe5acb0d34ae7d98d`.

The three tested stock files were compared byte for byte with `git show dcfc02a:path` after the base advanced. They are unchanged from the earlier checkout used to run these helper tests. The final companion handoff binds every new helper and retained test log by SHA256 and Git blob.

## Overlay boundary

`harness_overlay.layout_overlay(source, exporter_path, expected_source_sha256)` returns the overlaid harness text and exact provenance. It requires the original hash and one unique insertion boundary. The hook is inserted after the existing timed endpoint and the original restart, lookup, media, storage and physical-probe validation; it runs before quick-mode browser cleanup. Every arm and mode receives identical hook bytes.

Use the overlay hash in the stock source identity checks and declare `source_dirty=true`. Product source and the built extension package remain separately guarded. Do not describe these runs as using an unchanged harness. The additional post-endpoint work can influence later process/cache state, so it is applied equally under the frozen ordering and controls.

The hook calls `exportBrowserTermLayoutFromHarness(context)` with the actual page, stock validation, fixture, original pre/post-restart probes and raw `initialImportDebug`. Set the absolute `MANABITAN_ALIAS_LAYOUT_REQUEST` JSON path for each observation. Its fields are:

```json
{
  "schemaVersion": 1,
  "baseline": "dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16",
  "candidate": "2c02336b135ee01661ca2a788395afec75e66712",
  "protocolBlob": "7801b5fd696fffe4f250b98a19d6d80406518705",
  "arm": "A",
  "mode": "export",
  "dictionary": "vndb",
  "sourceCommit": "dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16",
  "sourceTree": "d911260f1a57f518d59b3a12127fcc3b2293c918",
  "sourceManifestSha256": "<actual frozen 64-character runtime-manifest digest>",
  "packageSha256": "<actual frozen package digest>",
  "exporterSha256": "<actual digest of browser-layout-export.mjs>",
  "fixtureSha256": "<actual pinned fixture digest>",
  "termFiles": ["<exact TERM_FILES.vndb array from the helper>"],
  "outputDirectory": "<absolute fresh output directory>"
}
```

All placeholder values above must be replaced with actual bound values before execution. Candidate B uses the candidate commit/tree/runtime/package identities; control C uses A's source identity. `mode=export` is only for untimed preflight. Every ordinary, warmup, control, all-media and memory observation uses `hash-only`.

## File proof and cleanup

The exporter reads every byte of exactly the declared term content, descriptor and index files in sequential ranges of at most 256 KiB. Each range has browser-side SHA256, coordinates and canonical base64 checked by Node. Incremental raw hashes and normalized hashes are retained. Export mode writes those same bytes incrementally under `outputDirectory/opfs/<actual path>`, fsyncs and closes them. Hash-only mode retains no full file bytes. Both modes retain `layout.json`, including original raw diagnostics/probes and complete before/after inventories.

The only normalized bytes are the random 16-byte generation IDs: descriptor header `[8,24)` and index header `[24,40)`. Actual `MBTRD16X` / `MBTIDX11` magic, minimum sizes, paired generation equality, index-to-descriptor byte length, and total row count are validated first. Raw hashes and generation IDs remain in the receipt. No content byte, offset, lookup column, padding or other header is normalized by the hash hook.

Export mode also acquires and immediately closes exclusive sync access handles for every term file in a dedicated worker. It uses the unchanged extension index-worker module URL for CSP compatibility, waits for ready, and evaluates a read-only handle probe. It never sends the production `open` message, which would truncate a file. The probe does no write, truncate or flush. Worker termination and its observed close are joined even if the termination command rejects. Cleanup failure prevents `complete=true`.

The exporter does not itself prove all row semantics or the cross-arm layout transformation. Those are mandatory, separately bound preflight checks performed by the full streaming verifier/comparator against the exported bytes and the current-source natural replay. The baseline agent owns that verifier. A missing or incomplete candidate natural replay or browser proof blocks ordinary acquisition.

## Strict receipt comparison

Put the unchanged stock validator directory on `PYTHONPATH`. Call `validate_import_summary` first with the exact source/package/harness identities, declared overlay, strict headless and full coverage policy. Then instantiate `AliasReceiptComparator(binding)` before warmups.

The binding contains baseline/candidate/protocol/corpus/fixture/helper identities, exact A/B commit/tree/runtime-manifest/package identities and, for VNDB only, both completed preflight witnesses. Each witness contains its layout JSON digest, original physical output digest, semantic probe digest, `file_vector(...)` result, and logical `route_receipt(...)` counters. `physicalProof` must bind the complete current-source natural comparison and both full browser verification reports by SHA256. The orchestrator must verify those report bytes, success and source identities before constructing the binding; a shape-only success flag is not a substitute.

For each actual observation:

```python
receipt = validate_import_summary(...)
layout = json.loads(layout_path.read_text())
checked = comparator.check(receipt, layout, arm)
comparator.compare(reference_receipt, receipt, reference_arm, arm)
```

Preserve the exact receipt object until comparison. The adapter retains its identity and digest so a successful earlier observation cannot authorize a replaced or subsequently changed receipt. Log the returned `checked` route/alias/hash summary alongside each observation; full raw layout/report artifacts remain mandatory.

Within each VNDB arm, full normalized file hashes, file sizes, original physical digest and all logical counters must equal that arm's frozen complete oracle. Cross-arm VNDB comparison projects only the already-proved physical probe digest and sizes of the five exact term files. All other stock fields and storage paths remain exact, including media data/digests and SQLite allocation. The adapter does not rewrite inputs or weaken the stock validator. No broad term-storage ignore is accepted.

JMdict and Jitendex have no alternate-layout exception. Their normalized complete file vectors must be exact across all arms, with zero aliases; the first excluded warmup anchors the per-host vector. Stock receipt comparison remains unchanged.

Alias activation is read from the retained raw `term-file-fast-path:` phase details, not the fixed `step4Breakdown` projection. The candidate VNDB receipt must contain exactly eight aliases and 2,983 input bytes; A/C and both other dictionaries must contain zero. Parser and canonical logical route counters must remain exact, with three parser workers and no fused/canonical fallbacks. Timing phase counters are not summed or treated as exclusive CPU measurements.

## Focused helper verification

```sh
node --test --test-concurrency=1 test-browser-layout-export.mjs
MANABITAN_RECEIPT_SOURCE=/absolute/current-source python -m unittest -v test_receipt_adapter.py
```

Retained latest result: eight Node tests and thirteen Python tests pass. Cases cover exact bounded range coverage, transport corruption, header/generation linkage, same-size corruption, unmatched layouts, unknown paths/fields, per-observation binding, logical route/activation, unrelated media/SQLite/semantics, non-target exactness, read-only handle failure cleanup, termination join and parsing the uniquely overlaid real harness. The first Python attempt's fixture aliasing error is preserved in `adapter-unit-attempt-1.log`; the fixture was repaired without weakening the adapter. No native parser, real browser, corpus benchmark or full suite runs in these helper tests.

## Acquisition prerequisites still open

1. Complete current-source A/B natural replay and full streaming comparison.
2. Complete A/B browser export preflight, all row/definition/lookup/alias/canonical-storage checks, and exact source linkage to the natural proof. Media resolution differences are failures, not tolerances.
3. Freeze the complete orchestrator/workflow/source/helper/package/protocol/witness binding and run source guards before/after.
4. Only then run the registered balanced cohort. Keep all observations, failures, order effects, control drift and memory receipts. The protocol's advancement thresholds are unchanged.

# Import optimization: second-round component evidence

This package preserves the original component observations, correctness receipts, source identities, runners, and unsuccessful experiments from 2026-11-23. **It contains no authoritative whole-import timing.** Original browser qualification failures remain failures; the component results and reservation-layout witness do not clear them. Corrective semantic/readback qualification and browser receipts are separate addenda.

| Study | What the evidence establishes | Qualification limit |
| --- | --- | --- |
| [Reference validation](validation/README.md) | All 7,610,700 pinned rows have identical record-field and prepared lookup bytes; VNDB eliminates 6,490,301 repeated span validations. | Isolated validation/planning timing; translated raw-slab offsets, no OPFS or full import. |
| [Pooled media diagnostics](media/README.md) | 270,731 eager decodes avoided; identical semantic references and diagnostics; separate forced-GC retained-state snapshots. | Materialization/compaction replay only; heap and backing-buffer changes are separate, not peak process memory. |
| [Full VNDB media correctness](media/full-media-parity/results.json) | All 146,570 image payloads, complete packed Blob, every index slot and error fallbacks match at unchanged production limits. | One correctness-only comparison; no timings or database publication. |
| [Integration](integration/README.md) | 782 tests in 21 files and a dry-run build passed for the combined validation/shared-content/media tree. | Focused local correctness, including a temporary witness excluded from the product tree. |
| [Reservation layout witness](integration/README.md) | Real Jitendex banks decode identically after source overwrite/cache invalidation despite physical offset differences. | Does not prove that the hosted browser digest mismatch was offset-only. |
| [CRC screens](crc/README.md) | All CRC values match; exact source/module/function identities accompany both original screens. | **Unqualified local performance experiment:** coarse short-run CPU accounting, noisy A/A controls, and mixed longer-run JMdict work. |
| [Held batch-count screen](held-media-batch/README.md) | Packed bytes/indexes and CRC errors match; fewer reads observed. | Mixed timing, median +0.1058%; not committed or shipped, no speed claim. |

The original direct-buffer media design is also retained and explicitly distinguished from the pooled candidate. No observations were dropped, reordered, or rewritten during packaging.

## Runtime identities

| Candidate | Measured/published runtime commit | Later check-only head |
| --- | --- | --- |
| Reference validation, PR #809 | `6a558cb4d48e781418a37cf27637c428fb929712` | Same commit |
| Pooled media, PR #811 | `7272ea938fd3de01bd40efcd4ee838c3249d0587` | `1e8235cf8a15d6788ae6fd8e039a71f3543bdc1b` |
| CRC experiment | `930083af581bd4d8fe8dc42fe7e443e57666f8f9` | Local performance remains unqualified |

The integration receipt additionally records the exact combined shared-content candidate tree and every relevant runtime source hash. Test-only follow-ups do not change the measured runtime hashes. Original measurement-time HEADs remain intact even where the candidate was then an uncommitted diff; later identity records provide the mapping rather than rewriting history.

## Verify and reproduce

```sh
python3 /absolute/path/to/round2-component-evidence/verify-package.py
node /absolute/path/to/round2-component-evidence/validation/verify-receipts.mjs
```

`package-manifest.json` records every payload file's size and SHA-256. Original files also record their source paths and hashes; `verify-package.py --compare-originals` can check those paths in the original workspace. The verifier checks receipt arithmetic, CRC JSON/JSONL order, exact output oracles, identity links, full-media parity, and integration file identities without running benchmarks.

Each study's README gives exact commands, immutable source revisions, required Node/toolchain versions, fixture identities, and explicit paths. Original runners retain their original bytes and one-off locators. Separate reproduction helpers create new path-adapted runners or input manifests outside this package. Run results into fresh directories so preserved receipts stay unchanged.

Large `.v8` validation inputs, the 64 MB media capture, extracted CRC banks, and generated Wasm modules are omitted. Their generators and identity checks are retained. The full reservation-layout JSON is stored as lossless gzip; its original bytes/hash and stored bytes/hash are recorded separately. The package verifier decompresses it in memory and checks both identities and every recorded span. Generated modules/captures were not rebuilt during packaging, and no new benchmark observations were run.

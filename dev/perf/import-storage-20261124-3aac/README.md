# Prospective storage receipt policy

This helper is tooling for the three pinned import fixtures. It is not a product change and does not alter the native browser harness. It applies only to new cohorts whose protocol explicitly selects `pinned-import-storage-20261124-v1`. The three incomplete VNDB cohorts from run `45465463257` remain failed under their original total-storage equality gate; their partial timings must not become a completed cohort or be pooled with new acquisitions.

## Observed failure and source explanation

The prefix, media-projection, and cache VNDB screens each stopped after a successful native import because total logical OPFS bytes changed from 609,553,611 to 609,561,803. The failures occurred in prefix `block-03-3-C` (baseline), media `block-02-2-B`, and cache `block-01-1-A` (baseline). In all three, the only size change was the active SQLite SAH-pool file: 528,384 to 536,576 bytes. Seven other SAH-pool files remained 4,096 bytes each. Every non-SAH file retained its size. The retained receipts cover 12 lookup terms over six passes, a deterministic 64-file media sample, complete inventory counts, and restart/readability checks; this is not exhaustive lexical or persisted-byte parity.

The source supports a non-deterministic insertion-order explanation. In `dictionary-importer.js`, the first 256 eligible images are prefetched. `_resolveAsyncRequirements` runs reads concurrently, and `_getImageMedia` calls `media.set` after an awaited read. `[...media.values()]` preserves completion order, which `_importDeferredMediaRequirements` passes through to SQLite. `dictionary-database.js` stores these variable-size image BLOBs in the `media` table with an AUTOINCREMENT primary key. SQLite allocation can therefore vary with read completion order while all image paths and bytes are unchanged. The remaining 146,314 VNDB images use the packed generation file. Dictionary summary construction does not persist import duration telemetry; timestamps and generation UUIDs do vary.

The captures contain sizes rather than database page contents. The source explanation is an inference, not proof of which rows occupy the extra allocation units. The narrow allowance below is based on the two observed baseline allocation values. It does not waive new or larger changes.

## Fixed prospective invariants

`normalize_storage_receipt(storage, dictionary)` validates the complete native inventory and retains all raw paths and sizes. It requires the exact known fixture paths, with only the generation UUID normalized. Missing, duplicate, or unknown paths fail. Every non-SAH path/size must match across all arms and observations, including content, records, lookup sidecars, and the generation media file. Equal aggregate totals cannot conceal compensating per-file changes.

Every observation must have exactly eight recognized SAH-pool files: seven empty files of exactly 4,096 bytes and one active file. Opaque SAH filenames are unordered, but their full size distribution is retained. For JMdict and Jitendex, the active allocation must remain exactly equal across all observations. For VNDB only, the active file must be 4,096-byte aligned and contain between 129 and 131 allocation units inclusive: 528,384, 532,480, or 536,576 bytes. These are units of the complete SAH file, not an assertion about usable SQLite database pages. Both smaller and larger values fail pending a separately reviewed protocol.

The raw total, raw file inventory, total SAH bytes, and actual active allocation remain in each receipt. Reports must retain each arm's allocation distribution and report any actual delta. There is no percentage allowance and no SQLite exclusion. Existing lookup hashes, source-equal media receipts, inventory/restart checks, source/package identity, and fixed observation schedules remain required and unchanged.

## Integration

After existing semantic validation:

```python
from storage_receipts import normalize_storage_receipt, storage_comparison_key

storage_receipt = normalize_storage_receipt(validation['storage'], dictionary)
storage_identity = storage_comparison_key(storage_receipt)
# Compare storage_identity with the previously frozen observation identity.
# Retain storage_receipt, including its raw totals/distribution, per observation.
```

`storage_comparison_key` revalidates every normalized field against the raw inventory, so an edited normalized receipt cannot conceal a different raw file. `compare_storage_receipts(baseline, candidate, dictionary)` compares two raw inventories and returns both receipts plus their actual total/SAH deltas. These functions raise on failure. They do not replace semantic checks or turn incomplete cohorts into successful studies.

Run focused synthetic witnesses with `python3 -m unittest discover -s . -p 'test_*.py' -v`. The tests cover the fixed range, exact controls, unknown/missing/extra paths, duplicate generation files, pool-count/empty-file changes, non-SAH deltas, equal-total compensating changes, invalid schema/sizes, and normalized-field tampering. No browser or import timing runs are involved.

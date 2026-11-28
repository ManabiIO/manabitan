# Final85 VNDB browser storage audit

This is an independent, read-only audit of **both opposite-order hosts and all four completed VNDB imports** from workflow run 46141945184. Both cells pass the frozen semantic, full-media, storage and post-restart activation checks. This evidence supports an exact persisted term-storage reduction. It does not claim lower import time or lower process memory.

| Item | Frozen identity |
| --- | --- |
| Product source | `85a8aa49f76fbabd2dc494aad247f74774ff2573` |
| Product tree | `ae7323d19d6da0cc500ff231a0dcd469ce4f31af` |
| Tooling source | `6650e56034b7c4e92451a7032fbf93ffd76d999f` |
| Tooling tree | `f6381689025ca791493acd1077ddac5eb8277dcf` |
| Workflow run | 46141945184 |
| On/off artifact | 15262007286; 17,262,203 bytes; SHA256 `f161c5c373beab7e067d3877e82940f4149b8767b6e4ff115bb8421fb528ae6a` |
| Off/on artifact | 15262577737; 17,262,541 bytes; SHA256 `62baf2baab181afc9fcd412b2cf63b8383c518c7425de616c2b941b7ab8130ed` |

## Observed result

| Persisted term files | Flag off | Flag on | Saved |
| --- | ---: | ---: | ---: |
| All exact term files | 409,433,345 B | 385,022,101 B | **24,411,244 B** |
| Raw block lookup index | 399,513,708 B | 375,257,528 B | 24,256,180 B |
| Raw-v6 lookup index | 2,386,124 B | 2,231,060 B | 155,064 B |

Content bytes and the two record headers are unchanged. The enabled mode stores 6,328,310 rows in 162 format4 chunks, with 30 format2 chunks retained. The disabled mode stores all 6,648,310 rows in 192 format2 chunks. The post-restart SQLite floor is 13 when enabled and 11 when disabled. Both orders produce the same exact canonical normalized receipt; all four imports pass 72 lookup observations and verification of all 146,570 media files / 188,131,284 media bytes.

The full unchanged semantic validator is called with the **prospectively registered exact 77-unit** SAH contract. Each import has exactly seven empty 4,096-byte files and one 315,392-byte active file. This exact value came from a separately audited default-flag a300 parent import before this new cohort. No interval widening, observed-result adjustment or relaxed semantic validator is used.

## Source and package separation

The earlier JMdict/Jitendex browser evidence remains attributed to source 16c1b9f. The two earlier 16c VNDB cells stopped at their original strict 37-unit gate, and remain failures. Their raw observations and the independent parent calibration are preserved separately under `../browser-audit-original`.

Both final85 release ZIPs contain the same 582 entry hashes. Comparing them to the independently audited 16c release inventory finds **one changed entry**, `js/dictionary/term-record-opfs-store.js`:

- 16c SHA256: `3cfb7f4ca9094b05e806bc6715c41ae8c7b596f51cda1b223ddc643ae63e1d44`.
- 85 SHA256: `434864abaa3939f6e86361d3c01685fa296b3ea8b2120a7411454ef295805e45`.
- 85 Git blob: `d056b473923f762ab2c4dca91393effa2abc0f40`, exactly the published source file.

There are no added or removed release entries. The public Git source delta is the equivalent explicit `rowBytes` conditional plus four call-formatting changes. The source commit/tree, previous 582-entry inventory, exact hashes and inspected diff are retained. This binds the two source variants transparently; it does not relabel an earlier acquisition.

## What the independent audit checks

The audit verifies both complete artifact ZIP SHA256/byte identities, unique safe member paths and every member hash. It independently hashes every embedded release entry, checks package/source/tree/tooling and ordinary SQLite pins, binds the locked fixture and all relevant source/harness identities, and reproduces the observer overlay byte-for-byte.

It then runs the retained, hash-pinned original semantic validator, exact allocation helper, storage normalizer and activation validator against every raw report. It compares each recomputed receipt with the stored receipt, requires cross-mode and cross-host equality, verifies the exact schedule and result totals, and checks all four successful browser subprocess exits. It never launches a browser import.

The header observer checks all 192 persisted chunks after orderly restart, including field formats, row totals, linked generation intervals, file boundaries and minimum SQLite floor. Full field decoding, corruption/interruption handling, older-reader rejection and online iteration remain separately scoped corpus/unit gates.

## Preservation and reproduction

`raw-and-audit-evidence.tar.xz` is deterministic and contains all original nonpackage members from both artifact ZIPs, plus the independent per-cell member/package inventories and audit outputs. Every archive member is listed and SHA256-checked in `archive-members.json`; the archive was reopened and every member verified after creation. Only the already fully inventoried embedded `package.zip` bytes are omitted. Original artifact/package ZIP hashes, byte counts and all 582 extracted release-entry hashes remain in the receipts. Derived Python bytecode caches are excluded.

The compact top-level audit index, package comparison, pinned inputs, source proof and read-only reproducer are also provided separately. To repeat the complete ZIP/member/package audit, obtain the two exact GitHub artifact ZIPs above into an otherwise empty directory using the retained artifact names. Run Python 3 without optimization:

```bash
python3 audit-format85-vndb.py \
  --artifacts /absolute/path/to/artifact-zips \
  --pins pinned-source-receipts.json \
  --previous-inventory previous- 16c-package-inventory.json \
  --output /absolute/path/to/a-new-audit-directory
```

The script refuses to overwrite an existing output directory. It requires only Python's standard library and the pinned Python validators retained inside the original artifacts. Without the original product ZIP bytes, the compact archive still preserves all raw reports, validator/observer source and exact package inventories, but is not itself a reconstruction of either outer artifact ZIP.

No latency, process-memory, clean-up-after-crash or live online-rewrite improvement is asserted by this browser storage cohort.

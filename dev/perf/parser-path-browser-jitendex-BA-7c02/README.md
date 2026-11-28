# Jitendex BA: complete saved observation evidence

This compact bundle retains every non-package file from the completed hosted artifact, including its failed memory-qualification receipts. It does not filter observations or failures, sample memory scans, rerun the campaign, or establish numerical qualification. Independent numerical and correctness audits are separate.

| Original identity | Value |
|---|---|
| Run / job | 46113567719 / 140904689455 |
| Artifact | 15256069414, `parser-path-qualification-7c02-jitendex-BA` |
| Research head | `d36ee85feb1513af31f769175affa33b3696a307` |
| Baseline / candidate | `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` / `e90c4c04172b691985858609094887f9541541dd` |
| Original artifact ZIP | 35,601,135 bytes, SHA-256 `8b1154e433540eb3a9cf8c0bbf24f03b180362dd7ec5a98cd8f836fb7ae0dce6` |
| Original extracted evidence | 317 files / 56,449,910 bytes |
| Retained original evidence | 315 files / 22,837,505 bytes |

## Complete preservation

The ordered part files contain a deterministic ZIP. Its manifest identifies every retained member by original path, byte count and SHA-256. Under `artifact/`, all 315 non-package files remain byte-for-byte intact: all 36 ordinary directories (four warmups, 24 candidate observations, eight controls), both exhaustive-media directories, the entire 35-file memory subtree (10,434,849 bytes), all JSON and HTML reports, complete raw process-tree and scan arrays, marker streams, canonical/media/restart receipts, complete stdout and stderr captured by run logs, original and instrumented harnesses, schedule, statistics, failures, source/package-entry/fixture/browser identities, and every setup/build/acquisition log. Empty files are preserved.

Under `metadata/`, the exact original artifact metadata, full 317-member SHA/size preservation receipt and complete 314,405-byte job log remain retained. No observation or historical result text was edited to match later conclusions. All 317 original member hashes were checked before and after packing; no original extraction or ZIP was moved, deleted or modified.

## Exact omissions

Only these two historical package containers are omitted:

| Original member | Bytes | SHA-256 |
|---|---:|---|
| `result/package-A.zip` | 16,805,714 | `c8a093c90d8f45c8e22fb10164adbe46db66797ca9c98a649b1b480ae30c1080` |
| `result/package-B.zip` | 16,806,691 | `cf94cd84542915f2ad61c274f2bfef491e8e402aa57b3ba14f11661662c51118` |

Their hashes remain in the original 317-member inventory and the compact manifest. The unchanged source-identities receipt retains all 554 packaged entry hashes per arm; packing verifies every entry against those maps. Package contents are rebuildable from pinned sources and dependencies, but this does **not** promise reconstruction of the exact historical ZIP container bytes. Those bytes remain in the original Actions artifact and were left unchanged locally at preservation time; they are not supplied by this compact bundle. No fixture ZIP was present in the extraction, so no fixture payload was omitted; fixture identities and original resolution logs remain intact.

## Offline saved-byte verification

Keep every outer file together, then run:

```sh
python3 verify.py
```

The verifier reads the ordered parts in memory and checks their SHA-256 and Git blob SHA1, complete archive hash and CRC, every retained member hash, coverage of all 317 original members except the two named packages, exact metadata/source inventory binding, all 36 saved schedule identities, two media directories, four memory slots and complete raw scan arrays. It requires no original extraction and executes no product, native or browser code. It is a preservation check; independent timing, correctness and memory gate recomputation remains separate.

`verification.json` retains the first verification output. `privacy-scan.json` records the path-only scan of all retained text and log bytes for obvious token and signed-download-URL patterns; secret values are never printed. `index.json` binds the archive, parts, configuration and helpers. `bundle-files.json` lists the publication files and their SHA-256/Git blob SHA1. The helper copies are byte-identical to the generic preservation helpers used for the preceding completed cohorts; `cohort.json` binds only this artifact's identities, locations and byte counts. Its absolute acquisition paths are historical provenance, not a portable promise of fresh acquisition.

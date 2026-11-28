# VNDB AB: complete saved observation evidence

This compact bundle retains every non-package file from the completed hosted artifact, including its failed memory-qualification receipts. It does not filter observations or failures, sample memory scans, rerun the campaign, or establish numerical qualification. Independent numerical and correctness audits are separate.

| Original identity | Value |
|---|---|
| Run / job | 46113567719 / 140904689385 |
| Artifact | 15257031285, `parser-path-qualification-7c02-vndb-AB` |
| Research head | `d36ee85feb1513af31f769175affa33b3696a307` |
| Baseline / candidate | `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` / `e90c4c04172b691985858609094887f9541541dd` |
| Original artifact ZIP | 35,870,913 bytes, SHA-256 `10730c5db5a511e7804d23093d56f74d29708c00b7c3eda9df8c52e4fcd2a8a3` |
| Original extracted evidence | 317 files / 65,377,444 bytes |
| Retained original evidence | 315 files / 31,765,039 bytes |

## Complete preservation

The ordered part files contain a deterministic ZIP. Its manifest identifies every retained member by original path, byte count and SHA-256. Under `artifact/`, all 315 non-package files remain byte-for-byte intact: all 36 ordinary directories (four warmups, 24 candidate observations, eight controls), both exhaustive-media directories, the entire 35-file memory subtree (19,193,586 bytes), all JSON and HTML reports, complete raw process-tree and scan arrays, marker streams, canonical/media/restart receipts, complete stdout and stderr captured by run logs, original and instrumented harnesses, schedule, statistics, failures, source/package-entry/fixture/browser identities, and every setup/build/acquisition log. Empty files are preserved.

Under `metadata/`, the exact original artifact metadata, full 317-member SHA/size preservation receipt and complete 312,840-byte job log remain retained. No observation or historical result text was edited to match later conclusions. All 317 original member hashes were checked before and after packing; no original extraction or ZIP was moved, deleted or modified.

## Exact omissions

Only these two historical package containers are omitted:

| Original member | Bytes | SHA-256 |
|---|---:|---|
| `result/package-A.zip` | 16,805,714 | `1ce1a9fbe2df90258556f4212c1d94854f9ad4dafa428607e3f499663e310ca0` |
| `result/package-B.zip` | 16,806,691 | `49cf82606b97ebf9a3c03aea746c92f7cdd7db05e545e52ab3c5756ff345b4e8` |

Their hashes remain in the original 317-member inventory and the compact manifest. The unchanged source-identities receipt retains all 554 packaged entry hashes per arm; packing verifies every entry against those maps. Package contents are rebuildable from pinned sources and dependencies, but this does **not** promise reconstruction of the exact historical ZIP container bytes. Those bytes remain in the original Actions artifact and were left unchanged locally at preservation time; they are not supplied by this compact bundle. No fixture ZIP was present in the extraction, so no fixture payload was omitted; fixture identities and original resolution logs remain intact.

## Offline saved-byte verification

Keep every outer file together, then run:

```sh
python3 verify.py
```

The verifier reads the ordered parts in memory and checks their SHA-256 and Git blob SHA1, complete archive hash and CRC, every retained member hash, coverage of all 317 original members except the two named packages, exact metadata/source inventory binding, all 36 saved schedule identities, two media directories, four memory slots and complete raw scan arrays. It requires no original extraction and executes no product, native or browser code. It is a preservation check; independent timing, correctness and memory gate recomputation remains separate.

`verification-launch-failure.json` preserves an initial tool invocation with a mistyped working directory. That process never started. Correcting only the invocation directory allowed the unchanged verifier to run; `verification.json` retains that first executed verification, which passed. No archived input, observation, verifier source or benchmark was changed or repeated.

`privacy-scan.json` records the path-only scan of all retained text and log bytes for obvious token and signed-download-URL patterns; secret values are never printed. `index.json` binds the archive, parts, configuration and helpers. `bundle-files.json` lists the publication files and their SHA-256/Git blob SHA1. The helper copies are byte-identical to the generic preservation helpers used for the preceding completed cohorts; `cohort.json` binds only this artifact's identities, locations and byte counts. Its absolute acquisition paths are historical provenance, not a portable promise of fresh acquisition.

# jmdict AB: complete saved observation evidence

This compact bundle retains every non-package file from the completed hosted artifact. It does not filter observations or failures, sample memory scans, rerun the campaign, or establish numerical qualification. Independent numeric/correctness audits are separate.

| Original identity | Value |
|---|---|
| Run / job |46113567719 / 140904689380|
| Artifact |15256162585, `parser-path-qualification-7c02-jmdict-AB`|
| Research head |`d36ee85feb1513af31f769175affa33b3696a307`|
| Baseline / candidate |`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` / `e90c4c04172b691985858609094887f9541541dd`|
| Original artifact ZIP |35,606,138 bytes, SHA-256 `2bc83e741b11967bc9c034da28ef87ae40df7d45be0e1b47e3fdccfbef47838f`|
| Original extracted evidence |317 files / 57,533,278 bytes|
| Retained original evidence |315 files / 23,920,873 bytes|

## Complete preservation

The ordered part files contain a deterministic ZIP. Its manifest identifies every retained member by original path, byte count and SHA-256. Under `artifact/`, all315 non-package files remain byte-for-byte intact: all36 ordinary directories (four warmups,24 candidate observations,eight controls), both exhaustive-media directories, the entire35-file memory subtree (11,579,302 bytes), all JSON/HTML reports, raw process-tree/scan arrays, marker streams, canonical/media/restart receipts, complete stdout/stderr captured by run logs, original/instrumented harnesses, schedule, statistics, failures, source/package-entry/fixture/browser identities, and every setup/build/acquisition log. Empty files are preserved.

Under `metadata/`, the exact original artifact metadata, full317-member SHA/size preservation receipt and complete 314,495-byte job log remain retained. No observation or historical result text was edited to match later conclusions. All317 original member hashes are checked before and after packing; no original extraction or ZIP is moved, deleted or modified.

## Exact omissions

Only these two historical package containers are omitted:

| Original member | Bytes | SHA-256 |
|---|---:|---|
| `result/package-A.zip` |16805714|`1ac33cf15a254e5188b0a43bd5f5251a6f784011d380ce25a7c02c070d52af32`|
| `result/package-B.zip` |16806691|`6288d4b1d5631dd35e7f62fd9fb38253f70aa89c650ff455650f096896bc345d`|

Their hashes remain in the original317-member inventory and the compact manifest. The unchanged source-identities receipt retains all554 packaged entry hashes per arm; packing verifies every entry against those maps. Package contents are rebuildable from pinned sources/dependencies, but this does **not** promise reconstruction of the exact historical ZIP container bytes. Those bytes remain in the original Actions artifact and were left unchanged locally at preservation time; they are not supplied by this compact bundle. No fixture ZIP was present in the extraction, so no fixture payload was omitted; fixture identities and original resolution logs remain intact.

## Offline saved-byte verification

Keep every outer file together, then run:

```sh
python3 verify.py
```

The verifier reads the ordered parts in memory and checks their SHA-256/Git blob SHA1, complete archive hash/CRC, every retained member hash, coverage of all317 original members except the two named packages, exact metadata/source inventory binding, all36 saved schedule identities, two media directories, four memory slots and complete raw scan arrays. It requires no original extraction and executes no product/native/browser code. It is a preservation check, not a replacement for independent timing/correctness/memory gate recomputation.

`verification.json` retains the first verification output. `privacy-scan.json` records the path-only scan of all retained text/log bytes for obvious token and signed-download-URL patterns; secret values are never printed. `index.json` binds the archive, parts, configuration and helpers. `bundle-files.json` lists the publication files and their SHA-256/Git blob SHA1. The helper copies use the same preservation contract as the earlier JMdict BA bundle; `cohort.json` binds only this artifact's identities/locations/byte counts. Its absolute acquisition paths are historical provenance, not a portable promise of fresh acquisition.

# JMdict BA: complete saved observation evidence

This compact bundle preserves every non-package member of the original completed hosted artifact. It does not remove observations, sample raw memory scans, filter failures, rerun the campaign, or establish a numerical qualification result. The independent result audit is separate.

| Original identity | Value |
|---|---|
| Repository | ManabiIO/manabitan |
| Run |46113567719|
| Job |140904689347|
| Artifact |15256246047, `parser-path-qualification-7c02-jmdict-BA`|
| Research head |`d36ee85feb1513af31f769175affa33b3696a307`|
| Baseline |`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`|
| Candidate |`e90c4c04172b691985858609094887f9541541dd`|
| Original artifact ZIP |35,781,708 bytes, SHA-256 `3a39c24c411fadf7f1791aa119816c14c85e8a6d518b70bed74f9244b613c75b`|
| Original extracted members |317 files,64,054,076 bytes|
| Retained artifact members |315 files,30,441,671 bytes|
| Additional original metadata |Artifact metadata, full317-member preservation receipt, and complete job log|

## What is retained

The ordered part files contain a deterministic ZIP. `manifest.json` maps every retained path to its original size and SHA-256 and lists the only two omissions. Under `artifact/`, the original relative paths and file bytes are unchanged:

- All36 ordinary observation directories, including the four excluded warmups,24 A/B candidate observations and eight A/C controls. Every original JSON/HTML report, canonical receipt, stdout/stderr capture in `run.log`, and before/after host receipt remains present.
- Both separate exhaustive-media directories and all their reports, receipts and logs.
- The entire35-file memory subtree,18,077,439 bytes, including all four full raw process-tree/scan JSON files, marker streams, original and instrumented harnesses, native reports, logs, semantic failures, observations, comparisons and audit receipts.
- The exact registered schedule, observations, analysis, cell summary, source/package-entry/fixture/browser identity manifests, build/setup/acquisition logs and all other original non-package members. Empty files remain empty files.

Under `metadata/`, the original artifact metadata, preservation receipt and313,186-byte job log are retained exactly. The observation archive and those metadata files have not been edited to match later conclusions. Their contents can include an unsuccessful gate even when acquisition itself completed.

## Exact omissions

Only `result/package-A.zip` and `result/package-B.zip` are omitted from this compact bundle. They total33,612,405 bytes:

| Omitted container | Bytes | SHA-256 |
|---|---:|---|
| A |16805714|`7efaa5a77312571d971dd25f3eadaa433d117e38dc6622ae038dbdb9f3620966`|
| B |16806691|`153af25288006eae85e24fb465a1778b54393d9fac11a3eb2d9e006c09dc2710`|

The original source identities retain all554 packaged entry hashes for each arm. Packing verified every entry against those maps and verified both ZIP hashes. Package contents are rebuildable from the pinned source/dependencies, but this does **not** promise reconstruction of the exact historical ZIP container bytes. Those container bytes remain in the original Actions artifact and were also left unchanged in the local original at preservation time. They are not supplied by this compact bundle. No fixture ZIP was present in the extracted artifact; fixture identities and original fixture-resolution logs remain retained.

The original downloaded artifact and extraction were neither moved, deleted nor modified. All317 member hashes were checked before and after packing. `privacy-scan.json` records a path-only scan of all retained text/log payloads for obvious token and signed-download-URL patterns; it does not reproduce potential secret values.

## Offline saved-byte verification

Keep `index.json`, every ordered `cohort-evidence.part-*`, `verify.py`, `build.py`, and `privacy-scan.json` together. Run:

```sh
python3 verify.py
```

The verifier checks part SHA-256 and Git blob SHA1, archive SHA-256/CRC, every member hash, complete coverage of the original317-member inventory except the two named package containers, original artifact metadata, exact retained schedule identities, all36 ordinary/two media/four memory directories, and preservation of the complete raw memory sample arrays. It requires neither the original extraction nor a native/browser runtime. It does not rerun product code, interpret timing gates, or replace the independent arithmetic/correctness/memory audit.

`verification.json` is the preserved output of the first saved-byte verification. `build.py` records the acquisition-specific original local paths; they are historical provenance, not a portable one-command fresh acquisition. The source campaign, fixed thresholds and candidate remain unchanged.

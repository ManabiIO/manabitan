# Import allocation evidence: 2026-11-26, 9175

This snapshot supports the shared parser allocation change in
[PR #942](https://github.com/ManabiIO/manabitan/pull/942) and is retained through
[PR #947](https://github.com/ManabiIO/manabitan/pull/947). Product implementation, final-source CI and three-dictionary browser receipt
coverage are complete. Original JMdict and VNDB browser observations retain
their original parser source identity; the corrected Jitendex cohort uses the
final parser. The separate closed-media VNDB cell supplies no observation here.

## Sources and validation

The baseline is `0143e9596cd8f790d5e166d4ba6a2425fbc57f14` throughout. Original
browser observations use parser `400d4375a89cdf93805cc9566da2068a741dc059`.
The final parser is `01d0eb7164385828c97efae1b319ccc1c4fe92f9`, Git tree
`34e19a22eef45ea552bc4696873f1ae50ae398f2`. Its later changes are documented
style corrections and retained evidence; frozen observations keep their original
source identity.

[Final product CI](https://github.com/ManabiIO/manabitan/actions/runs/45863372364)
completed successfully on that exact final commit: 15 successful jobs and four
conditional skips. The complete test/build result is distinct from the bounded
performance screens below.

| Cohort                                | Source                                                  | Status in this snapshot                                                   |
| ------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Original JMdict browser ABBA          | Parser `400d4375`                                       | All four imports and semantic receipts pass                               |
| Original VNDB browser ABBA            | Parser `400d4375`                                       | All four imports and semantic receipts pass                               |
| Original Jitendex browser cohort      | Baseline A1 only                                        | Browser checks pass; stale verifier rejects receipt; candidate never runs |
| Corrected Jitendex browser ABBA       | Final parser `01d0eb`, existing verifier fix `439a1c9b` | All four imports and semantic receipts pass                               |
| Hosted complete VNDB component replay | Final parser `01d0eb`                                   | All 665 banks and 167 groups pass                                         |

The original run is
[45862232094](https://github.com/ManabiIO/manabitan/actions/runs/45862232094).
The corrected Jitendex run is
[45865210668](https://github.com/ManabiIO/manabitan/actions/runs/45865210668).
The final-source VNDB corpus run is
[45864038998](https://github.com/ManabiIO/manabitan/actions/runs/45864038998).

## Completed browser observations

Each completed parser browser cohort uses release Chrome, Node 22.22.0,
Chromium 153.0.8010.12, production import defaults and the locked dictionary.
Both package contents and the exact changed-file allowlist were independently
checked. All four observations match on raw content probes, restart checks,
72 lookup observations and exhaustive media receipts. JMdict retains 528,299
rows and zero media files; VNDB retains 6,648,310 rows and all 146,570 referenced
images, totaling 188,131,284 decoded bytes. Corrected Jitendex retains 436,555
rows and all 236 referenced images, totaling 4,992,155 decoded bytes.

Elapsed times cover the browser file-input change through visible completion.
Exhaustive media readback occurs afterward and is outside that timing boundary.

| Dictionary          | A1 / B1 / B2 / A2 import time, ms     | Paired candidate changes |
| ------------------- | ------------------------------------- | ------------------------ |
| JMdict              | 901.8 / 923.4 / 851.1 / 879.5         | +2.395% / -3.229%        |
| Jitendex, corrected | 1,864.8 / 1,913.5 / 1,573.1 / 1,600.6 | +2.612% / -1.718%        |
| VNDB                | 8,945.3 / 4,928.0 / 5,745.4 / 5,115.5 | -44.910% / +12.314%      |

These are two pairs per dictionary on one host. The mixed results do not
establish a whole-import speedup. Logical OPFS size is unchanged across all
four observations: 43,520,477 bytes for JMdict, 67,466,332 bytes for corrected
Jitendex and 609,176,779 bytes for VNDB.
No browser peak-memory reduction is claimed.

## Jitendex verifier failure and separate correction

The original baseline Jitendex browser import passed its 436,555-row count,
restart, content, lookup and complete-media checks: 236 referenced images and
4,992,155 decoded bytes. The measurement verifier then rejected the correct
`experimentalNativeEscapedKeys=false` receipt. It still expected projection
at 512 MiB, whereas the importer requires 1 GiB; this corpus has 538,927,310
uncompressed source bytes. Exact failure-log excerpts and raw reports are retained.
No candidate observation ran, and those failed-cohort timings are not used in
the corrected cohort.

The separately registered corrected cohort uses the existing
[PR #950](https://github.com/ManabiIO/manabitan/pull/950) fix at
`439a1c9b6d40452061cda094b0727005553c1d1d`. It builds unchanged product packages
first, then applies the same measurement-only `benchmark-support.js` overlay to
both arms. The overlay SHA-256 is
`eacc5eeee1aaeb13ea44867f0d2ff168f5e723392652ebfee6dfc717ba3865d0`.
Original and overlaid bytes, modified-worktree receipts and per-sample hashes
are retained and independently verified. All four observations completed and
matched on complete semantic receipts. The audit checks actual package ZIP
bytes and members, the unchanged shared source and lock inputs, the identical
overlay and per-observation hashes. The packaged changed parser modules also
match the exact published Git tree byte-for-byte. No original failed-cohort
observation is reused in this result.

## Complete corpus accounting

`local-parser-components` preserves the exact evidence already published with
the final parser PR, including earlier failed attempts. Its completed JMdict
and Jitendex receipts use the original frozen runtime. The hosted VNDB receipt
uses the final parser source. All use fixed four-bank component groups, with
output equality asserted against the baseline after deferred columns initialize.

| Corpus   |      Rows | Groups | Group-local unique contents, summed | Deferred bytes, summed |
| -------- | --------: | -----: | ----------------------------------: | ---------------------: |
| JMdict   |   528,299 |     14 |                             366,253 |              4,761,289 |
| Jitendex |   436,555 |     55 |                             363,281 |              4,722,653 |
| VNDB     | 6,648,310 |    167 |                             157,852 |              2,052,076 |
| Total    | 7,613,164 |    236 |                             887,386 |             11,536,018 |

Each unique content entry defers 13 bytes until storage admission. These are
cumulative counts across component groups, not simultaneous retained memory,
total allocation savings or browser scheduling measurements. The VNDB maximum
is 16,367 deferred bytes in one fixed group. The audit verifies recorded source
and runner identities, complete group accounting and the successful runner's
checksum/equality assertions. It does not rerun native parsing or independently
recompute every payload digest.

## Closed media alternative

The original matrix also tested media source `bdb9c74874e2612fbb8741f4d36ed4397e4eaf57`
from closed duplicate PR #935. Its completed JMdict observations and failed
Jitendex baseline observation are preserved under `closed-media-alternative`.
Its VNDB job was queued at the last historical-matrix check,
2026-11-26 17:35:03 UTC, and supplies no result here.
Those alternative results are not attributed to the selected #934 or #937 and
do not affect the active parser conclusions.

## Preservation and reproduction

Raw JSON bytes are retained under `.json.txt` names so repository configuration
JSON checks do not reinterpret them. `path-hash-manifest.json.txt` maps every
archived name to its logical original path and artifact or source identity,
with byte length and SHA-256. Only that manifest excludes its own hash. The
README is formatted before the manifest is computed; raw evidence is never
reformatted.

Downloaded package ZIPs were independently hashed and checked, then discarded
to bound disk use. Artifact IDs, original ZIP hashes, packaged-member hashes,
source manifests, raw browser reports, summaries, semantic receipts and every
observation used in statistics remain available. The complete/failure inventory
is in `provenance.json.txt`; it explicitly distinguishes the unobserved
closed-media VNDB cell.

The browser auditors in `auditors` read the original downloaded GitHub artifact
ZIP layout, not the renamed compact archive. Configure their `REPO` and `SCRIPT`
paths to the frozen checkout and retained protocol when relocating them.
For the corrected-Jitendex wrapper, set its `ROOT` to `protocols` and its
imported audit module's `REPO` to the checkout. The corpus audit script preserves
its original workspace paths and equivalent local commit; its published commit
and tree binding are recorded alongside it.
The path manifest describes all compact-file renames. The original corpus
audit script and its recorded limits are also retained.

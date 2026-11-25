# Combined dictionary import validation — November 25, 2026

The combined JMdict, Jitendex and VNDB changes passed functional verification. The implementation is proposed in [#894](https://github.com/ManabiIO/manabitan/pull/894), [#895](https://github.com/ManabiIO/manabitan/pull/895) and [#915](https://github.com/ManabiIO/manabitan/pull/915).

[Download the complete validation evidence](./imports-combined-validation-20261125.zip). The archive contains 77 files, including unchanged logs, all browser attempts, exact source and package identities, the independent media oracle, and reproduction instructions.

- Archive size: **3,573,792 bytes**
- SHA-256: `469044721eb304b9007716f595b6f6acac3a25bce40d8bd24ec61cf955055adf`
- Validated local source: `65aad0026e4bb278f2d51e02ac991ebe9a1101ad`
- [Identical public source](https://github.com/ManabiIO/manabitan/tree/3ef542838499e874324ac5d0e6f92c3b12ede637): `3ef542838499e874324ac5d0e6f92c3b12ede637`
- Exact source tree: `31f3c93c37a67a5554308a19b0c4ab8b5258f608`

## Verification

| Check                           | Result                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| TypeScript                      | All four projects passed                                                                                   |
| Native artifact rebuild         | Pinned Clang/LLD 21.1.8 reproduced both checked-in targets                                                 |
| Build                           | All seven dry-build targets passed                                                                         |
| Combined unit coverage          | 648 passing files, 14,599 passing tests, 47 existing skips, across the full run and compiler-enabled retry |
| Jitendex + JMdict in Firefox    | 30 focused phases passed, with no verification skips                                                       |
| VNDB import and real restart    | Healthy OPFS, no fallback, same profile and distinct Firefox processes                                     |
| VNDB summary/API counts         | 6,648,310 terms and 146,570 media before and after restart                                                 |
| VNDB content and exact lookups  | 12 terms and 29 decoded rows checked before and after restart; identical digest                            |
| VNDB exhaustive persisted media | All 146,570 images and 188,131,284 decoded bytes matched the pinned ZIP after restart                      |

The initial full unit invocation exited 1 because two suites could not discover the WASM compiler. It passed 646 files and 14,578 tests. Loading the pinned compiler environment and rerunning those two suites passed the remaining 21 tests; product source was unchanged. The archive preserves both executions and their exact commands.

The 29 sampled content rows comprise six direct `raw-v6` records and 23 compressed `raw-block-v2` records. Checks require valid physical reference bounds, exact decoded lengths and readable glossary content. Counts are persisted summary/API counts, not exhaustive physical term-record enumeration.

Media verification checks every referenced image's path, dictionary, length, CRC and exact decoded bytes. Its canonical SHA-256 is:

`ea94d392bc833baf0bee7b3d6becc3d3517eee84ee314a44986438ac6d5217cb`

The sampled content digest before and after restart is:

`fa87756c5b76ea01bf2511d2b019bef2e010eba984b69c919664223340aaaca4`

## Retained attempts and independent oracle

All three unsuccessful VNDB attempts remain in the archive: an external diagnostic-schema mismatch, verifier heap exhaustion at 512 MiB, and exit 137 under host pressure with the larger eager verifier. Product source remained unchanged.

The successful run uses an independent generic Zip.js oracle that streams entries in two bounded passes. It retains the complete inventory, exclusion, duplicate, count, CRC, exact-byte and canonical-digest checks. Its complete result matched the original oracle on all 236 pinned Jitendex images, and four negative-response cases were rejected. It does not reuse the candidate dense ZIP parser.

The final VNDB process exit code was not separately preserved and remains null in the receipt. Its completed success report, completed provenance, finished log marker and final identity assertions establish the recorded qualification.

## Publication and scope

The later #915 commit `41f17da88a30b10c38ecabddf6820dd2dbe35e13` only aligns four README table lines after a CI formatting failure. That documentation change is recorded separately from the validated source tree; runtime bytes are identical.

The evidence archive excludes dictionary fixtures, installed packages, browser profiles, runtime binaries and decoded fixture payload responders. Unpack it before following its README and reproduction scripts.

These are correctness results. The all-corpus native byte-parity replay and the VNDB retained-catalog memory screen are separate measurements linked from the implementation PRs. This evidence does not establish complete-import speedups or browser peak-memory improvements.

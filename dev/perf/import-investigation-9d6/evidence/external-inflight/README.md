# External in-flight import qualification: independent audit

**No replicated complete-import gain was established for JMdict, Jitendex or VNDB.** Both VNDB hosts additionally failed the unchanged sampler coverage gate. Their results do not establish either increased or unchanged peak memory use.

This is an independent review of the concurrent external runtime candidate `b4d0f54e23f8d4065df33bd40f5ea299bad57c6b`, not a new candidate or cohort. The original qualification is [run 46104891607](https://github.com/ManabiIO/manabitan/actions/runs/46104891607), tooling commit `154c06d0784c2d9b6d06fb0c22921d59acc95710`, against frozen baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The separately developed in-flight component optimization was held because its observed production mechanism materially overlapped this external candidate. This completed endpoint evidence does not support reviving a duplicate PR.

## Complete-import results

Each cell contains 12 fixed balanced A/B/C blocks. A and C use the identical baseline package; B uses the candidate. Host 2 reverses each registered order. Every observation uses a fresh browser profile. Three registered warmups per cell precede the authoritative blocks. Percentages below are median paired changes; negative is faster. Brackets show the original descriptive 95% percentile bootstrap interval, independently reproduced with the frozen seed and algorithm. These are per-host results, with no pooling or control subtraction.

| Dictionary / host | B/A | B/C | C/A control | Faster pairs B/A, B/C |
|---|---:|---:|---:|---:|
| jmdict / 1 | -0.646% [-5.235%, +1.903%] | -0.454% [-1.596%, +2.570%] | -0.781% | 7/12, 7/12 |
| jmdict / 2 | +0.427% [-0.534%, +1.428%] | +0.078% [-2.605%, +1.017%] | +1.664% | 6/12, 6/12 |
| jitendex / 1 | +0.529% [-1.109%, +2.625%] | -0.617% [-3.597%, +1.756%] | +1.042% | 5/12, 8/12 |
| jitendex / 2 | -1.704% [-2.094%, +0.114%] | -0.738% [-2.555%, -0.024%] | -0.016% | 9/12, 9/12 |
| vndb / 1 | +0.484% [-0.161%, +1.536%] | +0.618% [-1.427%, +2.746%] | -0.319% | 4/12, 6/12 |
| vndb / 2 | +0.492% [-3.277%, +1.947%] | -1.509% [-2.200%, +1.343%] | +1.381% | 4/12, 8/12 |

JMdict changes direction between hosts: small favorable medians on host 1 and small unfavorable medians on host 2. Jitendex host 1 disagrees between controls, while host 2 is favorable. VNDB host 1 is unfavorable against both; host 2 disagrees between controls. No dictionary shows a replicated favorable result against both controls on both hosts.

All tails remain. JMdict host 1 includes C/A blocks of −19.617%, −12.869% and +33.212%; host 2 includes a first-block C/A change of +16.105%. Equal-work totals and every individual ratio remain in `summary.json` and the per-cell audit files. No observation was removed and no replacement cohort was acquired.

## Memory qualification

All 24 separate memory imports completed and retained their raw scans. The unchanged auditor independently reproduced 2,098 scans. Both JMdict hosts and both Jitendex hosts passed the prospective PSS/private-memory screen: qualified coverage, median paired increase at most 5%, and every paired increase at most 10%.

**The two VNDB failures are sampler coverage failures, not measured memory growth.** The registered maximum covered import scan gap is 250 ms. The failed observations below retain null maxima and null paired memory changes. They were not repaired, treated as zero, excluded, or rerun.

| VNDB host | Observation | Maximum covered scan gap | Failure |
|---|---|---:|---|
| 1 | B1 | 259.348316 ms | Coverage gap exceeds 250 ms |
| 1 | A2 | 255.797422 ms | Coverage gap exceeds 250 ms |
| 2 | B1 | 253.588202 ms | Coverage gap exceeds 250 ms |
| 2 | A1 | 262.712629 ms | Coverage gap exceeds 250 ms |
| 2 | A2 | 379.287351 ms | Coverage gap exceeds 250 ms |
| 2 | B2 | 316.988468 ms | Coverage gap exceeds 250 ms |

VNDB host 1 has two qualified observations (A1 and B2), but neither complete A/B pair qualifies. Host 2 has no qualified observation. Both original failure records, complete failed-job logs, observations, comparisons and original raw scan data are included. The original driver correctly ended both jobs with failure after retaining every timing observation.

## Lookup and correctness checks

All 282 raw import reports passed independently recomputed semantic checks, including row/output digests, post-restart lookup results, storage identity, and the appropriate media checks. Twelve separate exhaustive-media imports cover both runtime arms on both hosts for each dictionary. In particular, every VNDB exhaustive pass checks all 146,570 media files (188,131,284 bytes); Jitendex checks all 236 files (4,992,155 bytes).

First-pass timing is a separate diagnostic: the sum of 12 settings-page lookup RPCs after restart, followed by five warm passes. It is not part of import time, and no lookup improvement is claimed. Unfavorable directions remain visible. For example, JMdict host 1 first-pass medians are +59.791% versus A and +38.329% versus C, with both descriptive intervals crossing zero; the identical-code control median is −20.119% with a very wide interval. All six cells retain exact first-pass and warm-pass comparisons in their audits and `summary.json`.

The separate correctness job `140855308314` checked the exact external runtime commit and passed scoped ESLint, all 670 unit-test files (15,159 tests passed, 47 skipped), both main/test TypeScript checks, and all seven dry build targets. The complete log and its SHA-256 receipt are included. Intentional negative-test stderr and dependency deprecation warnings remain in that log; the required job steps concluded success.

## What was independently verified

Each artifact was downloaded through the normal GitHub artifact interface and its complete ZIP size and SHA-256 verified against the API metadata before use. The audit then checked immutable source/tooling commits, frozen protocol and fixture lock, every package member, the sole runtime package difference (`js/dictionary/dictionary-database.js`), unchanged native assets, the exact 39-observation schedule, and all 130 recorded command outcomes per cell. It recomputed canonical receipts from the original ordinary/media/memory report JSON, separately checked trace-run semantics, reproduced the original paired statistics, and reran the unchanged memory auditor over the original scans. No new browser run, benchmark, trace or production change was made.

Across six cells, this covers 216 authoritative timing imports, 18 fresh-profile warmups, 12 exhaustive-media imports, 24 separate memory imports and 12 diagnostic trace imports: 282 reports and 780 successful recorded commands. A successful semantic/identity audit is distinct from passing the memory qualification gate.

## Artifact identities

| Cell | Original GitHub artifact ID | ZIP bytes | SHA-256 |
|---|---:|---:|---|
| jmdict-host-1 | 15250096690 | 36807670 | `a73ccdf897c326ef064ca01aa8281e42c349f47ecb0947fc6c0e710f6a0fb9a5` |
| jmdict-host-2 | 15249710714 | 36760527 | `99ba70ce3bd42fd4f87eef0d5deca5c072be3bd77ae65f527e84cba389d0ac7f` |
| jitendex-host-1 | 15248961251 | 37540812 | `c8861d530ed1e1fc1dce3a9105f8268347551003a698981da03669cebf407b54` |
| jitendex-host-2 | 15248728412 | 37642424 | `c6b08aeff21e4ca4e129d1ec16e4bf6be296e0595e2bae293a44840f9f8db80f` |
| vndb-host-1 | 15249739199 | 40320665 | `33100fa100da82a7ff59ca9ec37f027f1ca44c288675de4d2ba838f86f28921a` |
| vndb-host-2 | 15250228392 | 40464609 | `0ea5369b829c214d1e87eae0593faae90ce1f7b68787f44c0385314120918ad5` |

## Appendix contents and reproduction limits

`cells/<cell>/original/` retains every original JSON/JSONL report, canonical receipt, raw memory scan, command record/log and frozen workflow/protocol/helper text. The original failure files are retained. `cells/<cell>/audit/` contains the independent audit, verified download receipt, and SHA-256 inventory of every original artifact member. Shared audit scripts, the complete correctness log, final disposition, workflow API snapshot and this summary are included.

The compact appendix omits only the two built product ZIPs, two large CPU-trace payloads and 47 rendered HTML duplicates per cell. Their complete original artifact and member hashes remain recorded in `source-map.json` and the per-cell inventories. Full verified ZIPs remain retained locally and identified by their original GitHub artifact IDs. The compact appendix therefore supports inspection/recalculation of timings and memory directly; independently repeating the original package-byte audit additionally requires those original full ZIPs. The included audit scripts are the exact scripts used and retain their recorded local checkout paths; adapting those paths for another machine does not change the frozen protocol or source identity checks.

This appendix is separate from the earlier completed-study archives. It does not replace, amend or relabel prior receipts. `MANIFEST.json` records the size and SHA-256 of every included payload; the external publication receipt binds the completed archive itself.

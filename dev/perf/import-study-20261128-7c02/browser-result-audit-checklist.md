# Independent browser-result audit checklist

This is a saved-result audit plan for the unchanged six-job path-projection campaign. It adds no experiment, acquisition, threshold, source change, or qualification gate. It does not itself establish a result. Audit each hosted cell independently and preserve the original artifact before writing any derived report.

## 1. Authority and acquisition identity

The authoritative policy is `remote-policy.md` in this directory, copied from `dev/perf/path-qualification-7c02/README.md` at research commit `d36ee85feb1513af31f769175affa33b3696a307`. The saved workflow is `../path-hosted/validation-workflow-d36ee85.yml`. Its current run is `46113567719`. `../path-hosted/plan.md` is a historical, superseded a819 candidate plan; retain it unchanged and do not use its candidate identity for this campaign.

| Identity | Required value |
|---|---|
| Baseline A and identical control C | `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` |
| Candidate B | `e90c4c04172b691985858609094887f9541541dd` |
| Candidate tree | `586061b2dfb33d9ebd3fc12a340f4def5a09abea` |
| Cells | JMdict, Jitendex, VNDB, each on separate AB and BA hosted jobs |
| Runtime | Node `v22.22.0`; lockfile Chromium, expected `153.0.8010.12` / revision1243; retain actual binary SHA and version |
| Product policy | Flags `{}`; three parser workers; Chrome build; fresh profile per import |
| Changed package entries | Only `js/dictionary/term-bank-wasm-parser.js` and `js/dictionary/term-bank-wasm-parser-worker.js` |

Record artifact ID, name, download digest, job/run/head identity and acquisition status before interpreting its contents. Expected names are `parser-path-qualification-7c02-<dictionary>-<AB|BA>`. A successful workflow conclusion is not a substitute for the raw receipts. Do not pool hosts, subtract control drift, remove outliers, retry failed slots, substitute jobs, or add observations.

## 2. Complete artifact and source boundary

Retain `setup.log`, `browser-setup.log`, `acquisition.log`, `cell-summary.json`, and the entire `result/` tree. A complete result contains:

- `registered-plan.json`, `source-identities.json`, `browser-identity.json`, `package-A.zip`, `package-B.zip`, `observations.json`, and `analysis.json`.
- Every ordinary slot's `summary.json`, `run-1.json`, `canonical-receipt.json`, `run.log`, `host-before.json`, and `host-after.json`.
- `exhaustive-media-A/` and `exhaustive-media-B/` receipts and logs.
- The complete `memory/` subtree, including raw scans and markers, both harness copies, and every failure/partial receipt.

Match `registered-plan.json` fields `baseline`, `candidate`, `dictionary`, `initialOrder`, `pairs:12`, `flags:{}`, `expectedWorkers:3`, `expectedPackageEntries`, and both schedules to the frozen workflow. For VNDB require `vndbSahAllocationPolicy` with `unitBytes:4096`, `rangeUnits:[36,38]`, `origin:"explicit"`; other dictionaries use null.

Rehash each package and its complete entry map. Match `source-identities.json.arms.A/B` source/tree/package/lock/fixture-lock/source hashes, and require the exact two-entry changed set. C must use A's source and package. Independent package ZIP archives may have different archive bytes across hosts; bind every package to its own cell's receipt and source rather than inventing a cross-host ZIP-byte gate. Bind all observation provenance back to these identities.

The unchanged source validators are `qualification_receipts.py`, `protocol.py`, and `audit_memory.py` under `manabitan/dev/perf/import-memory-20261125-a7f7/`. Their exact hashes, the top-level runner, policy, workflow and summarizer are pinned in `browser-result-audit-preparation.json`.

## 3. Exact schedule, not merely a count

Each cell has 42 imports: **36 ordinary slots**, two separate all-media imports, and four separate instrumented memory imports. Match the ordered `id`, `kind`, `pair`, and `arm` tuples of all 36 `observations.json` rows to the registered schedule and the frozen construction below. Reject duplicates, foreign IDs, missing slots, reordering, mismatched pair numbers or extra replacements even when aggregate counts happen to match.

| Ordinary stage | Exact construction |
|---|---|
| Excluded warmups | `warmup-1-<arm>` in initial order, then `warmup-2-<arm>` in opposite order; kind `warmup` |
| Twelve candidate pairs | `pair-01-<arm>` through `pair-12-<arm>`; odd pairs initial order, even pairs opposite; kind `candidate` |
| Four interleaved controls | Immediately after candidate pairs3,6,9,12: `control-01-<arm>` through `control-04-<arm>`; kind `control`; AB host uses AC,CA,AC,CA; BA host uses CA,AC,CA,AC |

The complete ordinary schedule contains four warmups, 24 A/B candidate observations and eight A/C controls. The existing `cell-summary.json.complete` checks paired counts and B/C counts; it does **not** independently prove this full schedule identity.

All-media imports follow ordinary timing in the initial A/B order. Memory follows media: AB host is `A1,B1,B2,A2`; BA host is `B1,A1,A2,B2`. Memory pairs are adjacent positions1–2 and3–4, with the exact `index`, `name`, `arm`, and `pair` fields from `protocol.schedule`. None of the warmup, media or memory durations enters ordinary latency statistics.

## 4. Native import, timing and correctness receipts

Use the frozen `validate_import_summary` and `require_matching_receipts` rules, with the locked fixture object and cell-bound source/package identities. Bind every observation's `totalImportMs` to `summary.runs[0].totalImportMs` and the raw browser timing receipt; do not substitute automation elapsed time, worker time, a phase duration, or trace time.

Required summary/report facts include schema3; one run with index1; Chrome/Chromium headless; status success; verification not skipped; pinned fixtures; production defaults; no trace, profiling, screenshots or product instrumentation; `importFlags:null`; media mode sample or all as appropriate; correct source/package/browser identity; and Node `v22.22.0`. Empty plan flags `{}` deliberately become native `importFlags:null` because no flag option is passed.

The authoritative boundary is `page file-input change event to post-UI import-complete event; browser monotonic clock`. Check the unique total-import and file-input phases, valid sequence progression, zero import errors, and `completedAtMs-startedAtMs` agreement within0.001ms. Ordinary and exhaustive source receipts must be clean. Memory's deliberate harness overlay is separately hashed and dirty; that exception does not extend to ordinary timing. `step4Breakdown.dictionaries[0].parserWorkerCount` must be3.

Canonical receipts retain `browserVersion`, `common` and `media`. `common` includes the dictionary, full fixture, flags and complete validation object except media. The validator removes lookup elapsed times and normalizes only verified opaque SQLite/media-generation names. It retains exact sizes and all remaining semantic fields. Do not add broader normalization.

| Dictionary | Term rows | Unique media files | Media bytes |
|---|---:|---:|---:|
| JMdict |528299|0|0|
| Jitendex |436555|236|4992155|
| VNDB |6648310|146570|188131284|

Require title/revision/row counts, readable content, 12 distinct probes, matching `outputDigestSha256`, and successful restart/readback. Lookup receipts must cover72 calls:12 terms over six passes, with positive results, exact-headword checks and consistent counts/digests for each term. Match ordinary canonical receipts exactly across A/B/C, including restart, lookup digests and storage.

Sample media checks cover `min(64,totalFiles)` with exact total-file/byte counts. Separate all-media checks must verify every file and byte. Compare their non-media `common` receipts to ordinary results, then compare the complete exhaustive A/B receipts. VNDB's146725 projection rows from the separate component/copy study are not its146570 unique media files.

Storage requires the exact known OPFS logical inventory after restart, unique expected paths, byte sums, seven4096-byte empty SAH files and one aligned active file. **VNDB's36–38-page range admits an individual active-file size; the later cross-observation canonical comparison still requires exact storage sizes. It is not a ±1-page cross-arm allowance.** Preserve unexpected files, allocation differences and every failure. Use `canonicalize_storage`, not an independently loosened filename rule. Existing format/corruption checks remain required through the frozen harness and validation evidence; do not invent a nonexistent separate `corruptionPassed` artifact field.

## 5. Independent memory audit: both PSS and private bytes

Read `memory/plan.json`, `observations.json`, `memory-comparison.json`, `memory-audit.json`, `semantic-failures.json`, the original/instrumented harness pair, and each slot's `memory.json`, `markers.jsonl`, import summary/report/receipt and log. Bind plan/source/overlay hashes and exact ABBA/BAAB slots. `semantic-failures.json` must be empty, and no incomplete/audit/sampling failure may be silently ignored.

Use the pure `audit_memory.audit_cell` function to recompute stored scan sums, process identities/parentage/roles, discoveries before/after, marker binding, coverage, qualification failures, maxima and paired arithmetic. Its CLI writes the artifact's `memory-audit.json`; do not run that CLI over the original downloaded evidence.

Each memory receipt must have schema3, observer rule `import-window-stable-single-thread-zombie-esrch-v1`, benchmark exit0, `authoritativeTiming:false`, `qualifiedForWholeTreePss:true`, and no qualification failures. Require two valid ordered window markers, qualified before/after brackets no more than250ms away, at least five stable fully read import-window scans, and maximum covered gap≤250ms. Only qualified scans wholly within the marked window contribute to maxima. Denied/unreadable stable address spaces and incomplete process identities invalidate coverage; retain only the existing narrowly proved exited-single-thread-zombie ESRCH exception.

Independently gate **both** `maxSampledPssKiB` **and** `maxSampledPrivateKiB`. For each adjacent pair calculate `100*(B/A-1)`, with finite positive A and finite nonnegative B. Each metric's median paired increase must be≤5%, and maximum paired increase≤10%. Require all four observations, `everyObservationQualified:true`, `passesProspectiveMemoryScreen:true`, and agreement with `analysis.memoryPassed` and the raw audit.

These are sampled whole-discovered-browser-tree PSS and private-byte maxima from non-atomic scans; they are not exact peak memory or whole-system RSS. The import harness is unaware of the external sampler, so its embedded native benchmark may still report `authoritativeTiming:true` and `processSampling:false`. The outer memory plan/receipt and dirty overlay provenance make those observations non-authoritative for latency. Never put their durations into ordinary comparisons.

## 6. Recompute ordinary statistics per host

Use only kind `candidate` for B/A and kind `control` for C/A, preserving full pair identity. Match all saved `ratios`, counts, median, equal-work change, worst pair, faster-pair count and interval endpoints in `analysis.json`.

- Ratio is right/left within each pair. Median change is `100*(median(ratios)-1)`; equal-work change is `100*(sum(right)/sum(left)-1)`; faster means ratio strictly less than1.
- Reset `random.Random(897)` separately for candidate and control summaries. Draw10000 complete-pair resamples with replacement via `rng.choices(ratios,k=len(ratios))`; sort their medians and use indexes249 and9749 for the descriptive interval. Do not replace this with interpolated quantiles or a different seed.
- Recompute `candidateMedianVsControlCPercent` as `100*(median(all12 candidate B times)/median(all4 control C times)-1)`.

Do not import the top-level acquisition runner merely to reuse `paired_summary`: it performs acquisition actions at module scope. The published summarizer also writes `cell-summary.json`; preserve original evidence and write independent calculations to a separate audit location.

## 7. Decisions fixed before results

All rows below are per host. A review recommendation requires the first three gate rows on **all six hosts**, plus previously required validation and the complete actual-worker copy oracle. The stronger speed claim requires the final row on **both VNDB hosts**.

| Gate | Exact requirement |
|---|---|
| Complete correctness and memory | Exact schedule/source/package/fixture/semantic/media/storage checks; status `correctness-memory-passed`; `memoryPassed:true`; all four memory slots and both memory metrics pass |
| Unchanged control | Four A/C pairs; absolute median C/A change≤5% |
| Non-regression | Median B/A change≤+3%; equal-work change≤+3%; descriptive bootstrap upper endpoint≤+5% |
| Stronger VNDB whole-import gain | Median B/A change≤−5%; B median versus C median≤−5%; at least10/12 B/A pairs faster; equal-work change<0; descriptive bootstrap upper endpoint<0 |

A non-regression pass alone does not establish a speedup. If all six mandatory screens pass but either VNDB host misses the stronger gate, root may evaluate review worthiness only on the separately qualified projection-helper CPU gain and code complexity, explicitly stating that reliable whole-import improvement was not established. No PR follows automatically.

## 8. Failure interpretation and current preparation status

Keep each artifact intact, including logs, partial observations and failed setup/validation. Missing analysis means incomplete qualification. `memory-or-semantics-failed` may coexist with a complete ordinary timing cohort; retain those values but do not qualify the candidate. Report per-cell results and reasons without pooling or filtering. Missing data is not zero, and absence of a persisted phase receipt does not establish where a terminated process stopped.

Static preparation found no new protocol blocker. The notable audit traps are the historical local plan, count-only summary completeness, the two separate memory metrics, exact storage equality despite a per-observation range, and helper CLIs that overwrite saved output. These are addressed here without changing the frozen campaign. No browser acquisition, native execution, test, benchmark, threshold change or source modification was performed for this checklist.

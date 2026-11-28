# Browser results addendum: 2026-11-28 06:46:37 UTC

This is a separate, source-bound addendum for three newly completed browser cohorts: **local index checkpoints on JMdict and Jitendex**, and **content-persistence overlap on VNDB**. It preserves every raw observation, the complete memory scan rows and the failed gates. It acquires no new observations and does not alter any source, protocol, threshold or earlier result.

The [earlier session snapshot](https://github.com/ManabiIO/manabitan/tree/0df239a1be2cde2fc8586665413b7da7845f9fb6/dev/perf/import-evidence-20261128-1b47) remains immutable at commit `0df239a1be2cde2fc8586665413b7da7845f9fb6`. Its archive SHA-256 is `eed792a9c77ffcdc65fcffa2106157b365dc8a56369a06bcd640d1b6ba060f8b`; this addendum does not rewrite that archive or its 06:32:35 status snapshot.

**Decision:** close the local-checkpoint candidate without a PR. The completed timings do not support its JMdict hypothesis, independently of the additional memory-sampling failures. Pipeline VNDB is a passing but flat control in which the new overlap does not activate. Pipeline JMdict was still running its unchanged qualification at this addendum's cutoff; score-restoration, CRC and compression browser studies remained queued. Their eventual qualification must be examined separately.

## Exact studies and results

All studies compare against baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Negative timing changes mean faster. These are paired statistics from independent hosts/cohorts, never pooled.

| Study / corpus               | Candidate                                  | Actions run / job              | Paired median B/A | Equal-work change | Descriptive 95% paired-median interval | Identical-code median |
| ---------------------------- | ------------------------------------------ | ------------------------------ | ----------------: | ----------------: | -------------------------------------- | --------------------: |
| Local checkpoints / JMdict   | `0efd7507eb19b0b7f15410b14aac427e80e22244` | `46104738613` / `140863903055` |           −0.347% |           +0.175% | [−1.264%, +2.173%]                     |               +1.567% |
| Local checkpoints / Jitendex | `0efd7507eb19b0b7f15410b14aac427e80e22244` | `46104738613` / `140863903001` |           −1.753% |           +1.382% | [−3.972%, +9.805%]                     |               −1.344% |
| Content pipeline / VNDB      | `05907e30c83b4cc7cc8d653e069427a6141b0e85` | `46105215670` / `140867306576` |           −0.649% |           −0.207% | [−1.296%, +1.379%]                     |               −0.273% |

Each cohort completes its fixed six candidate pairs, two identical-code pairs, excluded warmups, two exhaustive-media imports and four separate memory imports. All **78 raw browser reports and canonical receipts** across these three cohorts pass the unchanged semantic validator. Independent audits reproduce exact source/package bindings, package member hashes, declared work, storage, media/restart receipt comparisons, schedule and paired timing calculations. All observations, including unfavorable tails, remain.

### Local checkpoints: hypothesis not supported

Every JMdict and Jitendex report selects the local writer. The candidate adds 8 MiB periodic checkpoints to the baseline's final-only local flush behavior. The repeated JMdict cohort has baseline record-close median **8.65 ms**, rather than the motivating single orientation observation's 130.6 ms. Candidate close median is 4.30 ms, with paired close delta median −4.45 ms, but whole import remains flat. An inclusive tail becoming shorter does not establish an overall saving when the work can move earlier; overlapping end-phase timings are not summed.

The separate memory screen fails on JMdict candidate B1's **414.681 ms** covered-import sampling gap and Jitendex candidate B2's **303.792 ms** gap. Both exceed the prospectively fixed **250 ms** coverage limit. Their qualified memory maxima remain null and their complete memory comparisons fail. These are sampling qualification failures, not browser import or semantic failures, and are not waived.

The included all-corpus checkpoint disposition also references the previously completed VNDB control: its median timing change was −0.714% with an interval spanning zero, and its memory gates passed. Every VNDB report selected the unchanged remote-worker policy, so that earlier cohort does not demonstrate the local checkpoint mechanism. No checkpoint PR, retry or further acquisition follows.

### Pipeline VNDB: passing inactive-path control

The VNDB cohort passes all frozen semantic, coverage and sampled-memory bounds, but establishes no useful speed gain. All 11 candidate observations have **91,670,244 owned parser bytes** and **zero recent-source adopted bytes, deferred-persistence operations and deferred wait**. Ownership alone does not satisfy the admission gate; the new cross-chunk overlap never activates. This result cannot establish the hoped-for JMdict benefit.

All four VNDB memory observations qualify. Sampled private-memory change is median +1.036397%, maximum +2.939798%; sampled PSS change is median +0.616478%, maximum +2.270618%. These are maxima among non-atomic sampled process-tree readings, not exact process peaks.

## Raw data preserved

For each original 206-member Actions artifact, the addendum preserves **all 204 members other than the two duplicate extension package ZIPs**. This includes the HTML report views as well as raw JSON, canonical receipts, full memory JSON with every process/scan row, marker JSONL, instrumented memory harness, original plans, source/package identities, fixed analyses and logs. Original artifact-relative paths are preserved below a clearly named cohort prefix in `raw/`; the mapping receipt records each original path and original SHA-256.

| Cohort              | Artifact ID | Original artifact bytes | Original artifact SHA-256                                          | Raw memory scans included |
| ------------------- | ----------: | ----------------------: | ------------------------------------------------------------------ | ------------------------: |
| Checkpoint JMdict   | 15252595561 |              34,925,936 | `b5027ed6926b013c9873d0f28788af751c7e4106da189ddd3150b5b1444ffb7e` |                       250 |
| Checkpoint Jitendex | 15252102052 |              34,989,076 | `afe3dcc1168585abac294a56b66db2a06d9f3347e2c06deda7ba90382c469256` |                       299 |
| Pipeline VNDB       | 15252770740 |              35,215,591 | `3eaa1db3589e59d913e320861c7ec37cdf3ba3113d62a87a3ae95947a44ea74e` |                       503 |

All **1,052 raw scan rows** are retained, including rows that lead to failed coverage. No missing/unqualified memory maximum is imputed. The older checkpoint VNDB and pipeline Jitendex cohorts remain separate in the prior snapshot; this addendum does not pool their data with these three cohorts.

The exact six omitted package ZIP sizes and SHA-256 digests, complete package entry hashes and expected entry differences remain in the original source identities, independent audits, staging receipt and external manifest. Their original bytes were verified during artifact auditing. Omitting duplicate ZIP payloads is not an assertion that a later rebuild would reproduce their container timestamps or ZIP digest. Exact future re-verification of those omitted bytes requires the original source-bound artifact; the raw report/memory data in this addendum remains independently inspectable without those ZIPs.

## Cutoff and source of summaries

`snapshots/evidence/` contains byte-for-byte copies of the live readout, inventory, ledger, publication addenda, all-corpus checkpoint disposition, the three stable receipt directories and `hosted-import-screens-status-20261128064637.json`. Their original relative paths and source hashes are recorded. Later job completions require a new dated addendum and must not be retrofitted into this one.

The prior snapshot at `0df239a1…` and the complete held-cache archive at `5c980635c4a4aaf581ad8e2b16a311a47c6241aa` remain separate immutable evidence. Score restoration and CRC component archives remain bound to `3c3ba7600a8811df6b8631b72a0ac5379f8b60d1`. None of those component findings substitutes for pending browser qualification.

## Verify and reproduce the audit

The external manifest binds the complete deterministic tar.gz and **every member's size and SHA-256**, without a self-hash exception. No symlink is followed. The staging receipt additionally proves each retained original ZIP member matched the independent artifact inventory before copying. The archive preserves those copied bytes without rewriting JSON or normalizing samples.

```sh
python3 evidence/durable-bundles/package-evidence-v2.py \
  --verify-manifest /absolute/path/browser-results-addendum-20261128-1b47.manifest.json
```

The original read-only auditor and exact baseline validator dependencies are included. To repeat its complete audit, obtain the original Actions artifact, check the SHA-256 shown above, and use a new output/extraction directory:

```sh
python3 evidence/audit-hosted-import-artifact-1b47.py \
  --archive "$ARTIFACT/checkpoint-1b47-screen-jmdict-15252595561.zip" \
  --expected-sha256 b5027ed6926b013c9873d0f28788af751c7e4106da189ddd3150b5b1444ffb7e \
  --dictionary jmdict \
  --baseline-root "$REPLAY/manabitan" \
  --extract "$REPLAY/checkpoint-jmdict-audit" \
  --output "$REPLAY/checkpoint-jmdict-audit.json"
```

Use baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`; the auditor checks its validator files against Git before importing them. Substitute the corresponding artifact, digest and dictionary for the other two audits. It validates actual package bytes/member identities, all 26 raw report/canonical-receipt comparisons, all memory scan rows and exact fixed paired statistics. A failed memory gate is an expected reproduced result for both checkpoint cohorts, not a reason to modify the rule.

For raw inspection without downloading the original ZIP, use the included `raw/<cohort>/<dictionary>/` records and the unchanged memory audit modules. The original package-byte proof remains an explicitly retained earlier audit in that case. Do not overwrite original analysis, relax coverage, select successful samples, replace slow observations or combine hosts. This addendum contains no new performance acquisition.

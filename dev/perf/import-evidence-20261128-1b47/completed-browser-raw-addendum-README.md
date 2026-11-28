# Completed browser raw-data addendum: pipeline JMdict/Jitendex and checkpoint VNDB

This addendum preserves the completed JMdict pipeline result and closes two raw-data preservation gaps. It contains every original non-package member from three audited Actions artifacts: **78 raw browser reports, 78 canonical receipts, all 1,025 memory scan rows, the original plans, complete timing/control records, HTML report views, logs, and failed qualification records**. No observation was acquired, replaced, excluded, or retried while preparing this bundle.

The observation/status cutoff is **2026-11-28 06:58:33 UTC**. Independent source review and technical synthesis are identified separately from measurements. At this cutoff the nine score-restoration, CRC, and compression browser jobs were queued; this archive contains no inferred result for them.

The targeted JMdict pipeline candidate does **not** establish a useful whole-import gain. Its complete timing is flat, independently of a separate memory-sampling coverage failure. The all-corpus pipeline readout supports no pipeline PR or further acquisition. The checkpoint experiment was already closed without a PR. These dispositions concern the exact frozen candidates and cohorts, not every possible implementation of overlap or checkpointing.

## Coverage and relation to earlier evidence

The earlier session archive retained compact, independently audited pipeline Jitendex and checkpoint VNDB receipts and full member hashes, but not their original `memory.json` rows. This addendum supplies all missing original non-package members for those two cohorts. The initial plan to package only final pipeline JMdict was superseded **before packaging**, as recorded in `preparation-scope-history.json`.

Together with the already published three-cohort browser addendum, all **156 raw reports, 156 canonical receipts, and 2,077 memory scan rows across the six completed checkpoint/pipeline cohorts** are durably recoverable. The original sampled rows remain separate by cohort and observation; this preservation count is not a pooled performance analysis.

| Cohort              | Raw reports / canonical receipts | Memory scan rows | Durable location                       |
| ------------------- | -------------------------------: | ---------------: | -------------------------------------- |
| Pipeline JMdict     |                          26 / 26 |              328 | This addendum                          |
| Pipeline Jitendex   |                          26 / 26 |              276 | This addendum                          |
| Checkpoint VNDB     |                          26 / 26 |              421 | This addendum                          |
| Checkpoint JMdict   |                          26 / 26 |              250 | Earlier browser addendum at `28332c2f` |
| Checkpoint Jitendex |                          26 / 26 |              299 | Earlier browser addendum at `28332c2f` |
| Pipeline VNDB       |                          26 / 26 |              503 | Earlier browser addendum at `28332c2f` |

Immutable earlier evidence:

- [Three-cohort browser README](https://github.com/ManabiIO/manabitan/blob/28332c2fc3a291f1728cd0441a878e3d5bd335ae/dev/perf/import-evidence-20261128-1b47/browser-results-addendum-README.md), [archive](https://github.com/ManabiIO/manabitan/blob/28332c2fc3a291f1728cd0441a878e3d5bd335ae/dev/perf/import-evidence-20261128-1b47/browser-results-addendum-20261128-1b47.tar.gz), and [complete member manifest](https://github.com/ManabiIO/manabitan/blob/28332c2fc3a291f1728cd0441a878e3d5bd335ae/dev/perf/import-evidence-20261128-1b47/browser-results-addendum-20261128-1b47.manifest.json). Its archive SHA256 is `76b1ae9451052684192902916b5cdeb1e812ff806b064d0773e6d2bdf242ec98`.
- [Earlier session snapshot](https://github.com/ManabiIO/manabitan/tree/0df239a1be2cde2fc8586665413b7da7845f9fb6/dev/perf/import-evidence-20261128-1b47), containing the bounded component studies, unsuccessful variants, validation history, and the earlier compact browser audits.
- [Held score-cache evidence](https://github.com/ManabiIO/manabitan/tree/5c980635c4a4aaf581ad8e2b16a311a47c6241aa/dev/perf/import-evidence-20261128-1b47), including exact numeric inputs and the failed prospective common-path gate.
- [Published JMdict technical assessment](https://github.com/ManabiIO/manabitan/blob/9b1fd740e07cf43c38edcb7cdca41b23a3227fec/dev/perf/import-evidence-20261128-1b47/jmdict-technical-assessment.md), a separate read-only synthesis with immutable evidence/source citations and no new experiment.

No earlier archive or source candidate was modified by this addendum.

## Exact source and protocol boundaries

All three cohorts use baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Each revision was built independently before observations. There were no product overlays or unregistered harness changes during acquisition. Timing and exhaustive-media imports used the frozen harness; the separate memory imports used the registered marker-only harness overlay.

| Study             | Candidate commit                           |                                                                   Actions run |            Job |
| ----------------- | ------------------------------------------ | ----------------------------------------------------------------------------: | -------------: |
| Pipeline JMdict   | `05907e30c83b4cc7cc8d653e069427a6141b0e85` | [46105215670](https://github.com/ManabiIO/manabitan/actions/runs/46105215670) | `140867306619` |
| Pipeline Jitendex | `05907e30c83b4cc7cc8d653e069427a6141b0e85` | [46105215670](https://github.com/ManabiIO/manabitan/actions/runs/46105215670) | `140867306558` |
| Checkpoint VNDB   | `0efd7507eb19b0b7f15410b14aac427e80e22244` | [46104738613](https://github.com/ManabiIO/manabitan/actions/runs/46104738613) | `140863903012` |

Each fixed per-host plan contains four warmups, six alternating AB/BA candidate pairs, two interleaved identical-code A/C pairs, two separate exhaustive-media imports, and four separate instrumented-memory imports. Thus all 20 planned warmup/timing/control observations and six verification imports are retained per corpus. All 26 raw reports and canonical receipt comparisons pass for each cohort. Actual package ZIP and entry hashes were independently checked against the declared source identities.

The original statistics remain unchanged: paired median and equal-work changes, with a descriptive percentile-bootstrap interval for the paired median from 10,000 complete-pair resamples and seed 897. Memory runs do not contribute timing. Cohorts, controls, and component observations are not pooled. Complete timing remains available even where the later, separate memory gate fails.

## Results retained without selective replacement

Changes below are candidate versus baseline; negative timing changes are faster. Each row is a separate six-pair cohort.

| Cohort            | Paired median | Equal work | Descriptive 95% paired-median interval | Identical-code median | Memory qualification                  |
| ----------------- | ------------: | ---------: | -------------------------------------- | --------------------: | ------------------------------------- |
| Pipeline JMdict   |    −0.226457% | +0.339459% | [−0.989230%, +2.273781%]               |            −0.573649% | Fails coverage in baseline A2         |
| Pipeline Jitendex |    +2.282204% | +3.692944% | [+0.698748%, +8.162554%]               |            +3.575834% | Fails coverage in baseline A1         |
| Checkpoint VNDB   |    −0.713613% | −0.185726% | [−3.955042%, +4.049349%]               |            +1.102087% | Passes frozen coverage and size gates |

For **pipeline JMdict**, four of six candidate pairs are faster, but the equal-work estimate is slower and the interval spans zero. The apparent median improvement is smaller in magnitude than the identical-code control improvement. The +4.290822% candidate tail remains included. This is no useful whole-import gain.

For **pipeline Jitendex**, all six candidate pairs are slower, including a +11.592612% tail. The identical-code pairs themselves range from −3.036771% to +10.188438%, limiting causal attribution and precision. The cohort supplies no improvement and does not establish a precise product slowdown.

For **checkpoint VNDB**, timing is flat within variation. All 26 reports select two dedicated index-worker files. The candidate changes the local checkpoint interval to 8 MiB while retaining the worker's 16 MiB policy, so the targeted local mechanism does not execute in this corpus. The passing VNDB control is not evidence that local checkpointing improves JMdict or Jitendex.

The preserved all-corpus pipeline readout also includes the separately archived VNDB result: paired median −0.648778%, equal work −0.207444%, interval [−1.295844%, +1.378595%], with passing memory qualification and an inactive deferred route. It does not change the pipeline disposition.

## JMdict source lifetime and overlap audit

Every one of the 11 candidate JMdict reports enters the eligible deferred route for all 12 groups. Each records 101,143,281 adopted source bytes, 101,143,985 owned parser bytes, zero borrowed groups, and 12 deferred-persistence entries. The archive preserves the complete per-observation census and the exact five hosted B source files used for the independent chain review.

The worker copies spans into retained Zstd memory and signals `source-consumed` before completing synchronous compression. The pool and its asynchronous wrappers carry **plain operation objects with separate source and completion promises**. Child-promise adoption preserves the early source signal. The block store forwards it explicitly; the database awaits record append and source consumption before retaining bounded deferred completion. Later publication and finalization still drain the outstanding operation. The audit found no custom Promise-property loss through an async wrapper.

These counters prove admission, not a measured duration of useful overlap. The deferred counter also increments when terminal completion may already have settled. All block copies must be acknowledged before the batch source barrier resolves, and a worker processes each prepare/compress job synchronously; earlier jobs on that worker may already have compressed before its last copy acknowledgment. Record work and message delivery can narrow the remaining interval. These are source-level limitations, not measured attribution. The hosted summaries lack per-group source-consumed, successor-dedup-start, and predecessor-completion timestamps, so no useful overlap duration is inferred.

Jitendex has zero owned/adopted/deferred bytes or operations and 22 borrowed groups in every candidate report. The separately archived pipeline VNDB cohort has owned parser bytes but zero adopted/deferred work. These are inactive-path controls. The exact JMdict result does not imply that every overlap design is ineffective. The retained technical assessment explicitly distinguishes the existing alternative in [draft #977](https://github.com/ManabiIO/manabitan/pull/977); it proposes no duplicate implementation or additive performance claim.

## Memory failures and limits

Pipeline JMdict baseline **A2** has a covered-import scan gap of **266.882013 ms**; pipeline Jitendex baseline **A1** has a gap of **350.393048 ms**. Both exceed the unchanged **250 ms** limit. Their sampled PSS/private maxima remain null, and the complete paired memory qualification remains failed. A surviving pair is not substituted for the fixed complete comparison. These are sampling-coverage failures, not measured memory regressions.

Checkpoint VNDB passes all frozen coverage and size gates. Its sampled private change is median +1.949324% / maximum +3.559963%, and sampled PSS change is median +1.799394% / maximum +2.735624%. These are non-atomic sampled maxima, not exact process peaks.

All **328 + 276 + 421** original scan rows, bound markers, nulls, failures, and successful rows are retained. No threshold was relaxed and no failed observation was replaced.

## Original artifacts, omissions, and layout

| Cohort            | Original artifact | Original ZIP bytes | SHA256                                                             |
| ----------------- | ----------------: | -----------------: | ------------------------------------------------------------------ |
| Pipeline JMdict   |     `15253035138` |         35,036,759 | `744ff32ffd1efe92626756eb1d8e636bb5cbffcfd7d491cf981182e01a83b0e9` |
| Pipeline Jitendex |     `15252160244` |         34,974,199 | `2cc1f7be18bd2a9afb1145020c6f854741762cdc863150f4cc15bc29cf430aa4` |
| Checkpoint VNDB   |     `15251240742` |         35,116,853 | `3342e9490f00283e96553f492236fae0c61b2723f81bd1fa5098e2934b91aedf` |

Each original artifact has 206 members. This archive retains **all 204 non-package members per artifact**, preserving each original member path beneath `evidence/completed-browser-raw-addendum-20261128-1b47/raw/<cohort>/`. The only omitted members are the six duplicate `package-A.zip` / `package-B.zip` extension packages. Their exact sizes and SHA256 values, full original package inventories, original artifact hashes, and independent verification results are in the external member manifest and retained audits. Dictionary/media ZIPs are not copied into this evidence archive.

The original outer ZIP containers are also omitted because their retained members are stored individually. The complete package-byte verification already performed by the independent audit is preserved. Repeating that particular check requires the exact original Actions artifact; a newly built package is not asserted to reproduce ZIP timestamps or container bytes. Raw report, receipt, memory, and timing analysis can be inspected directly from this archive without those duplicate packages.

Other retained material includes:

- `snapshots/evidence/`: unchanged receipts, full logs, original plans, source/package identity maps, all-corpus pipeline/checkpoint dispositions, independent reviews, technical synthesis, and the fixed status snapshot.
- `sources/candidate/ext/`: five exact files extracted from the verified hosted pipeline B package for the source-consumption chain audit.
- `validators/`: unchanged baseline receipt/memory validators, checked against their original Git bytes and recorded hashes.
- `staging-receipt.json`: every original-to-staged member mapping, hash, byte count, source binding, and row-count proof.
- `completed-cohort-durability.json`: the six-cohort coverage ledger tying this archive to the already published browser archive.

Historical local paths in original reports remain unchanged as provenance. They are not claims that those ephemeral directories will continue to exist. Symlink payloads are never followed.

## Verification and reconstruction

Download this README, `completed-browser-raw-addendum-20261128-1b47.tar.gz`, its `.manifest.json`, and its `.sha256` from the same immutable evidence commit. Verify the archive and manifest before extracting into a new directory:

```sh
sha256sum -c completed-browser-raw-addendum-20261128-1b47.sha256
tar -xzf completed-browser-raw-addendum-20261128-1b47.tar.gz
python3 evidence/durable-bundles/package-evidence-v2.py \
  --verify-manifest completed-browser-raw-addendum-20261128-1b47.manifest.json
```

The external manifest hashes every member without a self-hash exception. Gzip timestamps and tar metadata are normalized; payload bytes are unchanged. The verification helper checks the archive digest, exact member set, safe paths, sizes, and every member digest.

To repeat the original full artifact audit, obtain the exact Actions artifact above, verify its stated SHA256, and use an unchanged baseline checkout. For example:

```sh
python3 evidence/audit-hosted-import-artifact-1b47.py \
  --archive pipeline-1b47-screen-jmdict-15253035138.zip \
  --expected-sha256 744ff32ffd1efe92626756eb1d8e636bb5cbffcfd7d491cf981182e01a83b0e9 \
  --dictionary jmdict \
  --baseline-root /path/to/checkout-at-9e10d3b3 \
  --extract /path/to/new-audit-extraction \
  --output /path/to/new-independent-audit.json
```

Use the corresponding exact original ZIP/hash and dictionary for Jitendex or checkpoint VNDB. This is a read-only audit of retained observations, not a new benchmark. The preparation helper additionally documents how unchanged source receipts were staged and how all six cohorts' raw memory coverage was counted. No queued job, unexecuted proposal, or future result is treated as completed evidence here.

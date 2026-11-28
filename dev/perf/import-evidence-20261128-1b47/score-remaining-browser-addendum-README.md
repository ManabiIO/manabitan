# Indexed score validation: completed Jitendex and VNDB browser evidence

**Neither remaining corpus establishes a whole-import speedup. Jitendex retains an unresolved adverse timing signal.** This addendum completes the browser evidence for the two-line indexed score-loop restoration in held draft [PR #978](https://github.com/ManabiIO/manabitan/pull/978). Its reviewable benefit remains the separately measured approximately 1.57–1.60 ms per complete warm JMdict validator traversal; that component result does not establish first-import behavior or extend to these other corpora.

The archive preserves **all 408 original non-package members from the two completed artifacts: 52 raw reports, 52 canonical receipts, all 846 memory scan rows, complete plans/timing/control records, HTML reports, logs, package inventories, and independent audits**. Every unfavorable observation remains included. Both cohorts pass their original semantic and sampled-memory gates; passing those gates is not evidence of a speedup.

The already published [JMdict browser cohort at `54b93325`](https://github.com/ManabiIO/manabitan/blob/54b933253e05dfa8b9cfe0b7211cb8eac34eb500/dev/perf/import-evidence-20261128-1b47/score-jmdict-browser-addendum-README.md) remains separate and is not duplicated. Taken together, the three complete browser cohorts establish no whole-import gain. JMdict's separate memory-coverage failure also remains unresolved.

The publication cutoff is **2026-11-28 07:51:17 UTC**. At that snapshot CRC VNDB and compression VNDB are running, compression Jitendex is queued, and the compression JMdict workflow has failed but has not yet been audited. Those are status entries only, outside this score evidence bundle; their timing, policy, or product outcomes are not inferred here. The CRC batch is preserved separately.

## Exact source and acquisition boundaries

| Binding                                         | Exact identity                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Baseline                                        | `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`                                                                      |
| Frozen score-study candidate                    | `915268441352c3c7aa50fc0fbd44f73f5a826d79`                                                                      |
| Clean PR #978 head at independent source review | `b15bad43acdfd54d541895cac1109c0e5ba51b2f`                                                                      |
| Only differing packaged entry                   | `js/dictionary/term-record-opfs-store.js`                                                                       |
| Actual runtime Git blob                         | `b17f72437f196aa1fd21b282c03f147aad7d633f`                                                                      |
| Actual runtime SHA256                           | `63942c3dc97eab215293bf04a138844d505605386bc61322b3f2f29e20d1d769`                                              |
| Actions run                                     | [46106456744](https://github.com/ManabiIO/manabitan/actions/runs/46106456744)                                   |
| Jitendex job / artifact                         | [140880422289](https://github.com/ManabiIO/manabitan/actions/runs/46106456744/job/140880422289) / `15254097229` |
| VNDB job / artifact                             | [140880422226](https://github.com/ManabiIO/manabitan/actions/runs/46106456744/job/140880422226) / `15254620204` |

Independent source reviews inspected the actual nested packages and current PR runtime. The two package inventories contain 554 entries each, and their sole differing entry has the exact runtime bytes above. The distinct study and product commits are connected by that source proof; they are not asserted to be interchangeable commits.

Each cohort retains its original four excluded warmups, six alternating AB/BA candidate pairs, two interleaved identical-code A/C pairs, two separate exhaustive-media imports, and four separately instrumented memory imports. That is 26 raw reports per corpus. Each revision was built independently before observations. Timing and exhaustive-media imports used the frozen harness; the separate memory imports used the registered marker-only harness overlay. There were no product overlays, unregistered harness changes, replacement observations, or retries.

Timing runs from file-input change through post-UI completion in a fresh profile. Readback/restart and the instrumented memory screen are outside that timer. Exact browser, fixture, source, package, flag, and schedule identities remain in each original artifact. VNDB keeps its prospective explicit SAH allocation policy of exactly 37 units of 4,096 bytes. No policy or gate was relaxed during analysis or packaging.

The original paired-median intervals are descriptive percentile bootstraps with 10,000 complete-pair resamples and seed 897. Equal-work changes are the original complete-work aggregates. The two corpora remain separate: no estimates are pooled, and no identical-code drift is subtracted from candidate observations.

## Complete-import timing

Negative changes are faster. All six candidate pairs and both identical-code pairs per corpus remain in these estimates.

| Corpus / comparison         | Paired median | Equal-work change | Descriptive 95% paired-median interval | Faster pairs |
| --------------------------- | ------------: | ----------------: | -------------------------------------- | -----------: |
| Jitendex B/A candidate      |    +0.900243% |        +3.386738% | [−0.546310%, +9.895937%]               |        1 / 6 |
| Jitendex C/A identical code |    −1.069280% |        −1.068349% | [−1.586074%, −0.552486%]               |        2 / 2 |
| VNDB B/A candidate          |    −1.019399% |        −1.083077% | [−2.895646%, +0.681101%]               |        4 / 6 |
| VNDB C/A identical code     |    −1.968847% |        −2.005600% | [−3.692111%, −0.245583%]               |        2 / 2 |

**Five of six Jitendex candidate pairs are slower, including the complete +17.679199% fifth pair.** Both identical-code controls improve. The equal-work estimate is +3.386738%, and the wide candidate interval is consistent with meaningful slowdown. Nothing is dropped or adjusted because it is unfavorable. VNDB's favorable point estimate crosses zero and its apparent median improvement is smaller in magnitude than the identical-code control improvement. Its worst candidate pair, +1.244773%, also remains retained. With only two control pairs per corpus, the descriptive control intervals are not independent population estimates.

The changed `parseCompactRecordFields` loop runs through `validateRecordFields` and `_createLookupIndexChunk` inside the awaited record append, enclosed by the aggregate `termRecordWriteMs`. The similarly named `termRecordValidationMs` instead covers input/content-offset checks and is **not the optimized loop's timer**. No dedicated score-loop timer exists in these browser reports.

Jitendex's fifth pair adds approximately 271.8 ms to whole-import time and also slows in unchanged native inflation, parsing, and compression. These worker and await durations overlap; some sum worker work. They cannot be added or subtracted to identify a cause, isolate the loop, or erase the adverse complete-import observation. The broader record-write aggregate cannot isolate the component benefit either.

The earlier actual-buffer validator study measured warm medians A 2.5594 ms, B 0.9852 ms, and identical baseline C 2.5867 ms for the entire 528,299-row JMdict corpus. The indexed loop was faster in 23/24 comparisons with A and 24/24 with C, supporting the approximately 1.57–1.60 ms component saving. Its [immutable source-bound component packet](https://github.com/ManabiIO/manabitan/blob/3c3ba7600a8811df6b8631b72a0ac5379f8b60d1/dev/perf/import-evidence-20261128-1b47/score-restoration-README.md) retains the actual numeric inputs, all observations, same-code controls, validation, and failed attempts. No first-use, whole-import, or other-corpus extrapolation follows from it.

The combined recommendation remains a **held component-only draft**, with no browser non-regression or merge-readiness claim. VNDB's result does not cancel Jitendex's adverse signal. The separately archived JMdict cohort also remains flat/inconclusive and fails its full memory comparison because B2's covered-sample gap is 252.093481 ms, exceeding the unchanged 250 ms limit. Its null maxima are not replaced, and its surviving memory pair is not substituted for the complete screen.

## Semantic and sampled-memory evidence

All 26 canonical receipts in each new cohort independently pass the unchanged source/work, lookup, storage-size, media/readback, and restart checks. Exact original extension package bytes and their decompressed inventories match their recorded identities. These receipts are source-bound semantic checks; they do not claim exhaustive byte equality for every persisted definition.

Both new cohorts pass all four individual memory-coverage checks and the original complete paired memory gates. Their raw `memory.json` records and every scan row remain included.

| Corpus   | Raw scan rows | Sampled private median / maximum paired change | Sampled PSS median / maximum paired change |
| -------- | ------------: | ---------------------------------------------: | -----------------------------------------: |
| Jitendex |           276 |                        +2.827247% / +3.020272% |                    +2.041978% / +2.269813% |
| VNDB     |           570 |                        +2.490014% / +4.864194% |                    +2.265224% / +3.981958% |

These are non-atomic process-tree samples and sampled maxima, not exact memory peaks. Passing a prospective memory margin is not a zero-overhead claim. The JMdict coverage failure belongs to its already published separate cohort and remains part of the combined interpretation.

## Actual auditor version and later independent reviews

Both new artifact audits executed the reviewed **generic v2 auditor**, SHA256 `292eea976f78c24ce93f441b468c9a3efad62ad539cd9425c74eec893ee27ca0`. Its exact source, derivation patch, derivation record, and independent static review are included. This is an actual execution identity for these two cohorts, unlike the preparation-only copy in the earlier JMdict packet.

Each audit independently verifies the outer ZIP and all member hashes, actual package identities, all 26 canonical receipts, all raw memory scans, the fixed schedule and pair counts, and the recomputed original timing/memory statistics. Its explicit guards bind A/B identities to the known registered commits, each timing observation to its raw summary, 26 unique receipt names to the exact schedule, and final status to the recomputed semantic/memory gates. It rejects pre-existing output destinations. The generic canonical matcher and thresholds remain unchanged.

The earlier seven-cohort link supplement remains [immutable at `54b93325`](https://github.com/ManabiIO/manabitan/blob/54b933253e05dfa8b9cfe0b7211cb8eac34eb500/dev/perf/import-evidence-20261128-1b47/score-jmdict-browser-addendum-README.md). It is not implicitly extended to these later cohorts; their own v2 audits supply their explicit source and clock checks. No old audit or observation was rewritten.

The separate architecture reviews retain their exact inspected source/package proofs, Jitendex timer-attribution correction, the adverse tail, and the all-corpus held-draft recommendation. They are later read-only interpretations, not additional acquisitions. This bundle contains no CRC or compression measurement or audit result.

## Preservation boundary and recovery

The original open packaging plan grouped pending studies; it was superseded in favor of append-only completed batches. JMdict was sealed first. This batch seals only score Jitendex and VNDB at the named cutoff, while CRC and compression continue separately. The original staged records, seal scope/history, status snapshot, and published-cohort ledger preserve that chronology. A cohort record's historical phrase “enclosing bundle remains open” describes its staging time; this later seal record determines archive membership.

The local executor interruption erased transient home storage before this new staging generation. New pending artifacts were restored from the **exact original Actions ZIPs** and checked against their recorded SHA256 digests. That is deterministic evidence restoration, not a browser retry or substituted observation. The seven already published raw cohorts were not rebuilt or duplicated.

The two new raw cohorts retain these original staging prefixes:

```text
evidence/pending-studies-raw-addendum-20261128-1b47/cohorts/score-jitendex/
evidence/pending-studies-raw-addendum-20261128-1b47/cohorts/score-vndb/
```

Within each, `raw/` preserves every original artifact-relative path except the two extension ZIPs. `snapshots/` preserves the complete stable audit/result directory; `validators/` and `scripts/` preserve the exact baseline validators and actual auditor. Separate `later-reviews/score-jitendex/` and `later-reviews/score-vndb/` directories retain the independent reviews and final PR interpretation. The new seal directory is `evidence/score-remaining-browser-addendum-20261128-1b47/`. No payload symlink is followed. Historical local paths remain provenance only.

## Original artifacts and exact omissions

| Corpus / original artifact                                                                                   | Original bytes | SHA256                                                             | Retained members |
| ------------------------------------------------------------------------------------------------------------ | -------------: | ------------------------------------------------------------------ | ---------------: |
| [Jitendex 15254097229](https://github.com/ManabiIO/manabitan/actions/runs/46106456744/artifacts/15254097229) |     34,968,497 | `5af77600a2703129f30d394a466f7b39b2cb5abbc89c506c4faac8184d0b5658` |        204 / 206 |
| [VNDB 15254620204](https://github.com/ManabiIO/manabitan/actions/runs/46106456744/artifacts/15254620204)     |     35,260,207 | `76fb49b5928b9b247839b744302e294bd5911f1c127ae0e70fb4f282e4711135` |        204 / 206 |

The only omitted members are the duplicate complete extension packages:

| Original member          |      Bytes | SHA256                                                             |
| ------------------------ | ---------: | ------------------------------------------------------------------ |
| `jitendex/package-A.zip` | 16,805,714 | `d2f7e1378586651a084c571a3ba3d8fcff9778d337d2f3665ea74e92b16a03a6` |
| `jitendex/package-B.zip` | 16,805,726 | `88581aed5825ada87da16d06231528590ad95bcb5144dd68bdff1dca4a24094f` |
| `vndb/package-A.zip`     | 16,805,714 | `addba50cf084723fb5c6a52c1c626a6613ec9b944f8701cbb5d4ef17e92fe266` |
| `vndb/package-B.zip`     | 16,805,726 | `9586124e9158579cdf1ea06640df6fff6a7e35b807b6f4c9266215f1fe17b4fe` |

Their exact member digests were independently streamed and rechecked from the verified original outer ZIPs during staging. Full package inventories and source identities remain retained. The original outer ZIP containers are also omitted because all non-package members are stored individually. Repeating package/container-byte verification requires those exact original artifacts; a newly built extension ZIP is not claimed to reproduce their timestamps or container bytes. No dictionary/media archive is included. The score JMdict raw archive is referenced rather than duplicated.

## Verify and inspect

Download this README, `score-remaining-browser-addendum-20261128-1b47.tar.gz`, its `.manifest.json`, and `.sha256` from the same immutable evidence commit. Verify before extracting into a new directory:

```sh
sha256sum -c score-remaining-browser-addendum-20261128-1b47.sha256
tar -xzf score-remaining-browser-addendum-20261128-1b47.tar.gz
python3 evidence/durable-bundles/package-evidence-v2.py \
  --verify-manifest score-remaining-browser-addendum-20261128-1b47.manifest.json
```

The external manifest hashes every member's exact safe path, byte count, and content without a self-hash exception. Gzip timestamps and tar metadata are normalized; original payload bytes remain unchanged. The verifier checks the complete archive hash, exact member set, sizes, and every member digest.

To repeat an existing artifact audit without acquiring another browser observation, obtain the corresponding original ZIP and use a checkout at the pinned baseline. Both output destinations must be new:

```sh
python3 evidence/audit-hosted-import-artifact-v2-1b47.py \
  --archive score-validation-1b47-screen-jitendex-15254097229.zip \
  --expected-sha256 5af77600a2703129f30d394a466f7b39b2cb5abbc89c506c4faac8184d0b5658 \
  --dictionary jitendex \
  --candidate-sha 915268441352c3c7aa50fc0fbd44f73f5a826d79 \
  --baseline-root /path/to/checkout-at-9e10d3b3 \
  --extract /path/to/new-jitendex-extraction \
  --output /path/to/new-jitendex-audit.json

python3 evidence/audit-hosted-import-artifact-v2-1b47.py \
  --archive score-validation-1b47-screen-vndb-15254620204.zip \
  --expected-sha256 76fb49b5928b9b247839b744302e294bd5911f1c127ae0e70fb4f282e4711135 \
  --dictionary vndb \
  --candidate-sha 915268441352c3c7aa50fc0fbd44f73f5a826d79 \
  --baseline-root /path/to/checkout-at-9e10d3b3 \
  --extract /path/to/new-vndb-extraction \
  --output /path/to/new-vndb-audit.json
```

These commands reproduce verification of the existing artifacts, not the acquisition. The archive's purpose is to retain the full favorable and unfavorable evidence while keeping the small warm-component finding distinct from the complete browser outcomes.

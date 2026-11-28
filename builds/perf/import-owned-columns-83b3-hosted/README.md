# Current ownership proposal: completed hosted evidence — HOLD

All four cells of [run 46103918280](https://github.com/ManabiIO/manabitan/actions/runs/46103918280) have finished for [PR #820](https://github.com/ManabiIO/manabitan/pull/820). Candidate `f65f4ef97ebf2f37a5b1b79ca7733d7b362ec963` was compared with baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. All planned timing schedules are complete. **The study remains HOLD: neither independent JMdict host demonstrates a latency benefit, Jitendex leans slower, and VNDB's mandatory memory-coverage gate failed.**

The cumulative buffer-allocation reduction remains a deterministic work-volume result. It must not be restated as import-time or exact peak-memory savings.

## Complete timing observations

Negative changes are faster. Equal work compares summed matched durations within one cell. Each row is a separate host; controls are not subtracted and hosts are not pooled.

| Cell | Candidate B/A median | Candidate equal work | Faster pairs | Identical C/A median | Identical C/A equal work |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict AB | +0.2584% | +0.4499% | 6/12 | +1.0747% | +0.2374% |
| JMdict BA | +0.0487% | +2.2435% | 6/12 | +1.2052% | +0.1371% |
| Jitendex AB | +2.5895% | +2.0372% | 1/6 | −0.7962% | −0.7864% |
| VNDB AB | −1.6899% | −1.6389% | 5/6 | +1.7890% | +1.7943% |

JMdict BA retains candidate tails of +11.2233% and +10.1601%. Jitendex is order-sensitive: its AB and BA strata medians are +0.4019% and +3.9555%. VNDB's worst candidate pair is +2.3119%; its favorable median does not satisfy full qualification while required memory coverage is missing.

The descriptive 95% bootstrap intervals include zero in every candidate cell: JMdict AB [−1.164%, +2.206%], JMdict BA [−1.477%, +6.120%], Jitendex [−0.618%, +4.187%], VNDB [−4.058%, +0.871%]. No unchanged-source repeat, optional timing round, control subtraction or tail exclusion was used.

Independent readback verified all four complete schedules, raw browser monotonic endpoints, source/package/fixture identities, existing 2/3/5 component policies, post-UI completion, persisted probes, restart and exhaustive media. The four cells contain **136 imports** across timing, excluded warmups, exhaustive media and separate memory. A further baseline trace from the JMdict AB job is diagnostic only and remains outside timing statistics.

## Separate sampled memory and exact failed gate

Each cell contains only two adjacent memory pairs. The figures below describe maxima among covered Chromium process-tree samples during startup, import, readback and restart. They are not exact import peaks; scans are not atomic and can miss transient or reparented processes.

| Cell | Private-memory median change | PSS median change | Qualification |
| --- | ---: | ---: | --- |
| JMdict AB | +0.0416% | +0.1861% | Passed |
| JMdict BA | +0.3660% | +0.3497% | Passed |
| Jitendex AB | −2.4384% | −1.9647% | Passed |
| VNDB AB | Withheld | Withheld | B1 coverage failed |

VNDB candidate memory observation **B1** had a **253.533022 ms** maximum covered import-sample gap, exceeding the frozen **250 ms** limit. Independent recomputation identifies the gap between covered raw samples 88 and 90. B1's private/PSS maxima correctly remain null; pair 1 and the aggregate memory comparison remain unqualified.

All four VNDB memory imports exited 0, `semantic-failures.json` is empty, and the frozen reader's only failed gate is `separateMemory`. This is insufficient measurement coverage, not a measured memory regression or import-correctness failure. The one qualified pair 2 is retained in the raw evidence and cannot replace pair 1. The limit was not relaxed, and no observation was replaced or repeated. The [separate independent review](../import-owned-columns-83b3-analysis-source/vndb-memory-independent-review.json) binds the exact raw scans and auditor.

The small Jitendex sampled-memory reduction is descriptive and has no second-host replication in this study. JMdict shows no sampled-memory reduction.

## Complete preserved observations

| Cell | Archive | Manifest | Independent readback | Original artifact |
| --- | --- | --- | --- | ---: |
| JMdict AB | [evidence.tar.gz](jmdict-AB/evidence.tar.gz) | [manifest.json](jmdict-AB/manifest.json) | [independent-analysis.json](jmdict-AB/independent-analysis.json) | 15250427758 |
| JMdict BA | [evidence.tar.gz](jmdict-BA/evidence.tar.gz) | [manifest.json](jmdict-BA/manifest.json) | [independent-analysis.json](jmdict-BA/independent-analysis.json) | 15250683242 |
| Jitendex AB | [evidence.tar.gz](jitendex-AB/evidence.tar.gz) | [manifest.json](jitendex-AB/manifest.json) | [independent-analysis.json](jitendex-AB/independent-analysis.json) | 15250472765 |
| VNDB AB | [evidence.tar.gz](vndb-AB/evidence.tar.gz) | [manifest.json](vndb-AB/manifest.json) | [independent-analysis.json](vndb-AB/independent-analysis.json) | 15251462292 |

[four-cell-summary.json](four-cell-summary.json) retains every paired ratio, descriptive interval, control result, sampled-memory comparison, source-artifact digest and per-policy allocation count. It explicitly records all four jobs and timing schedules complete, required qualification false, and decision HOLD. The earlier [three-cell summary](three-cell-summary.json) remains unchanged as a historical pending-VNDB snapshot.

The four compact archives contain **1,209 payload files / 106,595,412 uncompressed bytes**, plus their four embedded contents manifests, in **9,315,080 compressed bytes**. Every original non-package artifact member is retained, including raw reports, failed coverage observations, memory scans, media checks, all chronological controls and tails, HTML reports, the separate JMdict trace, full workflow logs, and each cell's exact 28 frozen source/auditor inputs. No signed download URL is published.

The original package ZIP payloads are excluded from these compact archives. Both ZIPs and every member were verified before packaging; their complete inventories, source identities and digests are retained. Rechecking the original outer artifact or package ZIP bytes requires the original GitHub artifact. This limitation does not remove any timing, memory, semantic or control observation.

Root separately streamed all four archives and verified every member's size, SHA256 and Git-blob identity against its manifest without extraction or execution. [four-cell-root-archive-verification.json](four-cell-root-archive-verification.json) records that pass; the original three-cell review is unchanged. To repeat it, keep [verify-archive.py](verify-archive.py), each archive and its manifest in the shown layout:

```sh
python3 verify-archive.py --manifest jmdict-AB/manifest.json
python3 verify-archive.py --manifest jmdict-BA/manifest.json
python3 verify-archive.py --manifest jitendex-AB/manifest.json
python3 verify-archive.py --manifest vndb-AB/manifest.json
```

The [frozen offline reader and intake protocol](../import-owned-columns-83b3-analysis-source/README.md) describe semantic and statistical reproduction. The [documented cleanup receipt](completed-extracted-packages-cleanup.json) concerns only duplicate extracted package ZIPs; their verified outer artifacts and every raw observation remain intact. These evidence-only additions do not change either PR's runtime source or restart its qualification.

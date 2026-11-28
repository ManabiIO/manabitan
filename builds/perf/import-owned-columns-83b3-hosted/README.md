# Current ownership proposal: hosted browser evidence

This directory preserves the first three completed cells of [run 46103918280](https://github.com/ManabiIO/manabitan/actions/runs/46103918280) for [PR #820](https://github.com/ManabiIO/manabitan/pull/820). Candidate `f65f4ef97ebf2f37a5b1b79ca7733d7b362ec963` is compared with baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. **VNDB is pending; this is not a completed four-cell study.**

Both independent JMdict hosts show no demonstrated latency benefit. Jitendex leans slower. The cumulative buffer-allocation reduction remains a deterministic work-volume result; it must not be restated as import-time or peak-memory savings.

## Completed timing observations

Negative changes are faster. Equal work compares summed matched durations within one cell. Each row is a separate host; controls are not subtracted and hosts are not pooled.

| Cell | Candidate B/A median | Candidate equal work | Faster pairs | Identical C/A median | Identical C/A equal work |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict AB | +0.2584% | +0.4499% | 6/12 | +1.0747% | +0.2374% |
| JMdict BA | +0.0487% | +2.2435% | 6/12 | +1.2052% | +0.1371% |
| Jitendex AB | +2.5895% | +2.0372% | 1/6 | −0.7962% | −0.7864% |

JMdict BA retains candidate tails of +11.2233% and +10.1601%. Jitendex is order-sensitive: its AB and BA strata medians are +0.4019% and +3.9555%. The descriptive 95% bootstrap intervals include zero in every completed candidate cell: JMdict AB [−1.164%, +2.206%], JMdict BA [−1.477%, +6.120%], Jitendex [−0.618%, +4.187%]. No unchanged-source repeat, optional timing round or tail exclusion was used.

Independent readback passed the complete schedules, raw browser monotonic endpoints, source/package/fixture identities, all existing 2/3/5 component policies, post-UI completion, persisted probes, restart, exhaustive media and separate memory gates. These three cells contain 110 imports across timing, excluded warmups, exhaustive media and separate memory; a further baseline trace from the JMdict AB job is diagnostic only and is retained separately from timing statistics.

## Separate sampled memory

Each cell contains only two adjacent memory pairs. These figures describe maxima among covered Chromium process-tree samples during startup, import, readback and restart. They are not exact import peaks; the scans are not atomic and can miss transient or reparented processes.

| Cell | Private-memory median change | PSS median change |
| --- | ---: | ---: |
| JMdict AB | +0.0416% | +0.1861% |
| JMdict BA | +0.3660% | +0.3497% |
| Jitendex AB | −2.4384% | −1.9647% |

All three completed cells pass the frozen memory-coverage and regression screens. The Jitendex reduction is descriptive and has no second-host replication in this study. JMdict shows no sampled-memory reduction.

## Complete preserved observations

| Cell | Archive | Manifest | Independent readback | Original artifact |
| --- | --- | --- | --- | ---: |
| JMdict AB | [evidence.tar.gz](jmdict-AB/evidence.tar.gz) | [manifest.json](jmdict-AB/manifest.json) | [independent-analysis.json](jmdict-AB/independent-analysis.json) | 15250427758 |
| JMdict BA | [evidence.tar.gz](jmdict-BA/evidence.tar.gz) | [manifest.json](jmdict-BA/manifest.json) | [independent-analysis.json](jmdict-BA/independent-analysis.json) | 15250683242 |
| Jitendex AB | [evidence.tar.gz](jitendex-AB/evidence.tar.gz) | [manifest.json](jitendex-AB/manifest.json) | [independent-analysis.json](jitendex-AB/independent-analysis.json) | 15250472765 |

[three-cell-summary.json](three-cell-summary.json) retains every paired ratio, descriptive interval, control result, sampled-memory comparison, source-artifact digest and per-policy allocation count. It explicitly records `completeStudy: false` and pending VNDB.

The three compact archives contain **964 payload files / 77,019,752 uncompressed bytes**, plus their three embedded contents manifests, in **7,133,395 compressed bytes**. Every original non-package artifact member is retained, including raw reports, memory scans, media checks, all chronological controls and tails, HTML reports, the separate JMdict trace, full workflow logs, and the exact 28 frozen source/auditor inputs. No signed download URL is published.

The original package ZIP payloads are excluded from these compact archives. Both ZIPs and every member were verified before packaging; their complete inventories, source identities and digests are retained. Rechecking the original outer artifact or package ZIP bytes requires the original GitHub artifact. This limitation does not remove any timing, memory, semantic or control observation.

Root separately streamed all three archives and verified every member's size, SHA256 and Git-blob identity against its manifest without extraction or execution. [root-archive-verification.json](root-archive-verification.json) records that pass. To repeat it, keep [verify-archive.py](verify-archive.py), a cell's archive and its manifest in the shown layout:

```sh
python3 verify-archive.py --manifest jmdict-AB/manifest.json
python3 verify-archive.py --manifest jmdict-BA/manifest.json
python3 verify-archive.py --manifest jitendex-AB/manifest.json
```

The [frozen offline reader and intake protocol](../import-owned-columns-83b3-analysis-source/README.md) describe full semantic and statistical reproduction. Acquisitions remain bound to the original candidate and workflow. These evidence-only additions do not change either PR's runtime source or restart its checks.

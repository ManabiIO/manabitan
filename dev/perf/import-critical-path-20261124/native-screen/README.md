# Native media projection screens, 2026-11-24

The batched projector reduced VNDB import time against develop in this exploratory screen, but it was slower than the existing single-image projector in PR #875. Do not open a competing performance PR for the batched candidate on this evidence.

[Actions run 45466141231](https://github.com/ManabiIO/manabitan/actions/runs/45466141231) completed four independent jobs at study `6a04bbff4c5332d6c86f678455f36545a511abb5`. Candidate B is always `1737c500a0e5cbf0109f1a30b031b1e43cfa0dae`. Three jobs compare it with develop baseline `bbccabd520972cc351a65d9f545bd5369b6e9747`; the fourth compares it directly with [PR #875](https://github.com/ManabiIO/manabitan/pull/875) at `fb71a03f4611bcfa71e135693bebd1fe778153bf`.

The independent auditor passes all **92 observations**. Every job contains three warmups, the same six balanced A/B/C blocks, and two exhaustive media diagnostic imports. A and C are separately built identical controls. Source, frozen runner/harness, package member differences, fixture identities, browser timing boundaries, semantic lookup/restart checks, and persisted media agree. Node 22.22.0 and Chromium 153.0.8010.12 are fixed. The timed imports use production defaults without tracing.

## Whole-import results

| Cohort              | Paired B/A median | Paired B/C median | Control C/A median | Equal-work B/A | Equal-work B/C | Faster pairs B/A; B/C |
| ------------------- | ----------------: | ----------------: | -----------------: | -------------: | -------------: | --------------------: |
| JMdict vs develop   |           +0.111% |           −0.517% |            +1.246% |        −1.524% |        −0.417% |              3/6; 3/6 |
| Jitendex vs develop |           +1.137% |           +0.576% |            −0.176% |        −2.164% |        +0.523% |              2/6; 3/6 |
| VNDB vs develop     |           −4.144% |           −2.032% |            +0.442% |        −3.252% |        −3.624% |              5/6; 5/6 |
| VNDB vs #875        |           +3.017% |           +3.206% |            −0.725% |        +2.096% |        +2.498% |              1/6; 1/6 |

Negative values favor the batched candidate. Each job has its own hosted runner; absolute times from different rows must not be compared or pooled.

The develop VNDB cohort has A/B/C medians of 4617.30 / 4426.20 / 4608.10 ms. The direct #875 cohort has medians of 4728.15 / 4810.15 / 4670.45 ms. The batch candidate loses to both #875 controls in five of six pairs. This direct comparator is the reason to withhold a competing PR despite the favorable develop comparison.

JMdict is neutral. Jitendex has small adverse paired medians, and its favorable B/A equal-work result is driven by an unusually slow baseline observation. All samples remain included. These six-block screens do not establish cross-device performance or a precise small-regression bound.

## Component observations

Against develop, VNDB's aggregate parserResultCopy median falls from about 1847 ms in both controls to 919 ms in B. Against #875 it falls from about 1145 ms to 991 ms, even though the whole import is slower. This illustrates why reduced component work is not sufficient for promotion: parallel producer, sink, and queue intervals overlap and can move the import's limiting work. The phase intervals must not be added to predict total time.

Both VNDB cohorts retain the identical 609,553,611-byte OPFS total. Exhaustive diagnostics verify all 146,570 media files and 188,131,284 bytes with SHA-256 `ea94d392bc833baf0bee7b3d6becc3d3517eee84ee314a44986438ac6d5217cb`. JMdict and Jitendex retain their locked term/media counts, source-derived lookups and restart behavior.

## Retention

Each deterministic tar.xz contains every observation summary and complete raw JSON phase report, the protocol, frozen runner/workflow, and canonical semantic signature. The manifests verify original GitHub ZIP digests and retained member bytes. The downloaded original ZIPs also retain redundant progress, HTML and console logs. No favorable observation was selected, replaced, or rerun.

`audit.json` is independently recomputed from these bundles. `phase-medians.json` summarizes the retained per-observation diagnostics; its counters overlap and are subordinate to whole-import outcomes. Frozen study specifications remain on the measured source revisions, even if later maintenance changes preserve identical product bytes.

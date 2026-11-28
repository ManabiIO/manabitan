# Registration screen: superseded source, no demonstrated JMdict gain

This is an independent arithmetic audit of [run 46102503309](https://github.com/ManabiIO/manabitan/actions/runs/46102503309). **Do not promote this source.** The measured revision predates required correctness fixes, and none of the three complete timing screens establishes a worthwhile whole-import improvement.

All three original jobs have finished. All 60 scheduled timing observations and all 12 separate memory observations are retained. JMdict and Jitendex passed the existing correctness/memory gate. VNDB failed sampled-memory coverage after completing every timing and exhaustive-media observation; this failure is retained without a rerun.

## Frozen identities

| Role | Commit |
| --- | --- |
| Baseline / identical control | `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` |
| Tested registration candidate | `6d6600a3277f83782729fcce14ea7e02f48a4b40` |
| Acquisition workflow | `8655830a237be6bd5e8c03172d284912fc9ef94c` |
| Later corrected source, **not measured here** | `a8230f060c2b2a9f56eb7ce83d78a7e23c2567f9` |

The tested candidate is superseded by private pending-span factory provenance (`8b4f502cdc26541c542b7473fae4e51c0713ef98`) and an intrinsic private backing-buffer check (`a8230f060c2b2a9f56eb7ce83d78a7e23c2567f9`). A Proxy could make the original descriptor-only shortcut disagree with later property reads. Prototype identity alone also did not establish an ArrayBuffer's internal brand. This archive never attributes these old timings to the corrected revision.

## Results

Positive changes mean slower. Every measured pair is retained.

| Corpus | Candidate paired median | Candidate equal-work | Descriptive 95% median interval | Faster pairs | Identical A/C median | Identical A/C equal-work |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| jmdict | -0.1873% | +16.7300% | [-6.2564%, +57.2676%] | 4/6 | +0.5478% | +0.5457% |
| jitendex | +0.3908% | -0.9395% | [-5.2718%, +2.3843%] | 2/6 | -0.0459% | -0.0570% |
| vndb | +2.6382% | +2.3898% | [-0.5009%, +5.1130%] | 1/6 | +0.4713% | +0.4711% |

JMdict pair 2 is retained in full: baseline 695.2 ms, candidate 1471.3 ms, a +111.6369% change. The median is close to zero while equal-work time is worse. The cause of the isolated slow candidate observation is not established. It is not excluded, explained away, or used to justify a replacement measurement.

The candidate does not meet the prospectively declared material-gain threshold. The identical-build controls do not turn this into a gain: JMdict's small candidate median movement is smaller than its control shift. Jitendex's candidate median is positive and its interval includes zero. VNDB's median and equal-work changes are both positive; five of six candidate pairs are slower, and its interval also includes zero.

## Protocol and independent calculation

The existing source qualification driver built each frozen source independently, using release Chrome packages and locked fixture archives. Timing starts at file-input dispatch and ends at visible UI completion, with a fresh browser profile per observation. Each corpus schedules two excluded warmup pairs, six alternating AB/BA measured pairs, and two interleaved A/C identical-code controls. Exhaustive-media diagnostics and four separate instrumented memory imports follow all timings.

The unchanged driver records a timing observation only after validating and comparing its canonical receipt. JMdict and Jitendex reported success; VNDB reported a memory-coverage failure. All three report no separate memory semantic failures. Source identities show exactly one changed package entry, `js/dictionary/dictionary-database.js`; A/C use the same baseline package. The candidate ZIP is 783 bytes larger in all three jobs. Chromium is 153.0.8010.12, executable SHA-256 `8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e`.

The independent JavaScript calculation reproduces every candidate/control ratio, paired median, equal-work ratio, worst pair, faster-pair count, timing schedule, and memory pair statistic exactly. Instead of copying Python's seeded random generator, it enumerates all 46,656 ordered six-pair bootstrap resamples (and all four two-pair control resamples) and takes the nearest-rank 2.5%/97.5% percentiles. These exact-distribution endpoints match the acquisition's 10,000-resample, seed-897 endpoints for all three corpora.

The arithmetic functions were executed in the available V8 environment. The included Node file adapter makes the calculation reproducible; no new Node import or browser measurement was run during this audit.

## Every timing observation

Milliseconds below are displayed to one decimal place; the JSON retains original floating-point values and acquisition order. Warmups remain excluded exactly as registered.

### jmdict

| Slot | Kind | Arm | Time (ms) |
| --- | --- | --- | ---: |
| warmup-1-A | warmup | A | 1158.0 |
| warmup-1-B | warmup | B | 968.6 |
| warmup-2-B | warmup | B | 686.5 |
| warmup-2-A | warmup | A | 672.4 |
| pair-01-A | candidate | A | 750.5 |
| pair-01-B | candidate | B | 661.2 |
| pair-02-B | candidate | B | 1471.3 |
| pair-02-A | candidate | A | 695.2 |
| pair-03-A | candidate | A | 679.7 |
| pair-03-B | candidate | B | 699.4 |
| control-01-A | control | A | 700.4 |
| control-01-C | control | C | 703.5 |
| pair-04-B | candidate | B | 693.0 |
| pair-04-A | candidate | A | 695.4 |
| pair-05-A | candidate | A | 677.6 |
| pair-05-B | candidate | B | 677.4 |
| pair-06-B | candidate | B | 679.7 |
| pair-06-A | candidate | A | 683.9 |
| control-02-C | control | C | 678.3 |
| control-02-A | control | A | 673.9 |

### jitendex

| Slot | Kind | Arm | Time (ms) |
| --- | --- | --- | ---: |
| warmup-1-A | warmup | A | 1434.5 |
| warmup-1-B | warmup | B | 1369.5 |
| warmup-2-B | warmup | B | 2167.3 |
| warmup-2-A | warmup | A | 1418.2 |
| pair-01-A | candidate | A | 1390.0 |
| pair-01-B | candidate | B | 1373.3 |
| pair-02-B | candidate | B | 1444.6 |
| pair-02-A | candidate | A | 1390.3 |
| pair-03-A | candidate | A | 1368.2 |
| pair-03-B | candidate | B | 1374.0 |
| control-01-A | control | A | 1415.6 |
| control-01-C | control | C | 1397.2 |
| pair-04-B | candidate | B | 1390.9 |
| pair-04-A | candidate | A | 1379.0 |
| pair-05-A | candidate | A | 1509.3 |
| pair-05-B | candidate | B | 1368.3 |
| pair-06-B | candidate | B | 1515.5 |
| pair-06-A | candidate | A | 1510.1 |
| control-02-C | control | C | 1407.6 |
| control-02-A | control | A | 1390.8 |

### vndb

| Slot | Kind | Arm | Time (ms) |
| --- | --- | --- | ---: |
| warmup-1-A | warmup | A | 7947.6 |
| warmup-1-B | warmup | B | 8806.5 |
| warmup-2-B | warmup | B | 5633.1 |
| warmup-2-A | warmup | A | 5532.5 |
| pair-01-A | candidate | A | 5499.0 |
| pair-01-B | candidate | B | 5882.0 |
| pair-02-B | candidate | B | 5621.6 |
| pair-02-A | candidate | A | 5489.9 |
| pair-03-A | candidate | A | 5696.8 |
| pair-03-B | candidate | B | 5549.6 |
| control-01-A | control | A | 5741.9 |
| control-01-C | control | C | 5766.6 |
| pair-04-B | candidate | B | 5506.0 |
| pair-04-A | candidate | A | 5352.0 |
| pair-05-A | candidate | A | 5372.5 |
| pair-05-B | candidate | B | 5457.5 |
| pair-06-B | candidate | B | 5753.4 |
| pair-06-A | candidate | A | 5571.7 |
| control-02-C | control | C | 5708.4 |
| control-02-A | control | A | 5679.3 |

## Separate sampled-memory results

These are qualified sampled process-tree maxima, not exact peaks. Instrumented durations are not used as performance observations.

| Corpus | Private median change | Private worst pair | PSS median change | PSS worst pair | Qualified observations | Raw scans reported |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| jmdict | -0.5283% | +0.3108% | -0.4619% | +0.6182% | 4/4 | 252 |
| jitendex | +1.4963% | +1.5891% | +1.5213% | +1.7069% | 4/4 | 315 |
| vndb | Unqualified | Unqualified | Unqualified | Unqualified | 3/4 | 611 |

JMdict memory B2 retains eight unavailable-smaps observations attributable to a separately confirmed exited zombie. The existing observer qualified this observation under its explicit zombie-identity rule; the compact audit reports no unreadable address spaces or qualification failures. No missing memory read is represented as a measured zero.

**VNDB memory B1 fails the unchanged 250 ms covered-scan-gap bound:** the observed gap is 253.569879 ms. Its PSS/private maxima remain null, and neither pair 1 nor the aggregate memory statistics are interpreted. B1 retains one unreadable address-space scan and nine confirmed exited-zombie observations. A2 also retains one unreadable address-space scan; its maximum covered gap is 230.978243 ms, so it remains qualified under the original coverage rule. This is an unqualified memory observation, not a measured memory regression. Pair 2's private/PSS changes (−3.2604%/−3.0705%) are retained but do not replace the invalid aggregate. All 611 raw scans remain in the VNDB artifact.

This cloud audit independently checks the logged arithmetic and qualification fields. It does **not** re-open every raw canonical-receipt field or re-audit the underlying /proc scans. Those files remain in the original artifacts, whose IDs, GitHub-provided digests and expiry are preserved below and in JSON.

## Retained evidence

- [hosted-46102503309.json](hosted-46102503309.json) contains every completed timing observation including warmups and controls, all twelve memory observations, original compact machine-readable log lines, plans, browser and source identities, package sizes/hashes, artifact metadata and independent calculations.
- [audit-screen.mjs](audit-screen.mjs) recomputes the paired summaries, exhaustive bootstrap endpoints, schedule identity and memory arithmetic without acquiring new measurements.
- Run `node builds/perf/import-registration-screen-20261128/audit-screen.mjs` from a checkout containing these files.

| Corpus | Job | Artifact | GitHub-provided ZIP SHA-256 |
| --- | --- | ---: | --- |
| jmdict | [140849615798](https://github.com/ManabiIO/manabitan/actions/runs/46102503309/job/140849615798) | 15247176931 | `7edf7c78a5358ce95950b7013121e058c4c75b4ae8344e067766277afce00aa4` |
| jitendex | [140849615758](https://github.com/ManabiIO/manabitan/actions/runs/46102503309/job/140849615758) | 15247481613 | `bbb1c61a1512495865261203dd9048c04e2f9cac0c9803391a5a17166973c30d` |
| vndb | [140849615766](https://github.com/ManabiIO/manabitan/actions/runs/46102503309/job/140849615766) | 15247368121 | `109fefa7ceb6d54ca45e220e93226e8afe068012946db395f6fb142268882aee` |

The artifacts expire on 2027-02-26. Their digests are metadata returned by GitHub; this audit did not download the large ZIPs to recompute them. The log-derived evidence in this commit is durable independently of artifact retention.

No failed observation was retried, no timing was removed, no favorable corpus was substituted, and no PR or new measurement workflow is created by this evidence archive.

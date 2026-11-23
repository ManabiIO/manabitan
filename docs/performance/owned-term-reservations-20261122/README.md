# Complete-import qualification of owned-content reservations

## Decision

The broad runtime candidate is rejected as a qualified performance improvement. None of the three complete-import cohorts establishes a repeatable gain against both identical-product controls. It remains on its experiment branch; this study PR contains tooling and evidence only, with no runtime product changes.

The candidate overlaps established block compression with record persistence for owned parser output and eligible generic shared sources. Its unit and integration checks pass, but successful execution of the new path is not evidence that it shortens the import critical path.

## Frozen inputs

| Item                                   | Revision                                               |
| -------------------------------------- | ------------------------------------------------------ |
| Baseline A/C                           | `5e1f8c12f7ff798ba407323aff675cb23b22af02`             |
| Runtime candidate B                    | `335d2385e9d202edcd046cd653674ffad9c1be13`             |
| Initial measurement tooling            | `e532028159b1ed5275860b349011262131236016`             |
| Corrected Jitendex measurement tooling | `58c76b9aee0c297f54ac8f4771e0c29f7cf2b85d`             |
| Final benchmark PR                     | [#804](https://github.com/ManabiIO/manabitan/pull/804) |

The release Chrome packages differ in exactly three product files: `dictionary-database.js`, `term-content-block-store.js`, and `term-import-metrics.js`. Both WASM artifacts are identical. The normalized evidence includes the complete package-entry manifests, source revisions and archive hash receipts. C reuses the exact A package.

| Complete dictionary    | Release      |     Terms | Referenced images | Referenced image bytes |
| ---------------------- | ------------ | --------: | ----------------: | ---------------------: |
| JMdict                 | 2026-11-22   |   528,299 |                 0 |                      0 |
| Jitendex               | 2026.10.03.0 |   436,555 |               236 |              4,992,155 |
| VNDB Characters by Bee | 1.0.0        | 6,648,310 |           146,570 |            188,131,284 |

The pinned VNDB source contains 4,267,992,967 bytes of term JSON across 665 banks. Every observation imports its complete archive. No dictionary ZIPs or media payloads are committed here.

## Fixed protocol

Each dictionary uses twelve three-arm blocks, with the order fixed before results were collected:

```text
ABC CBA BAC CAB BCA ACB ACB BCA CAB BAC CBA ABC
```

Each arm appears four times in each position. This supplies 36 observations per dictionary, twelve per arm. There are no excluded benchmark warmup iterations, retries, tail exclusions, or adaptive stopping. The first invalid Jitendex attempt is retained separately and is not part of its corrected cohort.

Both products receive the same measurement overlay and dependency lock. The script builds them before timing, records all package entry hashes, and verifies that the overlay is unchanged. Each observation uses a fresh browser profile, the release `chrome` target, production import defaults and the pinned complete archive. Tracing, phase profiling, screenshots, and process sampling are disabled.

The primary timer is the browser monotonic interval from the file-input change event through post-UI completion. Source preparation and post-import validation are outside it. Every timed observation checks dictionary identity/counts, closes and reopens the browser, verifies sampled definitions, performs 72 production lookups, verifies 64 evenly spaced referenced images where available, and records logical OPFS file sizes.

Separate A and B diagnostics follow the fixed timing cohort. They compare every referenced image byte against the source archive through the public media API. These extra imports are not added to the timing analysis.

B/A and B/C are reported independently. C/A measures the identical-product control. The paired median is the median of twelve within-block percentage changes. The descriptive interval resamples those twelve changes 10,000 times with seed `20261122`. Equal-work change is the ratio of summed candidate and control times minus one. No control subtraction or pooling across dictionaries is used. Positive changes mean slower.

## Complete-import results

| Dictionary |    A median |    B median |    C median | B/A paired change | B/C paired change | C/A control |
| ---------- | ----------: | ----------: | ----------: | ----------------: | ----------------: | ----------: |
| JMdict     |   696.05 ms |   705.70 ms |   702.30 ms |            +1.07% |            +0.69% |      +0.62% |
| Jitendex   | 1,362.50 ms | 1,353.70 ms | 1,336.85 ms |            +0.09% |            +0.91% |      −1.93% |
| VNDB       | 8,666.55 ms | 8,089.40 ms | 8,115.65 ms |            −3.50% |            −0.02% |      −0.83% |

| Dictionary/comparison | Paired median 95% interval | Equal-work change | Faster pairs |
| --------------------- | -------------------------: | ----------------: | -----------: |
| JMdict B/A            |           −1.22% to +3.42% |            +2.72% |         6/12 |
| JMdict B/C            |           −0.88% to +1.55% |            +1.81% |         5/12 |
| JMdict C/A            |           −0.93% to +1.45% |            +0.90% |         4/12 |
| Jitendex B/A          |           −2.49% to +3.75% |            +0.61% |         6/12 |
| Jitendex B/C          |           −1.39% to +3.79% |            −2.02% |         3/12 |
| Jitendex C/A          |           −3.83% to +0.83% |            +2.69% |         8/12 |
| VNDB B/A              |          −18.92% to +3.18% |            −6.99% |         7/12 |
| VNDB B/C              |           −3.68% to +4.01% |            −4.95% |         6/12 |
| VNDB C/A              |          −11.48% to +6.03% |            −2.15% |         7/12 |

JMdict's existing shared-buffer reservation path remains active. B records twelve reservations and zero owned-buffer reservations throughout. This is a compatibility/overhead comparison, not a workload exercising the new owned path. Its slightly slower estimates do not establish a speedup or a tight nonregression bound.

Jitendex activates 21 owned-buffer reservations out of 22 parser chunks in every B observation. The first chunk establishes measured compression savings through ordinary persistence. Its complete-import comparisons remain inconclusive despite this activation.

The Jitendex C observation of 2,108.4 ms in block 2 remains included. Its bulk-finalization interval is 765 ms, compared with 133 ms for A and 141 ms for B in that block. This retained tail explains why B/C equal-work time looks favorable even though B is faster in only three paired observations. It does not justify dropping that observation or treating the equal-work delta as a repeatable improvement.

VNDB activates 168 owned reservations in every B observation. Its apparent improvement against A does not repeat against identical control C: the paired median B/C change is −0.02%, with six faster pairs out of twelve. Large retained tails affect all three arms. The equal-work reductions are not sufficient to qualify this candidate.

Importer phase counters contain overlapping elapsed intervals and must not be summed or read as isolated CPU/disk-service costs. In particular, reservation completion can include concurrent record work in content-store and append intervals. VNDB’s finalization median stays about 1.94 seconds in all arms; its large tails concentrate in the combined record/index writer-close interval. These receipts locate the delays without proving their operating-system or scheduling cause.

## Persistence and lookups

| Dictionary | Logical OPFS bytes, all arms | First-pass lookup run-median medians A/B/C | Warm run-median medians A/B/C |
| ---------- | ---------------------------: | ------------------------------------------ | ----------------------------- |
| JMdict     |                   43,520,477 | 4.750 / 3.925 / 4.275 ms                   | 1.100 / 1.100 / 1.100 ms      |
| Jitendex   |                   67,466,332 | 3.375 / 2.775 / 2.525 ms                   | 0.900 / 0.900 / 0.900 ms      |
| VNDB       |                  609,553,611 | 2.025 / 1.800 / 1.850 ms                   | 1.000 / 1.000 / 1.000 ms      |

All 114 completed reports (108 timed observations plus six separate diagnostics) preserve exact title/revision and term/media counts through restart, use native OPFS storage, and report zero import/settings errors. The complete 72-response semantic lookup matrix agrees across every arm and pass. Each response includes the full requested query and an exact headword witness.

Logical file sizes agree across arms, including the complete file-size inventory after normalizing random SQLite opaque filenames. These are logical file sizes, not filesystem allocation or browser-profile sizes. First-pass lookup timing includes the settings-page RPC after restart and readiness checks; it is not a cold operating-system cache measurement. The lookup observations do not demonstrate an optimization.

The raw Jitendex content-probe digest changes by product arm because that diagnostic includes physical content offsets. Its semantic response hashes, decoded image bytes, and storage sizes agree. The report does not claim complete persisted-file byte equality or exhaustive equality of every term definition: term content is sampled, while referenced image verification is exhaustive in the separate diagnostics.

### Exhaustive media receipts

- JMdict: zero files/bytes, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Jitendex: 236 files / 4,992,155 bytes, SHA-256 `74aeb87663f4b89600affca40005fab432058227cd3fcb31c9f74d19a72a0402` in both diagnostics, independently recomputed from source bytes.
- VNDB: 146,570 files / 188,131,284 bytes, SHA-256 `ea94d392bc833baf0bee7b3d6becc3d3517eee84ee314a44986438ac6d5217cb` in both diagnostics, independently recomputed from source bytes.

The media digest hashes sorted compact JSON records `[path, byteLength, sha256(bytes)]`, each followed by a newline.

## Initial Jitendex oracle failure

The first baseline imported all 436,555 terms and 236 images, then stopped because the initial fixture incorrectly expected all 249 images in the ZIP to be persisted. No candidate timing was collected in that attempt.

Independent complete JSON scans established that thirteen SVG files are unreferenced, totaling 34,399 bytes. The repaired lock pins their exact paths, retains the complete ZIP SHA, requires every excluded path to be unique and present, checks the complete raw archive image count, and compares every referenced payload. All 146,570 VNDB images are referenced, so its expected count is unchanged.

The failed report and command log are preserved in [initial-jitendex-failure.json.gz](initial-jitendex-failure.json.gz). The corrected Jitendex cohort uses the same frozen products and complete archive. This correction changes validation after timing; it does not alter the timer or production import path.

## Runtime validation and limits

[Candidate validation](https://github.com/ManabiIO/manabitan/actions/runs/45103076565/job/137458113556) passed pinned native-artifact checks, JavaScript lint, all TypeScript projects, 14,016 unit tests across 627 files (47 skipped), and all-target builds. Focused coverage includes stable references, worker fallback with detached transfer slabs, exact decoded content, compressed frame payloads, failure draining and storage size.

The completed cohorts identify Chromium 153.0.8010.12 and Node 22.22.0. They record package archive hashes and full entry manifests. The uploaded artifacts omit built package ZIPs and do not include a browser-executable hash, so those container/binary bytes cannot be independently rehashed from the reports. Version consistency, package entries and both WASM files were independently reconciled against the frozen sources.

## Evidence and reproduction

- [JMdict normalized reports and protocol](jmdict.json.gz)
- [Jitendex normalized reports and protocol](jitendex.json.gz)
- [VNDB normalized reports and protocol](vndb.json.gz)
- [Initial full study](https://github.com/ManabiIO/manabitan/actions/runs/45103076565)
- [Corrected Jitendex study](https://github.com/ManabiIO/manabitan/actions/runs/45104124496)

The committed gzip-compressed JSON retains every normalized per-run summary, both diagnostics, all timing observations, package-entry manifests and the full tooling hash protocol. Compression is lossless; `SHA256SUMS` records the compressed file hashes. Read a report with `gzip -dc jmdict.json.gz`. Original HTML, raw JSON and command logs are available in the workflow artifacts for their configured fourteen-day retention; archive SHA-256 receipts are included in the committed evidence.

After checking out the study tooling with complete Git history, installing the locked dependencies/libraries and the matching Playwright Chromium, run:

```sh
python3 dev/perf/import-source-study.py \
  --baseline 5e1f8c12f7ff798ba407323aff675cb23b22af02 \
  --candidate 335d2385e9d202edcd046cd653674ffad9c1be13 \
  --dictionary jmdict \
  --output builds/perf/import-study-jmdict
```

Use `jitendex` or `vndb` for the other complete archives. Outputs include every declared observation and any failure. Repeated studies require a new output directory.

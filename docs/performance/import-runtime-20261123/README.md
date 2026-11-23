# Runtime import study: 2026-11-23

The combined changes from [#824](https://github.com/ManabiIO/manabitan/pull/824), [#825](https://github.com/ManabiIO/manabitan/pull/825), [#826](https://github.com/ManabiIO/manabitan/pull/826), and [#827](https://github.com/ManabiIO/manabitan/pull/827) reduced paired-median complete VNDB import time in the independent twelve-block qualification: **−3.52% against baseline A and −4.69% against identical baseline C**, with descriptive 95% intervals below zero against both. B was faster in 10/12 pairs against each control. This result belongs to the combined implementation; the experiment does not attribute it to an individual change.

**No standalone change established a complete-import improvement against both controls. No JMdict or Jitendex speedup is established.** The changes also eliminate measured copying or range operations, and the strict-row parser reduces VNDB's secondary native parse/encode elapsed metric. Those narrower findings are reported separately below.

This record includes all eight six-block screens and nine independent twelve-block qualification cohorts: **468 timed imports and 34 separate diagnostic imports**. Every scheduled import and both diagnostics in each cohort completed successfully. All observations, including unfavorable tails and identical-product control differences, remain included. Screens and qualification are never pooled.

## Frozen implementations and tooling

A and C use develop commit [`5e1f8c12f7ff798ba407323aff675cb23b22af02`](https://github.com/ManabiIO/manabitan/commit/5e1f8c12f7ff798ba407323aff675cb23b22af02), tree `e0a2c3977bca6e608d36dae6f2187a77d7a49b5d`. C reuses A's exact built package. Each cohort builds B from the corresponding frozen remote commit:

| Label    | Change                                                           | Remote commit                                                                                                                       | Git tree                                   |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| cache    | #824: retain an owned immutable slab through a subrange view     | [`ee0f578fa802d8672d46e0442a8baa1ca0b1b437`](https://github.com/ManabiIO/manabitan/commit/ee0f578fa802d8672d46e0442a8baa1ca0b1b437) | `e212bb58142575bb924ac6ddba1a2098e6a73eed` |
| columns  | #825: unique-indexed content metadata for duplicate-heavy groups | [`aed295978d3ee252275ed4263c8d378a2f4b376a`](https://github.com/ManabiIO/manabitan/commit/aed295978d3ee252275ed4263c8d378a2f4b376a) | `a4400b7df4ee95c1c202c5002642c612767ac196` |
| row      | #826: explicit strict format-3 eight-field native parser         | [`99ceb532e752327db5f817404e6bbc60b9408011`](https://github.com/ManabiIO/manabitan/commit/99ceb532e752327db5f817404e6bbc60b9408011) | `535b06edbecaf1e22e129994ea230657cc7222ed` |
| source   | #827: coalesce adjacent admitted ZIP range reads                 | [`8b3ba70a77b8cbea3d3316b2fc9c5066b020a59d`](https://github.com/ManabiIO/manabitan/commit/8b3ba70a77b8cbea3d3316b2fc9c5066b020a59d) | `c085fab3fb8fab8ee82a1a626997de25e9545b17` |
| combined | All four changes                                                 | [`b8ff4190fe37195734d8587d48d1a2aeb6038e4e`](https://github.com/ManabiIO/manabitan/commit/b8ff4190fe37195734d8587d48d1a2aeb6038e4e) | `64c0151c50f09e323d893ebeacedfd597e91f492` |

The screen uses tooling [`6040ebe654ae3044219691f8037349d3b603cd49`](https://github.com/ManabiIO/manabitan/commit/6040ebe654ae3044219691f8037349d3b603cd49), tree `377c9fe7a4bab3eb6ca5606f94c94363a7e0fe05`, in [run 45127415912](https://github.com/ManabiIO/manabitan/actions/runs/45127415912). Qualification uses [`0eea97429e101dd049b24c8318d1e5bee1b74909`](https://github.com/ManabiIO/manabitan/commit/0eea97429e101dd049b24c8318d1e5bee1b74909), tree `a937a704587129a05d66b4f85be3a109a9ac3745`, in [run 45128855872](https://github.com/ManabiIO/manabitan/actions/runs/45128855872). The [identity and CI bundle](source-and-ci-receipts.json.gz) preserves `round2-published.json`, final job receipts, and source CI results.

## Protocol and interpretation

The primary measurement is the browser monotonic duration from the page's file-input change event through its **post-UI import-complete event**. Each observation uses a fresh browser profile, the packaged Chrome extension, default import flags, Node 22.22.0 and Chromium 153.0.8010.12 on a GitHub-hosted Linux runner. Tracing is disabled. Package hashes, per-entry hashes, source revisions, dependency identity, browser identity, host snapshots, and tooling hashes are retained.

The runner overlays the same frozen `dev/perf` and `test` tooling into A and B worktrees; it does not overlay product files. Source CI validates the unmodified product revisions separately. Every cohort runs sequentially on its own runner, so absolute durations across cohorts are not comparable evidence of a candidate effect.

The six screening orders are `ABC, CBA, BAC, CAB, BCA, ACB`. Qualification uses a fresh set of observations in those orders followed by `ACB, BCA, CAB, BAC, CBA, ABC`. Each arm occupies each position equally. There are no excluded warmups, retries, tail trimming, or control subtraction. Lookups, storage checks and media verification occur after the import timer. Timed-cohort receipts sample up to 64 media files; separate A/B imports verify all requested media.

For each block, percentage change is `100 × (numerator / denominator − 1)`. Tables report the median of these paired changes, not the ratio of arm medians. The descriptive percentile-bootstrap interval uses 10,000 resamples, seed `20261122`, and sorted zero-based positions 249 and 9749. Intervals are unadjusted for multiple comparisons; six-pair intervals are especially unstable. “Lower” counts strictly lower numerator timings. “Equal work” is `100 × (sum(numerator) / sum(denominator) − 1)`, retaining every tail. Negative values mean less elapsed time. C/A exposes variation between identical implementations and is never subtracted from B's result.

## Primary result: independent twelve-block qualification

Each linked cohort contains 36 timed reports, its original analysis, and two exhaustive diagnostics. All percentages below use the complete twelve pairs.

| Cohort                                                         | Pair | Paired median | Descriptive 95% interval | Lower | Equal work |
| -------------------------------------------------------------- | ---- | ------------: | ------------------------ | ----: | ---------: |
| [combined / VNDB](qualification-combined-vndb.json.gz)         | B/A  |        −3.52% | [−5.98%, −1.59%]         | 10/12 |     −5.21% |
| combined / VNDB                                                | B/C  |        −4.69% | [−6.14%, −1.68%]         | 10/12 |     −3.79% |
| combined / VNDB                                                | C/A  |        +0.17% | [−7.73%, +2.62%]         |  6/12 |     −1.47% |
| [combined / JMdict](qualification-combined-jmdict.json.gz)     | B/A  |        +0.19% | [−4.62%, +8.90%]         |  5/12 |     +2.61% |
| combined / JMdict                                              | B/C  |        +0.04% | [−1.00%, +9.19%]         |  6/12 |     +3.73% |
| combined / JMdict                                              | C/A  |        −1.68% | [−2.82%, +1.61%]         |  7/12 |     −1.08% |
| [combined / Jitendex](qualification-combined-jitendex.json.gz) | B/A  |        +1.04% | [−3.06%, +4.23%]         |  6/12 |     +0.50% |
| combined / Jitendex                                            | B/C  |        +0.67% | [−6.66%, +5.63%]         |  6/12 |     −0.88% |
| combined / Jitendex                                            | C/A  |        −0.42% | [−2.13%, +3.72%]         |  6/12 |     +1.39% |
| [cache / JMdict](qualification-cache-jmdict.json.gz)           | B/A  |        −0.70% | [−2.06%, −0.17%]         | 10/12 |     −1.12% |
| cache / JMdict                                                 | B/C  |        −1.39% | [−2.86%, +0.06%]         |  9/12 |     −2.95% |
| cache / JMdict                                                 | C/A  |        +0.78% | [−2.09%, +2.40%]         |  5/12 |     +1.89% |
| [columns / VNDB](qualification-columns-vndb.json.gz)           | B/A  |        −3.14% | [−8.78%, −1.49%]         | 11/12 |     −3.47% |
| columns / VNDB                                                 | B/C  |        −0.98% | [−3.54%, +1.69%]         |  7/12 |     +0.35% |
| columns / VNDB                                                 | C/A  |        −2.95% | [−12.13%, +4.15%]        |  8/12 |     −3.81% |
| [row / JMdict](qualification-row-jmdict.json.gz)               | B/A  |        +0.29% | [−3.02%, +1.18%]         |  5/12 |     −2.66% |
| row / JMdict                                                   | B/C  |        −0.50% | [−2.46%, +1.68%]         |  7/12 |     −1.53% |
| row / JMdict                                                   | C/A  |        −0.79% | [−3.22%, +1.46%]         |  8/12 |     −1.15% |
| [row / Jitendex](qualification-row-jitendex.json.gz)           | B/A  |        −0.73% | [−3.53%, +1.45%]         |  6/12 |     −3.32% |
| row / Jitendex                                                 | B/C  |        −0.56% | [−2.38%, +2.72%]         |  7/12 |     +0.10% |
| row / Jitendex                                                 | C/A  |        +0.64% | [−3.93%, +1.33%]         |  5/12 |     −3.42% |
| [row / VNDB](qualification-row-vndb.json.gz)                   | B/A  |        +0.63% | [−4.06%, +1.13%]         |  5/12 |     −1.50% |
| row / VNDB                                                     | B/C  |        +0.05% | [−2.68%, +2.31%]         |  6/12 |     −0.21% |
| row / VNDB                                                     | C/A  |        −1.94% | [−3.62%, +0.57%]         |  8/12 |     −1.29% |
| [source / VNDB](qualification-source-vndb.json.gz)             | B/A  |        −0.89% | [−5.96%, +4.07%]         |  7/12 |     −1.53% |
| source / VNDB                                                  | B/C  |        +1.88% | [−3.14%, +5.43%]         |  4/12 |     +1.69% |
| source / VNDB                                                  | C/A  |        −1.93% | [−3.90%, −0.22%]         |  9/12 |     −3.16% |

For combined VNDB, A/B/C arm medians were **8,445.45 / 8,159.40 / 8,495.75 ms**. The two candidate intervals support a reduction for this frozen workload and environment. They do not establish a universal device effect or identify which component caused it. Cache and columns each look favorable against A alone, but their B/C intervals include zero; source's C/A difference itself excludes zero. Both controls are therefore material to interpretation.

Combined JMdict has essentially neutral paired medians and worse equal-work totals: **+2.61% B/A and +3.73% B/C**. Candidate observations of **1,149.0, 1,150.7 and 1,131.9 ms** occurred in blocks 5, 8 and 10, each with B first immediately after a B observation at the end of the preceding block. The other B-first observation, block 3, was 968.6 ms. This is an observed order association, not a demonstrated explanation; it neither proves host noise nor rules out a candidate regression. These observations remain in every estimate. Combined Jitendex also lacks a supported improvement.

## Exploratory six-block screens

Each linked screen contains 18 timed reports and two exhaustive diagnostics. These results did not replace qualification. In particular, the favorable row and source VNDB screens did not reproduce as standalone complete-import gains against both controls in the independent cohort.

| Cohort                                            | Pair | Paired median | Descriptive 95% interval | Lower | Equal work |
| ------------------------------------------------- | ---- | ------------: | ------------------------ | ----: | ---------: |
| [cache / JMdict](screen-cache-jmdict.json.gz)     | B/A  |        +1.98% | [−13.12%, +8.57%]        |   3/6 |     −1.62% |
| cache / JMdict                                    | B/C  |        +3.31% | [−7.14%, +7.36%]         |   2/6 |     +1.03% |
| cache / JMdict                                    | C/A  |        −2.67% | [−8.08%, +4.35%]         |   5/6 |     −2.62% |
| [cache / Jitendex](screen-cache-jitendex.json.gz) | B/A  |        −0.38% | [−5.04%, +10.43%]        |   3/6 |     +1.56% |
| cache / Jitendex                                  | B/C  |        −0.38% | [−3.58%, +7.94%]         |   4/6 |     +1.38% |
| cache / Jitendex                                  | C/A  |        +1.58% | [−4.77%, +4.04%]         |   2/6 |     +0.18% |
| [cache / VNDB](screen-cache-vndb.json.gz)         | B/A  |        −0.38% | [−3.83%, +0.41%]         |   3/6 |     −1.44% |
| cache / VNDB                                      | B/C  |        +0.37% | [−0.60%, +7.17%]         |   2/6 |     +2.29% |
| cache / VNDB                                      | C/A  |        −0.54% | [−9.19%, +0.18%]         |   5/6 |     −3.64% |
| [columns / VNDB](screen-columns-vndb.json.gz)     | B/A  |        −1.48% | [−3.95%, +0.10%]         |   5/6 |     −1.84% |
| columns / VNDB                                    | B/C  |        −0.91% | [−1.58%, +0.13%]         |   5/6 |     −0.79% |
| columns / VNDB                                    | C/A  |        −0.10% | [−3.50%, +0.61%]         |   3/6 |     −1.06% |
| [row / JMdict](screen-row-jmdict.json.gz)         | B/A  |        −1.69% | [−19.04%, +4.74%]        |   4/6 |     −6.27% |
| row / JMdict                                      | B/C  |        −0.78% | [−4.44%, +2.43%]         |   3/6 |     −0.96% |
| row / JMdict                                      | C/A  |        −1.26% | [−15.63%, +3.14%]        |   3/6 |     −5.36% |
| [row / Jitendex](screen-row-jitendex.json.gz)     | B/A  |        +0.08% | [−9.56%, +5.51%]         |   3/6 |     −1.76% |
| row / Jitendex                                    | B/C  |        −1.63% | [−10.39%, +6.14%]        |   4/6 |     −2.53% |
| row / Jitendex                                    | C/A  |        −0.26% | [−7.61%, +11.60%]        |   4/6 |     +0.80% |
| [row / VNDB](screen-row-vndb.json.gz)             | B/A  |        −2.64% | [−6.95%, −0.70%]         |   6/6 |     −3.54% |
| row / VNDB                                        | B/C  |        −1.66% | [−4.88%, −0.19%]         |   5/6 |     −2.28% |
| row / VNDB                                        | C/A  |        −0.52% | [−5.07%, +2.07%]         |   4/6 |     −1.29% |
| [source / VNDB](screen-source-vndb.json.gz)       | B/A  |        −2.46% | [−9.81%, −1.36%]         |   6/6 |     −4.85% |
| source / VNDB                                     | B/C  |        −3.13% | [−5.94%, −1.42%]         |   6/6 |     −3.54% |
| source / VNDB                                     | C/A  |        −0.22% | [−6.07%, +2.97%]         |   3/6 |     −1.36% |

## Reduced work and secondary parser measurements

**Cache (#824).** JMdict adoption rises from 76,482,945 to 101,143,281 cumulative payload bytes per import, eliminating **24,660,336 copied bytes**. Payload coverage and 3,998 recent-source hits match the controls. Ownership must be proven and consumed once; borrowed or oversized buffers retain the copy path. Admission, eviction and rollback charge the complete backing allocation. Retaining unused backing bytes can reduce cache coverage on other inputs. This is a measured copy reduction, without a qualified standalone latency claim. The Jitendex/VNDB screens report no cache payload adoption.

**Columns (#825).** Every VNDB browser candidate activates 170 compact groups and avoids **103,847,136 descriptor snapshot bytes**. Native canonical-scanner input copying falls from **135,649,888 to 5,840,968 bytes**. Unique IDs still map duplicate rows to exact representatives; collision checks and failure boundaries remain in place. Temporary metadata gathering still allocates and copies, so these counters are neither net-allocation nor peak-memory measurements. JMdict/Jitendex retain row-indexed metadata for these fixtures.

**Source (#827).** VNDB browser imports serve **665 logical range requests with 163 physical Blob reads**. Merges cover already-admitted adjacent or overlapping ranges, add no gaps or speculative entries, remain bounded by 4 MiB, preserve per-entry validation, and return independently transferable payloads. The fixed-four-bank component proof gives 167 reads instead of 665 because its grouping differs. JMdict and Jitendex use the existing whole-archive cache; coalescing does not activate there.

**Row (#826), secondary analysis.** The strict parser regenerates the native WASM module, increasing its size by 4,309 bytes (54,596 to 58,905 bytes). `fastPathParserParseBankMs` in `import-data-banks` aggregates elapsed durations around native parsing and fused content encoding. The [reproducible secondary analysis](secondary-phase.json.gz) retains all 162 timed row reports' values, source/input hashes, and all comparisons. VNDB results are:

| Cohort        | Pair | Paired median | Descriptive 95% interval | Lower | Equal work |
| ------------- | ---- | ------------: | ------------------------ | ----: | ---------: |
| Qualification | B/A  |       −10.61% | [−11.49%, −8.32%]        | 12/12 |     −9.51% |
| Qualification | B/C  |        −9.65% | [−13.07%, −4.66%]        | 11/12 |     −8.92% |
| Qualification | C/A  |        +0.52% | [−3.29%, +5.04%]         |  4/12 |     −0.64% |
| Screen        | B/A  |        −7.01% | [−13.17%, −3.64%]        |   6/6 |     −8.04% |
| Screen        | B/C  |       −10.30% | [−13.66%, −2.59%]        |   5/6 |     −8.99% |
| Screen        | C/A  |        +1.22% | [−4.95%, +7.45%]         |   3/6 |     +1.04% |

The qualification phase medians A/B/C are 3,639.5 / 3,245.5 / 3,608.5 ms. Every VNDB row observation uses three workers, 170 fused groups, zero fused fallbacks, and 6,490,145 validated glossary reuses. The separate encode-content timer is zero because encoding occurs inside the fused call. The reduction is supported against both controls in both separate cohorts. JMdict and Jitendex phase intervals cross zero.

These are **secondary, descriptive, unadjusted elapsed measurements summed across workers**. They include scheduling/preemption and are not CPU-time or energy measurements. Concurrent durations are not additive to import wall time. In particular, the row-only primary VNDB result remains neutral; less aggregate parser elapsed time did not establish less complete-import latency.

## Fixture identity and correctness evidence

The [frozen dictionary lock](https://github.com/ManabiIO/manabitan/blob/0eea97429e101dd049b24c8318d1e5bee1b74909/test/perf/dictionaries.lock.json) pins complete release archives, including media, with download URLs, exact sizes, titles, revisions and SHA-256:

| Dictionary / release                |   ZIP bytes | Term banks / rows | Archive SHA-256                                                    |
| ----------------------------------- | ----------: | ----------------: | ------------------------------------------------------------------ |
| JMdict / 2026-11-22                 |  15,645,766 |      53 / 528,299 | `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f` |
| Jitendex / 2026.10.03.0             |  38,831,822 |     219 / 436,555 | `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356` |
| VNDB / 1.0.0, revision 395525135651 | 291,705,969 |   665 / 6,648,310 | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` |

Every browser receipt verifies imported identity and row totals, readable content, 72 production lookup observations with result counts and semantic digests, and a restart with readable content. First-pass and warm lookup timings remain in the raw reports; neither is used to claim a lookup speedup. Every timed/diagnostic run preserves the dictionary's logical installed bytes:

| Dictionary | Installed bytes |        Exhaustive requested media | Persisted media SHA-256                                            |
| ---------- | --------------: | --------------------------------: | ------------------------------------------------------------------ |
| JMdict     |      43,520,477 |                 0 files / 0 bytes | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Jitendex   |      67,466,332 |       236 files / 4,992,155 bytes | `74aeb87663f4b89600affca40005fab432058227cd3fcb31c9f74d19a72a0402` |
| VNDB       |     609,553,611 | 146,570 files / 188,131,284 bytes | `ea94d392bc833baf0bee7b3d6becc3d3517eee84ee314a44986438ac6d5217cb` |

These media digests match source payloads and both exhaustive A/B diagnostics. Jitendex includes 13 additional unreferenced archive images; the lock explicitly records them. They are not imported by the existing production behavior. Storage receipts record file sizes and sampled content digests; this is not a claim that every persisted storage byte was independently hashed.

Separate bounded full-data proofs cover all **937 term banks, 7,613,164 rows and 4,978,537,800 inflated term-bank bytes per implementation**:

- [Strict-row parity](strict-row-parity.json.gz) compares baseline with local commit `3e08dd4cd59702bcc8d9e05c3ebedd1cb51c44f0`, whose tree equals the published row head. Six framed digest streams match for decoded row fields, every encoded content byte/hash, lookup construction, exact dedup mapping, media projections and inflated bank bytes. All archive hashes and bank CRCs are checked. Fixed grouping exercises 25 VNDB fused fallbacks identically in both implementations; the browser grouping has none.
- [Compact-metadata parity](compact-metadata-parity.json.gz) explicitly enables compaction at local commit `94b832b628c57cf61110a43101f630b36b41c3d7`, whose tree equals the published columns head. It matches the same categories of full-data semantics against baseline. All 167 bounded VNDB groups compact; descriptor reduction is 103,847,328 bytes under that grouping. JMdict/Jitendex compact zero groups. Its independently framed hashes are compared within this proof, not against the row proof's hashes.
- [Source-coalescing proof](source-coalescing-proof.json.gz) checks every compressed bank payload against an independent direct-ZIP oracle. VNDB's 665 versus 167 range reads transfer the same 86,882,236 range bytes and share payload digest `99e92525339772592a24e2d1a46d6080485879e2745a680f5857170040a59644`. The other archives also preserve every payload digest and their whole-archive path.

These component proofs measure functionality, not performance. They do not replace browser scheduling, persistence, restart, or media-payload verification; the browser receipts provide that complementary coverage.

The four frozen source CI runs passed their applicable JavaScript, four TypeScript configurations, full unit/options tests, native artifacts, builds and Chromium/Firefox E2E jobs: [cache](https://github.com/ManabiIO/manabitan/actions/runs/45126780039), [columns](https://github.com/ManabiIO/manabitan/actions/runs/45125831476), [row](https://github.com/ManabiIO/manabitan/actions/runs/45125833597), [source](https://github.com/ManabiIO/manabitan/actions/runs/45126317944). Each has 15 successful jobs and four manual/platform skips. The independent combined-source validation passed lint, all TypeScript configurations, unit tests and build validation: **629 test files, 14,084 passed tests and 47 skipped tests**. Final receipts, not merely an intermediate `analysis.json`, establish diagnostic/job completion.

## Reproduction and retained evidence

The [frozen runner](https://github.com/ManabiIO/manabitan/blob/0eea97429e101dd049b24c8318d1e5bee1b74909/dev/perf/import-runtime-study.py) and [qualification workflow](https://github.com/ManabiIO/manabitan/blob/0eea97429e101dd049b24c8318d1e5bee1b74909/.github/workflows/import-runtime-qualification-20261123.yml) specify the complete procedure. With the recorded commits available in a clone and Node 22.22.0 installed, use a new output directory:

```sh
git switch --detach 0eea97429e101dd049b24c8318d1e5bee1b74909
npm ci
npx playwright install --with-deps chromium
python3 dev/perf/import-runtime-study.py \
  --baseline 5e1f8c12f7ff798ba407323aff675cb23b22af02 \
  --candidate b8ff4190fe37195734d8587d48d1a2aeb6038e4e \
  --label combined --dictionary vndb \
  --output builds/perf/reproduce-combined-vndb
```

The runner fetches/verifies fixtures with `node dev/perf/prepare-dictionaries.js --all`, builds packages and checks matching dependency locks, runs the balanced cohort, and follows it with exhaustive diagnostics. Substitute the frozen candidate and dictionary to reproduce another qualification. For a screen, use the screen tooling commit and add `--screen`; keep that result separate. Reproduction on another host produces new observations, not replacements for these retained samples.

[index.json](index.json) inventories the bundles; [SHA256SUMS](SHA256SUMS) records their checksums. Each gzip file contains JSON with a `files` map: every retained JSON/log/script file has its relative path, SHA-256 and verbatim UTF-8 `content`. Cohort bundles also retain original artifact ZIP metadata/digests and final GitHub job receipts. Generated HTML is omitted with its path, size and hash recorded. All original ZIP hashes were checked against fresh GitHub artifact metadata, and retained JSON/log bytes were checked against the original archives.

To reproduce the secondary analysis without rerunning imports, extract `analyze.py` from [secondary-phase.json.gz](secondary-phase.json.gz) and run `python3 analyze.py --bundles-dir docs/performance/import-runtime-20261123 --output secondary-recomputed.json`. It reads the six row cohort bundles, verifies input hashes and frozen identities, and recomputes all 18 paired phase comparisons with the exact bootstrap formula. The full raw values, scripts, checks and limits remain available even after hosted artifact retention expires.

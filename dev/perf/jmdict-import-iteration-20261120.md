# JMdict import optimization — 2026-11-20

## Result

The combined implementation in [PR #784](https://github.com/ManabiIO/manabitan/pull/784) reduced complete JMdict import time by **6.02% on Chromium and 4.15% on Firefox**, measured as the median of twelve baseline/candidate pair changes in the final fixed cohort. Eleven of twelve Chromium pairs and ten of twelve Firefox pairs were faster. Equal-work reductions were 5.56% and 3.25%, respectively. The two components were also tested independently before combination.

This is a measured JMdict improvement with costs. The final Chromium JMnedict cohort was 1.63% slower by paired median and 2.25% slower by equal-work total; its same-code controls also drifted upward. Separate Chromium diagnostics measured additional peak process-tree PSS: 35.46 MiB for JMdict and 53.21 MiB for JMnedict. No universal cross-dictionary speedup or memory nonregression is claimed.

Full CI passed on the exact combined source tree: 622 unit-test files, 13,854 passing tests, actual Chromium and Firefox extension verification, builds, and forced-interruption recovery. A separate Firefox diagnostic using release extension packages compared every persisted JMdict term-content, record and index byte, before and after extension reload. The complete baseline/candidate payloads matched after normalizing only their independently generated generation identifiers.

The product remains unmerged. [PR #785](https://github.com/ManabiIO/manabitan/pull/785) separately fixes the benchmark receipt validator; it changes no packaged extension code. Its CI also passed. The checkpoint-flush experiment is not included in either PR.

## Frozen source and scope

This follow-up starts from the current `develop`, not the earlier November 19 baseline. It already includes the previous metadata-publication optimization and subsequent parser, ownership, cache, media and recovery changes. Those existing changes are not counted again here.

| Identity              | Commit or tree                             |
| --------------------- | ------------------------------------------ |
| Baseline              | `d733d0efe53398bfc2b45985aa709ade54f5710a` |
| Baseline tree         | `2e13cff67cc5805562d68af572ed66b01b677838` |
| Combined product      | `a0f8e8e00d30823b8451248b3e6bab20b4640eb8` |
| Combined product tree | `b0d18a0f0bbd096ebe9a18d09bf284d2684d4a65` |
| Final qualifier       | `a85079bae287ff799fbdebc169cd08e16edd9943` |
| Tested PR merge       | `ef8b8e242e8fbeef260d23db05827896f2320323` |

The tested merge tree equals the measured product tree. The final qualifier has the product as its sole parent and adds only declared qualification tooling. The product contains twelve changed files, including six packaged JavaScript files, targeted tests and a fixture-scheduling correction. No native source or WASM binary changes, dictionary-name special cases, cache-budget increases, altered compression defaults or storage-format changes are included.

All executed hosted jobs ran on Linux. Performance runs used Ubuntu 26.04, Node 22.22.0 and prebuilt release packages. Chromium was pinned to 153.0.8010.12. Firefox used a pinned Developer Edition 161.0b5 distribution, with application capability version 161.0 and the existing test preferences for shared memory and temporary unsigned extension installation. These Firefox results are not an ordinary, unmodified consumer-profile qualification. There is no macOS performance result.

The unchanged fixture lock contains 526,942 JMdict rows, 667,942 JMnedict rows and 435,448 Jitendex rows. Runtime binaries, archive bytes, source trees, package entries, helper inputs and settings are recorded with each cohort. Absolute times from different hosted machines are not compared as if they came from one machine.

## Final combined measurement

The [final run](https://github.com/ManabiIO/manabitan/actions/runs/44827149924) completed all **144 planned observations**, with no protocol, content, runtime or persistence failure. Each of four cells contains twelve baseline/candidate pairs and six interleaved same-package control pairs. The plan was frozen at `2026-11-20T22:03:05Z`, before any combined-product results.

Negative changes mean faster. Paired median is the median of `100 × (B/A − 1)` for matching adjacent pairs. Equal-work change is `100 × (sum(B) / sum(A) − 1)`. All first observations, slow observations and unfavorable pairs are retained.

| Browser / dictionary | Candidate paired median | Equal-work change | Faster pairs | Mean baseline → candidate | Same-code paired median | Same-code equal work |
| -------------------- | ----------------------: | ----------------: | -----------: | ------------------------: | ----------------------: | -------------------: |
| Chromium / JMdict    |             **−6.017%** |       **−5.564%** |    **11/12** |        1,031.2 → 973.8 ms |                 +0.064% |              −0.043% |
| Firefox / JMdict     |             **−4.149%** |       **−3.251%** |    **10/12** |      1,104.8 → 1,068.8 ms |                 −0.859% |              −1.157% |
| Chromium / JMnedict  |                 +1.627% |           +2.254% |         1/12 |          956.2 → 977.8 ms |                 +3.039% |              +3.928% |
| Chromium / Jitendex  |                 −0.605% |           −1.055% |         8/12 |      1,641.6 → 1,624.3 ms |                 +1.204% |              +1.677% |

The complete-import mean savings are 57.4 ms for Chromium JMdict and 35.9 ms for Firefox JMdict. These are the measured combined effects; component percentages are not added together.

The JMnedict result is an observed slowdown, with eleven of twelve candidate pairs slower. The larger upward same-code drift limits attribution; it does not justify subtracting the control percentage or relabeling the candidate as faster. Jitendex's small negative difference is within the scale of observed control variation and is not promoted as a demonstrated cross-dictionary gain.

The fixed order was:

```text
B1 A1 D1 C1 A2 B2
B3 A3 C2 D2 A4 B4
B5 A5 D3 C3 A6 B6
B7 A7 C4 D4 A8 B8
B9 A9 D5 C5 A10 B10
B11 A11 C6 D6 A12 B12
```

A, C and D use the same baseline package; B uses the combined package. Starting arms are balanced. Every observation starts with a fresh profile. The authoritative timer begins at the browser file-input change event and ends at the current import's post-UI completion signal. Package preparation, hashing, content probes, persistence checks and cleanup are outside that timer. Profiling and process sampling are disabled during these observations. There are no selected warmups, retries, adaptive stopping or favorable subsets.

Chromium checks persisted data after a browser restart. Firefox checks source-derived content probes and physical storage bounds after an AddonManager extension reload with a changed background realm. The latter does not restart the Firefox process. Both routine benchmark checks are sampled content verification; the exhaustive stored-byte diagnostic is separate.

## Implementation and mechanism

### Independent shared content buffers

Previously, the ordinary parallel parser returned a view into reusable shared WASM memory. Its worker had to keep that memory unchanged until the ordered storage sink finished with it. The recent-source cache separately copied retained content because later parser work could overwrite the original buffer.

The worker now copies an eligible complete small-definition group into a fresh, independently owned `SharedArrayBuffer` before posting the result. The worker can reuse its WASM heap while the sink works on the immutable output. Keeping the output shared preserves the existing compression reservation and shared-span packing paths. An earlier ordinary-ArrayBuffer prototype was rejected before timing because it would change those paths.

Admission requires complete native metadata, the existing average-definition criterion of at most 512 bytes, and a group backing allocation no larger than 48 MiB. A private `WeakSet` records ownership only for exact full backing views received through the explicit worker ownership path. A conflicting borrowed-memory result takes precedence. Arbitrary callers cannot acquire the ownership witness merely by attaching a property to a byte array.

The recent-source cache adopts that buffer only when its retained range is the complete exact backing allocation. Partial spans and unwitnessed or borrowed buffers retain the existing copy. Adoption consumes the witness. Exact duplicate comparison, byte accounting, FIFO retention, existing 96/48 MiB cache budgets, rollback and cancellation joins remain in place.

Every final JMdict candidate observation reports:

| Work / ownership counter                     |          Baseline |             Combined |
| -------------------------------------------- | ----------------: | -------------------: |
| Retained recent-source coverage              | 100,724,405 bytes |    100,724,405 bytes |
| Retained bytes adopted without the sink copy |                 0 | **82,637,043 bytes** |
| Retained bytes still requiring the sink copy | 100,724,405 bytes |     18,087,362 bytes |
| Borrowed content results                     |                12 |                    0 |
| Initial shared compression reservations      |                 1 |                    1 |
| Missed initial reservation savings           |                 0 |                    0 |

The baseline does not expose the new adoption counter. Its zero adopted bytes and 100,724,405 copied bytes are derived from the measured retained-byte total and the baseline's unconditional copy path. Candidate adoption is explicitly measured.

About 82.04% of the retained byte volume avoids the later sink copy. This is not elimination of all copying: the worker still creates an independent output, and partial cache spans still copy. Total owned output is 100,725,122 bytes per pinned JMdict import.

The final phase counters support the intended scheduling change. Mean recent-source cache time falls from 129.0 to 62.8 ms on Chromium and from 107.5 to 55.0 ms on Firefox. Mean parser-result copy time increases from roughly 21 ms to 115–118 ms because copying moves into workers. Mean parser-worker wall time falls from 886.9 to 782.3 ms on Chromium and from 930.8 to 762.9 ms on Firefox.

These overlapping counters are not additive wall-clock savings. In the ownership-only confirmation, the storage sink itself took longer while complete import time improved. The supported mechanism is earlier parser completion and changed overlap, not a claim that every sink phase becomes faster.

### Typed-array constructor copies

Seven parser output copies now use typed-array constructors instead of `.from`: canonical signatures, encoded native lookup bytes, and five segmented-plan columns. Each constructor still allocates independent owned backing with the same width and view length. No mutable WASM view is substituted for a copy.

The separate Firefox trial showed a repeated reduction in lookup-index preparation, confirmed by whole-import timing. In the final combined Firefox cohort, mean lookup-index preparation falls from 166.7 to 42.3 ms. The five segmented-plan sites were not exercised by the pinned JMdict browser import path, so they are not credited for this fixture's gain. The independent Chromium constructor-only trial did not demonstrate an import improvement.

## Independent component trials and rejected work

Each component was frozen independently from the same baseline. Initial cells contain eight candidate pairs and four controls; confirmation cells contain twelve candidate pairs and six controls. Initial and confirmation cohorts are not pooled with the combined result.

| Component / browser            | Initial JMdict paired median | Confirmation paired median | Confirmation equal work | Faster confirmation pairs | Confirmation control median |
| ------------------------------ | ---------------------------: | -------------------------: | ----------------------: | ------------------------: | --------------------------: |
| Owned shared output / Chromium |                      −7.421% |                **−4.579%** |                 −3.105% |                     11/12 |                     +0.622% |
| Owned shared output / Firefox  |                      −1.823% |                    −1.158% |                 −0.597% |                      7/12 |                     +0.773% |
| Constructor copies / Firefox   |                      −5.925% |                **−3.801%** |                 −4.159% |                     11/12 |                     +0.411% |
| Constructor copies / Chromium  |                      +0.370% |                    +1.682% |                 −5.218% |                      3/12 |                     −0.093% |

Sources: [ownership initial](https://github.com/ManabiIO/manabitan/actions/runs/44822991557), [ownership confirmation](https://github.com/ManabiIO/manabitan/actions/runs/44824275564), [constructors initial](https://github.com/ManabiIO/manabitan/actions/runs/44822987274), [constructors confirmation](https://github.com/ManabiIO/manabitan/actions/runs/44824128941).

Constructor-only Chromium's favorable equal-work aggregate is dominated by its first baseline observation: 2,295.4 ms versus 1,205.9 ms candidate. Nine of twelve candidate pairs are slower, and the median regresses. That observation stays in the record, but it does not establish a Chromium constructor benefit. Ownership confirmation likewise retains an unfavorable first candidate pair (+16.73%) and same-code pair (+20.50%).

An independent [8 MiB checkpoint-flush candidate](https://github.com/ManabiIO/manabitan/actions/runs/44823809974) attempted to move body flushing earlier while preserving final header flush, sticky errors and abort joins. It passed 280 focused storage/cleanup tests and review. Its Chromium JMdict paired median was −3.98%, versus −2.20% for controls; Firefox was +0.72% and JMnedict +2.11%. This did not justify selection, and the implementation is excluded from the combined product.

Across the three initial four-cell screens, two two-cell confirmations and the final four-cell cohort, all **576 planned observation records** are retained. Seventy-two observations in the three initial Jitendex cells remain invalid; the other 504 passed their original protocol. A separate current-baseline control/profile run contains eight additional timed observations. Trace runs, payload diagnostics and CI are not counted as timed candidate observations.

## Memory and queue limits

Independent output allows more content to remain live while workers run ahead. The existing three-worker, four-group lead permits twelve arrived plain-group outputs. At the per-group 48 MiB ceiling, their theoretical maximum is **576 MiB**, additional to native heaps, retained cache and other browser memory. This applies only to admitted compact-owned plain groups, including the active sink; it excludes the preexisting large projected-output path. It is an admission/lead bound, not the observed size of this fixture's queue and not a new process-memory cap.

`parserParallelPeakQueuedOwnedContentBytes` counts arrived owned results whose ordered sink has not completed. It excludes allocations still inside workers before message delivery, cache-retained buffers after sink completion, WASM heaps and the rest of the process tree. It must not be presented as total resident memory. Jitendex already used large projected owned output in the baseline; the new counter also observes that existing path.

Separate final Chromium diagnostics sampled the wrapper and descendant processes every 50 ms, with samples clipped to the recorded worker-import interval:

| Dictionary | Baseline peak PSS | Combined peak PSS |          Change | In-window samples A / B |
| ---------- | ----------------: | ----------------: | --------------: | ----------------------: |
| JMdict     |     1,248.053 MiB |     1,283.516 MiB | **+35.463 MiB** |                 21 / 18 |
| JMnedict   |     1,129.134 MiB |     1,182.349 MiB | **+53.215 MiB** |                 22 / 22 |
| Jitendex   |     1,585.763 MiB |     1,598.431 MiB |     +12.668 MiB |                 37 / 36 |

These are one diagnostic observation per arm, with no sample errors; sampled peaks are lower bounds. They are outside the authoritative timing cohort. No Firefox process-memory measurement is available. The ownership-only initial JMdict diagnostic was nearly flat, while its confirmation increased by 37.34 MiB; the final combined increase should therefore be treated as a real tradeoff to review, not dismissed using the most favorable earlier sample.

The [cross-dictionary analysis](jmdict-iteration-20261120/cross-dictionary-tradeoff.md) finds that JMnedict adopts only 55.59% of retained bytes and finishes parsing earlier without shortening its busy sink. Its sampled memory increase exceeds its entire owned-content volume, so the content queue alone cannot explain the difference. A useful next experiment would budget complete queued outputs while keeping input partitioning constant: the current lead parameter also changes group count. No such alternative is validated here, and a size threshold selected merely to separate these two fixtures is not included.

## Correctness and recovery evidence

The unchanged full-fixture component oracle matched baseline content, hashes, lengths, scores, sequences, equality flags, encoded lookup bytes and lookup-plan columns for all three complete fixtures. Full digests are retained in the evidence. This sequential in-memory oracle does not itself prove parallel ownership or persisted-storage behavior.

The separate [combined persisted-payload run](https://github.com/ManabiIO/manabitan/actions/runs/44826746012) imported both release packages into fresh Firefox profiles. It hashed all three JMdict term files, totaling **43,176,166 bytes**, covering all 526,942 rows. It checked contiguous segments, paired generation identifiers, descriptor sizes, row counts and stable file inventory. All raw hashes were identical before and after extension reload within each arm.

Across baseline and candidate, only the two paired 16-byte generation fields were normalized: bytes `[8,24)` in `MBTRD16X` and `[24,40)` in `MBTIDX11`. Every other byte, including all 19,482,745 term-content bytes, compared unchanged. Both normalized manifests have SHA-256 `a96c7590672d8e6260b225e336112b9da92fcc07b3352aa57a089793159ac3ef`. This covers term payloads; SQLite metadata and media are outside that exhaustive check.

The [combined CI](https://github.com/ManabiIO/manabitan/actions/runs/44826704284) completed all seven PR workflows and all 21 executed jobs successfully. Four existing conditional Edge, Android and release-upgrade jobs were skipped. The full unit suite passed 13,854 tests across 622 files, with 47 skipped. Chromium completed 90 extension phases and Firefox 63; both reported actual dedicated-worker OPFS SAHpool, fallback disabled and `skippedVerification=false`. All ten Anki deduplication scenarios passed.

The independent [interruption/restart run](https://github.com/ManabiIO/manabitan/actions/runs/44826704427) held Chromium after a 2,514,264-byte, 48,000-record staging write. All nine captured Chromium processes received SIGKILL and exited. Recovery retained the old three-entry generation and removed the interrupted staging row. A subsequent complete update published 350,001 entries with the expected sentinel and no transient metadata. The independent audit passed 23 checks and verified the exact source/tree, harness, six changed packaged files, complete instrumented package tree and observer insertion. The original extension and revision-two fixture ZIPs were not retained by that artifact, so their reported ZIP hashes could not be independently rehashed; the retained package and all archived fixture rows were checked.

Local focused validation passed 651 tests across nine files, changed-file lint, main/test types and dry-runs for all seven build targets. Earlier local full-suite compiler and scheduling failures, their baseline reproductions and subsequent configured checks remain preserved. The final source-bound hosted full suite is the complete product gate.

One test fixture required a scheduling correction: it previously cancelled a peer worker before waiting for that worker to reach a readiness promise, which could deadlock the fixture itself. The corrected fixture waits for both the active sink and peer readiness before delivering the error. The active sink remains blocked on a separate finish gate, retaining the failure-during-storage assertion. Controlled baseline/candidate reproduction and 62 native fixture schedules verify the correction. No production cancellation behavior was changed to satisfy the fixture.

## Benchmark receipt correction and preserved failures

All three initial Jitendex cohorts failed the wrapper's requested/effective experiment comparison. The pinned archive has 537,538,792 uncompressed source bytes, just above 512 MiB, and enters the existing large projected native path. Production deliberately enables `experimentalNativeEscapedKeys` there although the requested default remains false. Raw import/readback/restart work succeeded, but those 72 wrapper failures remain invalid and their comparisons remain null.

[PR #785](https://github.com/ManabiIO/manabitan/pull/785) permits only that effective override after independently verifying the source-size, media projection, native parallel worker and skip-reason receipts. Requested and compression settings remain the exact defaults, and other flags stay strict. It contains 105 focused receipt tests, plus local policy and negative-case checks; all six PR CI workflows passed.

The final qualifier applies the corrected wrapper byte-identically to both Chromium product worktrees, explicitly archiving original and replacement hashes. Firefox does not use that wrapper and retains its unchanged observer. The corrected validator is outside the product commit. Final Jitendex now passes all 36 observations with requested/compression false and effective parser true; other cells remain false. This fresh cohort does not retroactively repair the earlier invalid measurements.

The first two qualification workflow submissions also had an invalid job-level environment expression. They produced zero observations. Their failed runs and the subsequent tooling-only correction are retained; they are not counted as imports or silently presented as successful campaigns.

## Evidence and reproduction

The [evidence directory](jmdict-iteration-20261120/) records all cohort summaries, observations, pair changes, source identities and validation outcomes:

- [All 576 observation records](jmdict-iteration-20261120/observations.jsonl), [all 288 pair records](jmdict-iteration-20261120/pairs.jsonl), [cohort summaries](jmdict-iteration-20261120/cohorts.json) and [preserved failures](jmdict-iteration-20261120/failures.json).
- [Final combined results and phase/memory data](jmdict-iteration-20261120/final-results.json), [complete final observation tables](jmdict-iteration-20261120/final-results.md), and the [cross-dictionary analysis](jmdict-iteration-20261120/cross-dictionary-tradeoff.md).
- [Product CI](jmdict-iteration-20261120/product-ci.json), [verifier CI](jmdict-iteration-20261120/verifier-ci.json), [persisted-payload validation](jmdict-iteration-20261120/persisted-payload-validation.json), [component evidence](jmdict-iteration-20261120/component-evidence.json.gz), [source publications](jmdict-iteration-20261120/source-publications.json) and the [independent report review](jmdict-iteration-20261120/report-review.json).
- [Offline replay instructions](jmdict-iteration-20261120/README.md), [completed replay receipt](jmdict-iteration-20261120/offline-verification-receipt.json), and [full archive identity and inventory](jmdict-iteration-20261120/raw-archive.json).

The complete separately delivered `jmdict-import-evidence-20261120.tar.gz` preserves 27 original GitHub artifact ZIPs, the full self-contained replay packet, raw diagnostics, unsuccessful experiments, local checks and independent reviews. Its manifest records each retained file's exact byte length and SHA-256. The compact Git subset contains the numeric record and verification entry point; offline replay also requires the full packet from that archive.

Each original artifact was verified against GitHub's published size and digest before safe extraction. Exact archived analyzers were then replayed offline, reproducing both successful cohorts and the three invalid initial Jitendex cohorts. No new browser execution is required to check the retained record. Replaying receipts does not turn sampled content probes into exhaustive correctness or extend results to untested operating systems.

For the final cohort, the archived command is:

```sh
python3 qualifier-inputs/dev/perf/jmdict-final-20261120.py analyze --evidence /absolute/extracted/cell
```

For component byte parity, run the unchanged driver from the exact product checkout against each pinned fixture:

```sh
node --expose-gc dev/perf/import-lookup-screen.js jmdict --child --flags '{}'
```

The executable qualification commits provide package preparation, exact browser/runtime pins, fixture checks, the complete observation order and the same-harness overlay. Reproduction should preserve those identities and retain failures. Component timings, traced diagnostics and full CI durations are not substitutes for the complete-import timer.

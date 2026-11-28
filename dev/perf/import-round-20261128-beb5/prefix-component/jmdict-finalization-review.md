# JMdict finalization review — 2026-11-28

## Decision

No distinct new finalization experiment is justified by this bounded review. The dominant close work is the required synchronous sidecar flush already isolated by #868. The substantial JavaScript publication passes either have current competing work, previously failed complete-import experiments, or enforce live-value and pending-write invariants that cannot be removed from this API. This review made no product changes, ran no timing campaign, and changed no cache, batching, worker, or durability policy.

The active decompression-stream study remains a separate, larger owning-phase hypothesis. Its resource and browser conformance decisions are still prerequisites to any product change.

## Source and evidence

- Product baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
- Exact baseline source: `manabitan/ext/js/dictionary/dictionary-database.js`, `term-record-opfs-store.js`, and `term-record-import-index-writer.js` in this workspace.
- Ordinary diagnostic: `profiles/jmdict/ordinary/summary.json`.
- Traced diagnostic: `profiles/jmdict/trace/summary.json`, with the original trace preserved in `profiles/jmdict.zip`.
- Derived sample attribution: `results/jmdict-finalization-trace-detail.json`; existing resize attribution is in `profiles/jmdict/trace/metadata-detail.json`.

These are single diagnostic imports. Sampled time is an attribution clue, not an independent latency estimate or a forecast of realizable savings. The trace has instrumentation overhead and must not be compared numerically with the ordinary import as a treatment pair.

## The clocks describe nested work

The ordinary file-input-to-UI measurement is 1053.4 ms. Its term fast path is 820 ms, import-data-banks is 849 ms, and bulk finalization is 150 ms. The 120.0 ms metadata publication measurement is inside term sink work. Its 64.4 ms index publication measurement includes the 38.5 ms recent-source-cache work. Adding these four figures would count work repeatedly.

`dictionary-database.js:8532–8575` times resolved-plan publication, in-flight source registration, and metadata publication together. `_publishArtifactTermContentMetadata` calls the cache at line 10065 before ending its index-publication clock at line 10073. The cache and index clocks are therefore not separate savings opportunities.

## Closing the record store is predominantly the existing durability flush

The ordinary finalization receipt records:

| Measurement                  |                      Value |
| ---------------------------- | -------------------------: |
| Record end-import            |                   144.8 ms |
| Pending descriptor flush     |                     8.7 ms |
| Queued descriptor wait       |                     1.0 ms |
| Record close                 |                   135.0 ms |
| Descriptor writes            |          1 write, 45 bytes |
| Index writes                 | 5 writes, 23,748,912 bytes |
| Index write await            |                     0.1 ms |
| Dedicated index-worker files |                          0 |
| Content end-import           |                     5.7 ms |
| Commit                       |                     1.1 ms |

The expanded trace attribution puts 116.736 sampled milliseconds at `term-record-import-index-writer.js:204`, the local sync access handle's `flush()` inside `_finish`. Its dominant late cluster spans 1139.361–1258.315 ms of the instrumented import. This reproduces the cause reported in [#868](https://github.com/ManabiIO/manabitan/pull/868): the long descriptor-close envelope is delayed by synchronous index durability work on the same thread. It is not evidence that writing a 45-byte descriptor is intrinsically a 135 ms operation.

Current source already starts the content and record end-import tasks concurrently (`dictionary-database.js:1543–1596`). `_closeAllWritables` concurrently starts the descriptor finalizer and sidecar finalizer for each state (`term-record-opfs-store.js:6524`). JMdict has one relevant descriptor/sidecar state, so parallelizing the outer state loop has no active opportunity. The final sidecar header is written before closing at lines 6289–6355, preserving durable publication ordering.

The current dedicated index-writer worker threshold is 1 GiB of selected source (`term-record-opfs-store.js:6431` and surrounding selection). JMdict's decoded source is 171,617,523 bytes and correctly uses the local writer. Broadening worker admission repeats the earlier rejected JMdict direction documented in [#821](https://github.com/ManabiIO/manabitan/pull/821), and changes an expressly excluded policy. Removing, deferring, or weakening the final flush changes durability. Starting final closure earlier changes lifecycle scheduling rather than eliminating this work, and the remaining non-term bank tail here is only about 29 ms.

There is a second await of an already settled write queue in the descriptor finalizer, plus a possible zero-offset seek during initial descriptor creation. Neither has measured material own cost. They do not justify another full browser experiment.

## Metadata publication has active passes, but no uncovered mechanism

The trace sampled these functions:

| Function                                           | Sampled self time | Assessment                                                                                                                              |
| -------------------------------------------------- | ----------------: | --------------------------------------------------------------------------------------------------------------------------------------- |
| `_publishResolvedArtifactTermContentPlan`          |          7.667 ms | Contiguous runs already use typed-array `set`/`fill`, introduced by #759.                                                               |
| `_registerInFlightTermContentSources`              |         31.468 ms | Current-value validation and pending-write exact-byte lookup; #830 already proposes a guarded ordinary-column specialization.           |
| `_tryPublishContiguousArtifactTermContentMetadata` |         22.999 ms | Existing bulk publisher. Exact native preflight was tested and rejected in #914.                                                        |
| `_cacheRecentPublishedTermContentSources`          |         44.011 ms | Includes source-bound scans and a second contiguous-index proof; #876 and another session's cache-envelope work cover these mechanisms. |

The registration samples are concentrated in earlier groups: approximately 4.503, 9.071, 6.962, and 5.612 ms in the first four clusters. That makes cold execution relevant, but it does not establish a new optimization beyond [#830](https://github.com/ManabiIO/manabitan/pull/830). The old warm registration component result of only about 3.7 ms must not be presented as a ceiling on this new cold trace, nor may the cold trace be presented as a measured candidate gain.

The current metadata arena does not grow materially during JMdict. The only resize attribution is about 0.335 ms inclusive, 0.175 ms self, at initial allocation. Native rehash or further resize-copy work therefore has no active JMdict ceiling under the current preallocation. Existing merged #964 already removes redundant resize copies.

The ordinary receipt reports 101,143,281 recent-source cache bytes and exactly the same number of adopted bytes. All retained bytes in this run were adopted. Removing a slab copy is consequently not an active mechanism; [#824](https://github.com/ManabiIO/manabitan/pull/824) has already supplied that optimization.

The existing typed-array publisher ends in one zero fill for IDs, one offset copy, one dictionary-ID fill, and one state fill (`dictionary-database.js:9885–9888`). Removing one zero fill would be a small write-volume change with no separately demonstrated cost and would require proving all rollback/reuse state. It is not a review-worthy experiment on the present evidence.

### Why not omit all in-flight registration?

The ordinary producer waits for a group's persistence and record appends before advancing, and this JMdict run's cache adopts every retained slab. Those facts do not prove that the public async API has no concurrent pending-write consumer.

`bulkAddArtifactTermsChunk` has no exclusive per-chunk owner lock. The pending-source registry supports byte-exact duplicate and collision checks while OPFS writes are unresolved; `test/dictionary-database-content-dedup.test.js` around 2480, 2501, and 2643 explicitly verifies pending duplicate reads, different-byte collisions, and cleanup after failed publication. The registration pass also validates current source spans, persisted offsets, ordering, and duplicate identities. A previous successful validation does not establish those live values across an await. Cache adoption may decline or evict under existing limits, so this run's 100% adoption is not a general substitute for the registry.

Eliminating that operation would require a new producer-ownership/exclusivity invariant or a carefully fused validation design, not a local removal. The straightforward specialization is already #830; synchronous envelope fusion is already being studied elsewhere. No implementation was started.

## History and competing work exclusions

The relevant pull-request bodies and source were read through the repository API; other sessions' checkouts were only read.

- [#868](https://github.com/ManabiIO/manabitan/pull/868): diagnostic-only split of close work; local native index flush dominates JMdict. A descriptor-only writer was held.
- [#914](https://github.com/ManabiIO/manabitan/pull/914): native exact publication preflight copied four columns into canonical scratch and left JavaScript publication intact. All six JMdict treatment pairs were slower against both controls; reported medians were +1.471% and +1.724%. No activation defect explained the result.
- [#876](https://github.com/ManabiIO/manabitan/pull/876): reuse of the contiguous-publication proof for recent-cache construction. Whole-import evidence did not show a repeatable JMdict gain.
- Another session's commit `24cdd19d990994041e4857bfd9fe415ed24e5c98` and formatting follow-up `4b625acf3`: fuse source min/max/content-byte bounds into the already validated publication loop and pass a synchronous cache witness. This covers the most direct remaining duplicate cache scan; do not recreate it.
- [#759](https://github.com/ManabiIO/manabitan/pull/759), #837, #824, and #964: merged contiguous resolved-plan publication, bulk metadata publication, source-slab adoption, and resize-copy reductions are already in the baseline.
- [#765](https://github.com/ManabiIO/manabitan/pull/765) and [#767](https://github.com/ManabiIO/manabitan/pull/767): extensive prefetch/task-turn cohorts failed to establish repeatable import gains. Phase counters alone were misleading.
- [#874](https://github.com/ManabiIO/manabitan/pull/874): compression/record overlap; JMdict already takes the relevant existing admission, and other corpus confirmations were inconsistent.
- [#961](https://github.com/ManabiIO/manabitan/pull/961): current parser metadata allocation work, distinct from publication; do not duplicate.
- [#974](https://github.com/ManabiIO/manabitan/pull/974) shares the compiled Zstd module/dictionary, [#973](https://github.com/ManabiIO/manabitan/pull/973) disables the unused SQLite OPFS proxy, and [#975](https://github.com/ManabiIO/manabitan/pull/975) studies canonical slot hash tags. These are other sessions' active work, not new directions for this task.

## Recommended next action

Keep this finalization avenue closed unless new evidence identifies a distinct owning operation or a permitted ownership invariant. Do not launch another small source-loop experiment merely because a broad nested timer is large. Await the already frozen DS conformance/performance study and the independent whole-import studies, preserving their controls, failures, memory gates, and scope limits.

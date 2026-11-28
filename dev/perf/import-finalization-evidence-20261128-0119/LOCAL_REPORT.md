# Final record/index construction and bounded finalization overlap

## Status

A small isolated prototype overlaps descriptor preparation with sidecar finalization. It has no candidate import-latency result. Local operation-order, byte-parity, and failure tests support correctness; full lint/type/build/browser qualification remains incomplete. The initial twelve-pair JMdict AB screen and source-validation workflow are published at `73624c7252e7d044e333ba3c4d4d6e9d026bc6db`. No PR is open. Its prospective criteria are preserved in the neighboring README.md; this local report supplies no candidate browser outcome.

The product source is based solely on frozen `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`, separate from score-cache and native-checksum experiments. The worktree is `/tmp/manabitan-finalization-0119`, branch `perf/overlap-record-finalization-0119`. Initial source/test checkpoint is `880c68b61be029eceb94295a6941106111adb33b`; final test formatting is `222f3f4087cf84981ae51d1b9ea8fd1988c0dfb6` and does not change the runtime. Runtime SHA-256: `d727ae00a72ec752984633cda25929dac32d031d9c92a269232118c5669b24fb`.

## What actually happens after term parsing

There is no final whole-dictionary lookup sort, re-encoding pass, or checksum pass on this path. Native/parser lookup indexes and record fields are produced group by group. `_createLookupIndexChunk` validates, hashes, and assembles each owned envelope before it is queued. Current JMdict produces 12 envelopes, written in five batches totaling 23,748,912 bytes. The synchronous index writer writes bounded 512 KiB spans; it only copies boundary fragments into a bounded scratch buffer, rather than merging the whole sidecar again.

The descriptor contains only the 45-byte generation/content-dictionary header. It remains buffered until finalization because it is below the ordinary descriptor flush threshold. At the end, the record store currently:

1. Opens the descriptor writable, seeks, and starts its tiny queued write.
2. Waits for descriptor queued writes.
3. Starts descriptor close and lookup-sidecar finalization together for each shard.
4. Joins both and retires the index I/O worker, if one exists.

The sidecar writes its final 40-byte header, then performs the mandatory flush and close. It does not rehash payloads. The database already starts content-store and record-store finalization concurrently and waits for both before publication. Current JMdict has zero SQLite secondary-index statements and effectively zero term virtual-table synchronization time.

## Existing ordinary baseline evidence

`baseline-phases.json` retains every ordinary A observation from the two already-completed hosts in run `46101323881`: six per host, with no exclusions or replacement measurements. The extractor verifies clean frozen source identities and exact packaged hashes of all six reviewed source files. These are descriptive baseline phases, not a candidate comparison.

| Median, milliseconds                                     | Host AB | Host BA |
| -------------------------------------------------------- | ------: | ------: |
| Bulk finalization                                        |   25.50 |   22.50 |
| Time after term fast-path end until data-bank completion |   25.50 |   17.00 |
| Record-store finalization total                          |   20.05 |   18.10 |
| Descriptor preparation / pending-write flush phase       |   11.85 |    6.35 |
| Descriptor queued-write wait                             |    1.20 |    1.20 |
| Record/index close region                                |    6.85 |   10.35 |
| Content-store finalization total                         |    9.05 |    5.00 |
| SQLite commit                                            |    0.80 |    0.50 |

The descriptor preparation metric includes `createWritable`, `seek`, queue setup, and same-thread scheduling delays; it is not a standalone measurement of disk latency. Likewise, close-region promise duration is not an isolated descriptor close cost. These phases overlap other activity and do not justify adding their medians or predicting an equivalent whole-import gain.

The separate instrumented baseline trace had 134 ms bulk finalization and 118.4 ms record/index close. That larger observation is retained separately. Previous diagnostic PR #868 attributed a similar long JMdict close promise primarily to a synchronous local index flush on the same thread. A blocked descriptor-close promise must not be mistaken for independent descriptor I/O. The present prototype cannot remove that flush.

## Prototype and invariants

Only active-import `endImportSession` opts into the new ordering. For each shard, the existing `Promise.allSettled` pair now joins:

- Descriptor open/seek/pending-write flush, queued-write drain, and close.
- Unchanged sidecar pending writes, final-header replacement, mandatory flush, and close.

Shard pairs remain sequential. This keeps the existing pair-level concurrency bound and introduces no earlier parser-phase ownership, additional worker, background source registry, format change, capacity change, or altered flush policy. All other callers retain `_closeAllWritables`' previous default behavior. An inactive `endImportSession` with pending writes retains the original sequential preparation path.

The sidecar header uses logical `state.fileLength`, which was established during append; descriptor I/O does not compute or change that value. Therefore the new ordering does not change sidecar bytes. Both owners settle before success, publication, or rollback. A descriptor preparation failure still attempts to drain any queue and close an acquired writable. Independent failures are aggregated; the same sticky descriptor error observed during both flush and drain is reported once. The active-import flag and dictionary availability are changed only after a successful join.

The descriptor preparation/wait clocks now overlap sidecar finalization. `closeWritableMs` records the remaining joint-completion tail after those measured descriptor waits. It must not be interpreted as total native close I/O, or compared to the previous close phase as an independent speed claim. This counter interpretation is documented in the product source.

The principal performance tradeoff is multi-shard scheduling: previously the global descriptor flush could start writes for several shards before closing any sidecar. The bounded per-shard join can delay opening later descriptors until the previous sidecar completes. JMdict's one-descriptor path avoids that tradeoff; other corpora still require complete-import measurement.

## Prior-art coverage

- [#629, merged](https://github.com/ManabiIO/manabitan/pull/629) already moved fresh sidecar writes to a bounded local OPFS sync handle with final flush-before-close.
- [#844, merged](https://github.com/ManabiIO/manabitan/pull/844) already removed idle time from the writer's active-work yield budget.
- [#883, merged](https://github.com/ManabiIO/manabitan/pull/883) already replaced timer yields with a reusable message channel.
- [#813, closed](https://github.com/ManabiIO/manabitan/pull/813) studied adaptive checkpoints. JMdict stayed below its size gate and had no qualified speed gain. Checkpoint scheduling is not changed here.
- [#821, merged](https://github.com/ManabiIO/manabitan/pull/821) introduced the source-size-gated index I/O worker. Its broad-worker prototype regressed JMdict. The present change does not alter worker eligibility or add a worker.
- [#868, diagnostic only](https://github.com/ManabiIO/manabitan/pull/868) separated descriptor promises from synchronous flush and envelope costs. Its descriptor-only writer proposal was held; its clocks were not merged.
- [#877, open](https://github.com/ManabiIO/manabitan/pull/877) moves owned lookup envelopes to the I/O worker. This prototype does not move envelope computation or touch that worker protocol.

Scoped GitHub REST searches and current source review did not identify an existing proposal that removes precisely the descriptor-preparation barrier inside finalization. This is not an exhaustive claim about every historical branch. No implicit Git fetch or promisor history traversal was used.

## Validation and retained failures

- Initial six new operation-order/byte tests passed on the initial prototype.
- The nine-file persistence run completed 341 passing tests and one failed new test. All eight existing suites (333 tests) passed on the current runtime. The new failure expected a synchronous sidecar handle outside an active import, while production correctly selected the asynchronous fallback. Its log and exact test source are retained.
- The corrected full nine-file rerun was killed with exit 137 before results. It is not reported as a pass.
- The corrected isolated new suite passed all nine cases. It covers blocked descriptor opening, active-session completion gating, exact descriptor/index bytes against the prior sequential order, reload lookup results, inactive-session behavior, descriptor open/write failure, peer flush failure while the descriptor owner is blocked, independent error aggregation, sticky-error identity, rollback, and sequential shard pairs. The new test double does not itself execute SQLite publication; existing publication/recovery suites and source review cover that outer boundary.
- Official test ESLint attempts at 512 MiB and then a new-file-only 256 MiB heap were both killed with exit 137 before diagnostics. Official lint remains incomplete. A separately labeled style/JSDoc-only precheck identified and corrected mechanical test formatting/documentation issues; it is not the repository lint gate.
- Main/test types, full unit suite, dry build, browser persistence/restart, and cross-corpus performance/memory gates have not been completed on this candidate.
- Independent review found no correctness blocker and explicitly retained the multi-shard scheduling and counter-interpretation caveats. See `finalization-independent-review.json` inside the compact evidence archive.

Node 22.22.0 in this executor exposes neither `navigator.storage.getDirectory` nor the FileSystem handle interfaces. The storage doubles are deterministic behavioral tests. No fake OPFS timings, ordinary filesystem timing substitute, or mock-delay speedup is reported.

## Reproduction

The read-only phase extractor is included as `extract-finalization-evidence.py` in the compact evidence archive:

```sh
python3 builds/research-0119/extract-finalization-evidence.py \
  --evidence-root builds/research-0119 \
  --source-root /tmp/manabitan-baseline-0119 \
  --output builds/research-0119/finalization/baseline-phases.json
```

All local commands, logs, source snapshots, and result/source hashes are retained in the compact archive's `local/` subdirectory. A whole-import screen is warranted only as an experiment to establish whether the small scheduling opportunity survives real OPFS behavior and cross-corpus controls; these observations do not justify a PR by themselves.

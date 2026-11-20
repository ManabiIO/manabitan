# JMdict import optimization: second pass

Date: November 20, 2026.

This pass adds checked bulk metadata publication, bounded coalescing of compression descriptors, and native checksum verification during persisted-block reads. The defensible quantified results are **26–33 ms saved in the isolated publication method** and **98.905% less offset/length metadata copied for compression jobs**. All compared term rows and persisted component artifacts remain identical. The combined worker cohorts are too variable to establish an import latency or CPU percentage.

This extends the [first experiment report](jmdict-import-experiments-20261119.md). Both arms of the final worker and production-reader comparisons include the first pass's changes and the same upstream revision, so those measurements isolate this pass. The draft PR still needs real-browser performance qualification.

## Source and data pins

| Role                                              | Local qualification commit                 | Equivalent published commit                |
| ------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| Control: first-pass changes plus upstream         | `99787e4c8bcaea1f508b18326e3f1d74cfc094b3` | `892c0c21ae5dfa819044e6be0fecf02d943b4587` |
| Candidate: the three additional changes and tools | `d8d18d9a7a9b56e8d05be851b5ae0c769a36a384` | `761b3e83f8d15008f4e4f08f7ad2cf35b2f34171` |
| Shared upstream                                   | `d733d0efe53398bfc2b45985aa709ade54f5710a` | Same commit                                |

Each published/local pair has an identical Git tree. The candidate tree is `b2b901c027df511049de2475119258fceff7209f`; the control tree is `d46e3b9f7295a33913d81effb93485e7cdfbc1ef`. Documentation and the evidence archive are added after qualification without changing these product files.

The pinned JMdict ZIP contains **526,942 rows**, is **15,587,032 bytes**, and has SHA-256 `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a`. All timed worker runs use Node **22.22.0**, navigator hints of **4 CPUs / 8 GiB**, the production 12-group plan, three parser workers, and four compression workers. These are policy hints, not a claim about a physical target device.

## Retained changes

### 1. Publish contiguous content metadata in bulk

The database recognizes consecutive reserved IDs with a uniform dictionary name. It validates the entire range, reservation states, hashes, lengths, offsets, table bounds, and byte-range aliasing before changing any table. It then fills or copies four typed-array ranges and updates counters once.

The original scalar loop remains the fallback for unsupported or invalid ranges, preserving partial-publication and error-order behavior. Disjoint views within the same native arena remain eligible; overlapping inputs or writable metadata ranges do not. Cache publication and rollback ownership remain at their existing points.

The replay captured **12 groups and 360,859 metadata publications**, before the later upstream merge, using control source `a4be72046…`. Each orientation used 12 balanced four-arm blocks: A/C executed the scalar path and B/D the bulk path. Cache work and metric updates were disabled equally. Exact table, counter, projection, and return-value comparisons occurred outside timing.

| Publication method replay |   Forward | Reversed order |
| ------------------------- | --------: | -------------: |
| Scalar A median           | 37.285 ms |      30.425 ms |
| Bulk B median             |  4.553 ms |       4.044 ms |
| Paired B/A time change    |   −86.67% |        −86.90% |
| Same-code C/A change      |    +1.96% |         +1.81% |
| Faster candidate blocks   |     12/12 |          12/12 |

The duplicate candidate D also beat A in every block of both orientations. The approximately **26–33 ms** difference is a publication-method result, with cache work excluded. It is not a complete import result. This preserved replay uses the sequential v4 component runner; the final worker study below uses v5.

### 2. Coalesce adjacent compression descriptors

The existing block-planning pass also combines adjacent source spans within each original block. Original row indexes and block boundaries remain the source of persisted references and fallback packing. Only compression dispatch receives the compact run plan.

Eligibility requires owned metadata columns and the original full per-span validation. The number of retained runs cannot exceed one quarter of the original span count or 4,096, whichever is smaller. Offset/length staging is capped at **32 KiB per plan**. Fragmented input abandons the optional plan and finishes the original planning path.

| Work across the 102 captured JMdict compression jobs    |     Original |    Coalesced |
| ------------------------------------------------------- | -----------: | -----------: |
| Span descriptors                                        |      360,859 |        3,950 |
| Offset/length columns copied into shared job metadata   |  2,886,872 B |     31,600 B |
| Preparation-loop descriptor visits, derived from source |      364,707 |        7,798 |
| Contiguous gather runs                                  |        3,950 |        3,950 |
| Source bytes copied                                     | 99,878,881 B | 99,878,881 B |
| Private bytes shifted by aligned gathering              | 76,465,125 B | 76,465,125 B |
| Compressed output                                       | 12,265,565 B | 12,265,565 B |

The two transport columns shrink by **2,855,272 bytes, or 98.9054%**. This is cumulative metadata allocation/copy volume, not peak process memory. The separate bounded staging allocation still exists.

The descriptor-visit count is derived as `spans + runs − jobs`: the existing preparation loop validates the first descriptor of each later run once before breaking and again on its next outer iteration. Coalescing removes **356,909** such visits. The original main-thread validation and the new planner bookkeeping remain, so this does not establish net elapsed time by itself.

All 102 frame hashes and per-job copy identities match. The preparation function is byte-identical between the captures and final source. Coalescing does **not** remove padded gathering or the private byte shifts. Its instrumented diagnostic timings are excluded from performance claims.

### 3. Verify block checksums in the native decode buffer

The reader copies the stored envelope and compressed payload into the decoder's existing private WASM input allocation. The existing native envelope routine computes the payload checksum there; JavaScript compares both checksum words before frame inspection and decompression. This removes a separate JavaScript traversal of the compressed payload.

Stored bytes, compression dictionaries, generation fences, decoded-size limits, owned output, and checksum diagnostics remain unchanged. Initialization and allocation failures still use the JavaScript checksum path first, preserving corruption-error precedence. This change adds no WASM binary or stored-format change relative to the shared upstream revision.

This path benefits persisted-block reads, including import-time cache misses. The primary 8 GiB worker run satisfies all **4,010** cross-chunk matches from recent-source caches, so its import timer does not exercise the new persisted reader. Reopened-row verification does exercise it outside timing. The separate 4 GiB sequential component check retains **2,871** recent-source matches and **836** matches requiring persisted content.

The final production reader was measured through its unmodified public `TermContentBlockStore.readDetailed` API. Every observation read a retained **28-block / 100,671,677-byte** corpus with zero decoded-cache budget. The common in-memory adapter returned owned bytes; exactly 56 reference/payload reads verified cache misses. Full decoded-byte and input-ownership comparisons followed every observation.

This corpus uses historical **4 MiB** blocks, rather than the current **1 MiB** import distribution. Explicit GC, initialization, and correctness checks were outside timing. Each orientation contained eight excluded warmups and 48 timed observations.

| Production reader paired wall-time change | Forward | Reverse |
| ----------------------------------------- | ------: | ------: |
| Candidate B/A                             | −19.40% | −15.54% |
| Duplicate candidate D/A                   | −22.68% | −17.39% |
| Same-code baseline C/A                    | −24.05% |  +0.93% |
| Same-code candidate D/B                   | +10.52% |  −2.03% |

The reverse candidate medians were 85.62 / 85.14 ms versus baseline A's 100.52 ms; both candidate comparisons won 10/12 blocks. The forward controls varied enough to invalidate a replicated latency percentage. All **96 timed observations, 16 warmups, and 44 corruption/generation checks** passed. Both complete cohorts are retained; no observations were removed or repeated.

An earlier diagnostic implementation of the checksum mechanism showed approximately 11–16% improvement in its two controlled screens. Those results remain historical mechanism evidence and do not substitute for timing the final production integration.

## Combined production-worker study: inconclusive timing

The v5 runner executes the actual parser and compression worker entry modules through Node worker threads. It preserves transferable buffers, shared buffers, source-consumed acknowledgements, the production source planner, ordered database sinks, and storage finalization. It uses a filesystem test adapter. Browser scheduling, real OPFS costs, SQLite, journal/media work, backend adoption, and visible UI readiness are outside this boundary. Worker startup and initialization can cross the timed boundary.

A/C use identical control source; B/D use identical candidate source. Each orientation consists of one excluded warmup per arm and 12 balanced Williams-order blocks. Every observation runs in a fresh Node process. There are **96 timed observations and eight warmups** in total, with no retries, trimming, extensions, or control subtraction.

All 104 reports passed the pinned row count and complete canonical artifact hash. Every observation executed three parser workers, four compression workers, 102 successful compression jobs and source-consumed acknowledgements, 99,878,881 input bytes, and 12,265,565 output bytes. Separate full-row comparisons qualified both source revisions before timing.

Negative percentages mean less measured time. These are paired medians:

| Comparison              | Forward wall | Reverse wall | Forward CPU | Reverse CPU |
| ----------------------- | -----------: | -----------: | ----------: | ----------: |
| Candidate B/A           |      −39.79% |      −20.67% |     −19.83% |     −19.09% |
| Duplicate candidate D/A |      −19.52% |   **+3.42%** |      −9.79% |     −11.58% |
| Same-code baseline C/A  |      −18.56% |       −1.85% |      +2.89% |      −7.54% |
| Same-code candidate D/B |  **+37.83%** |      −11.91% | **+18.04%** |      −7.15% |

These controls do not support a stable combined wall-time or CPU-savings headline. Reverse D/A wins only 5/12 pairs despite a 30.72% reduction in its equal-work aggregate; long baseline observations dominate that aggregate. CPU point estimates favor the candidate, but the same-code CPU drift is substantial. RSS also has no repeatable reduction and includes post-timer artifact hashing.

An independent verifier reconciled 329 evidence files, all schedules and raw reports, report hashes, successful exit receipts, source/runtime identities, normalized artifact manifests, and every reported statistic. It also checked 770 live input files against their recorded hashes.

## Correctness and build qualification

| Fixture / component policy                |    Rows | Reopened source-row comparison | Complete artifact parity |
| ----------------------------------------- | ------: | ------------------------------ | ------------------------ |
| JMdict, production workers, 8 GiB hint    | 526,942 | Passed                         | Passed                   |
| JMnedict, production workers, 8 GiB hint  | 667,942 | Passed                         | Passed                   |
| Jitendex, sequential components           | 435,448 | Not claimed                    | Passed                   |
| JMdict, sequential components, 4 GiB hint | 526,942 | Passed                         | Passed                   |

JMdict's full source-row semantic hash is `8926122e434123d9823d867845ed8480734e0ada8381204e1857f88b216d8974`. Its 12-group canonical stored-artifact hash is `2f559a8b0d90ed063d01b9650aee46cbbe52f469bc2ffd6ebbd74dd265e3e34c`.

Canonicalization masks only paired 16-byte random generation fields after validating format magic, framing, metadata length, and generation agreement. All other stored bytes and file names must match. The archive retains full per-file manifests and separate hashes for the other policies.

Jitendex's raw-source oracle previously failed on pristine baseline media normalization, so its result is artifact parity only. The 4 GiB case checks the memory-hint policy in sequential components with eight groups. Production rejects the full JMdict parallel path under that memory hint; this run is not a replay of the complete browser low-memory fallback.

- Full unit suite: **13,908 assertions passed, 47 skipped, across all 624 expected files**. Four sequential shards were reconciled against the complete inventory, with no missing or duplicate files.
- All four TypeScript projects passed. The initial test check exposed an untyped filesystem fixture and two mock signatures; these were fixed and the failed logs retained. A final lint-only `@yields` documentation addition is identified separately in its receipt.
- ESLint passed for the changed maintained JavaScript. Focused validation included 31 new publication cases plus 133 existing deduplication cases, 196 reader-related cases, 100 coalescing-related cases, and 73 tests after the fixture typing fix.
- All-target build dry run and Chrome release builds passed. Four packaged JavaScript files and one source map changed versus the new control; all five WASM entries are byte-identical. The Chrome ZIP grows by 2,913 bytes; measured stored artifacts do not grow.

The early parser-lease release experiment was explicitly reverted. Cache budgets, worker counts, compression settings, and persisted formats were not changed by this pass.

## Rejected alternatives

| Experiment                                    | Evidence and decision                                                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release parser slabs after source consumption | Existing controlled browser evidence did not establish an import gain; removed.                                                                                 |
| Uint32 recent-source cache copies             | Live-source arms were approximately 1.6–2.6% slower; not retained.                                                                                              |
| Fresh-allocation copy constructor             | Apparent savings came with large allocation/GC variation and inconsistent duplicate arms; not retained.                                                         |
| Prepared Zstd dictionary                      | Approximately +5.66% / +1.22% slower in the two native screens, 47,680 extra retained bytes, changed frames, only 3,415 fewer compressed bytes; not integrated. |
| Copied native compression context             | Approximately +0.59% / 0.00% changes, identical frames, 549,912 extra retained bytes; not integrated.                                                           |
| Lookup-copy constructor change                | Approximately 0.81% wall / 0.51% CPU in the parser screen, without convincing control separation; not retained.                                                 |

[Historical browser run 44596950167](https://github.com/ManabiIO/manabitan/actions/runs/44596950167) tested early source release on an older baseline. Across 12 JMdict pairs it was 0.923% faster by paired median, won 7/12 pairs, and was 0.228% slower by equal-work total. Same-code comparisons varied by −3.589% and +1.383%. All candidate runs released all 12 slabs, so the mechanism executed, but its timing did not separate from variation. Jitendex adopted no slabs and cannot support this mechanism. The historical subset retains all 56 timed reports and their summaries; their correctness evidence is source-derived probes and restart checks, not a full persisted-byte oracle.

## Reproduction and retained evidence

[Evidence archive](results/jmdict-20261120-evidence.zip): **4,163,341 bytes**, 720 payload files plus the manifest. SHA-256: `86a8369aae15dbdb38f0fc16d77990348e098d8290a5c7e964ecb6a7837c9a57`.

The archive includes checked manifests, exact scripts, raw observations and controls, validation failures and successful receipts, source snapshots, and a small Git bundle containing the local candidate and rejected experiment history. Published/local commit mappings preserve exact tree equality. Dictionary ZIPs, the decoded reader corpus, upstream Zstd sources, and duplicate downloaded workflow ZIPs are represented by their pins and generation instructions instead of being duplicated.

After fetching the PR, create control and candidate worktrees at the published commits above, install the pinned dependencies, and run `dev/bin/build-libs.js` with Node 22 in each. First run the candidate harness once for each source with exhaustive verification enabled:

```sh
/path/to/node22 dev/perf/jmdict-component-benchmark.js \
  --source /checkouts/control \
  --fixture /fixtures/JMdict.zip \
  --node-workers --hardware-concurrency 4 --device-memory 8 \
  --output /results/control-oracle.json
```

Repeat for `/checkouts/candidate` with a new output path, and require the same full-row semantic and canonical stored-artifact hashes. Then run the fixed cohort from the candidate checkout:

```sh
python3 dev/perf/jmdict-worker-study.py \
  --node /path/to/node22 \
  --baseline /checkouts/control --candidate /checkouts/candidate \
  --fixture /fixtures/JMdict.zip \
  --output /results/worker-forward --blocks 12 --order forward \
  --device-memory 8 --hardware-concurrency 4 \
  --expected-canonical-sha256 2f559a8b0d90ed063d01b9650aee46cbbe52f469bc2ffd6ebbd74dd265e3e34c
```

Use a new directory and `--order reverse` for the second orientation. The driver rejects inherited Node instrumentation, source/input changes, failed jobs, changed executed work, wrong row counts, and artifact mismatches. Timed runs skip the expensive source-JSON comparison but retain complete artifact checks outside the timer. Existing output files are never overwritten.

The publication manifest supplies its exact replay arguments. The reader-production directory supplies the public-reader script and launch receipts. `integration/verify-worker-study.py` audits the retained worker reports; `integration/coalescing-structure/compare.py` derives the descriptor counts from the preserved captures. `manifest.json` hashes every archive payload.

One exploratory phase-v3 diagnostic lacks its historical harness and transport snapshots (`de9b27ef…` and `81dfdc6c…`). Its exact preload and journals survive, but byte-exact replay is incomplete; its phase breakdown is not qualification evidence. The later coalescing harness was recovered by reversing four help/formatting edits and requiring its recorded SHA-256 to match.

## Remaining browser gate

No final-candidate browser A/B was run. Local Chromium is blocked by executor socket restrictions, and automatic approval review rejected unrestricted Chromium execution. The existing manual GitHub benchmark workflow could not be dispatched through the available connector; its browser page was signed out. No replacement workflow or execution bypass was created.

Keep the PR as a draft pending the existing real-browser benchmark. The evidence here supports the publication-method saving, reduced metadata work, and preserved dictionary contents. It does not establish browser import latency, mobile peak memory, real OPFS cost, or visible-ready time.

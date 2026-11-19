# Coalesced compression dispatch review

Candidate: `8af2ed9d7bd6eb51b4cacd89e684c3a3904c539a` on `perf/jmdict-coalesced-compression-dispatch-20261119`.

Tree: `7a25365501a7177c044f9910a6d412462dcd17f2`.

Base: `d829f5b6e6a75ee8859d38d537d224ec33c4930e`.

Worktree: `/workspace/scratch/cb98f2e06b71/manabitan-dispatch`.

## Change

Shared-span compression registers the same independent jobs, then sends one ordered envelope to each worker with that worker's existing `blockIndex % workerCount` assignment. The receiver invokes the existing asynchronous compression handler for each job in envelope order. Shared initialization promises preserve that order; once initialization completes, preparation, source acknowledgment, compression, and output posting remain synchronous within each job. The private Zstd prepared buffers cannot overlap between jobs.

Each block keeps its ID, 60-second timer, source-consumed response, completion response, compressed bytes, and error. A synchronous envelope-post failure rejects only the unsent jobs in that envelope. Existing aggregate drains still wait for jobs on other workers before rejecting either source or completion barrier. Pool-level errors, message errors, timeouts and closure still terminate the workers before settling their pending source leases.

There is no change to block planning, compression settings, worker count, per-worker block order, metadata snapshotting, or experiment options. Packed-content dispatch remains individual. Parser and canonical WASM files are unchanged.

## Motivation and scope of evidence

The independent browser trace review attributed approximately 27–28 ms of sampled importer self time to the native `postMessage` call in both baseline traces. This is a concrete diagnostic target, not a measured saving or message-count instrument.

An untimed replay of every frozen real JMdict native snapshot, followed by the unchanged production block planner, reconstructs 102 block requests across the 12 parser groups. The same assignment needs 48 nonempty worker envelopes. The 1 MiB production block target and all 99,878,881 pending content bytes are unchanged. Each complete native state/output hash was checked before using the pending columns. See `compression-dispatch-shape.json` for the exact counts and identities.

Only the real-browser cohort can establish a performance improvement. No local timing screen was run or claimed for this candidate.

## Validation

- 64 tests passed across seven focused suites: pool, pool draining, block planning, new dispatch batching, new actual worker receiver, prepared-buffer lifetime, and single-block rejection.
- The tests cover exact worker assignment and IDs, metadata/options snapshots after caller mutation, individual timers, out-of-order replies, partial envelope-post failure, malformed results, per-job errors, Worker error/messageerror, pool closure, and both source/completion barriers.
- Receiver tests exercise already-resolved, pending, and rejected initialization; ordered preparation/finish; a malformed middle job; post-ack compression failure; and legacy individual packed/span requests.
- The actual Zstd frame comparison now includes four blocks across two workers, exercising multiple blocks per envelope and exact output-byte parity.
- Main and test TypeScript each passed during staged validation; main ran before the final event-data annotation, and test types ran before the test-only lint fixes. Every changed JavaScript file passed ESLint in a separate process capped at 1.5 GiB. All-target dry-run packaging and `git diff --check` passed. `dispatch-validation-chronology.md` identifies the distributed successful receipts and the retained nonzero aggregate exits; there is no separate all-green final type/lint receipt.
- Packaging initially rejected an `ext/lib` symlink. Only that worktree's symlink was replaced with a private generated directory; the repeat package check passed. The initial receipt is retained. No remote writes were performed by this agent.

Focused logs: `dispatch-focused-final.log`, `dispatch-test-types-final.log`, and `dispatch-final-gates.log`. Main type result is in `dispatch-types.log`. Final package success is in `dispatch-package-final.log` with exit code zero. Earlier failed type/lint/package attempts are retained alongside the successful receipts.

## Frozen source identities

| File                                                        | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `ext/js/dictionary/zstd-term-content.js`                    | `25e44f16b782515c0f78da44b5b245d8d4ebf61c93681ed7afb8c7eca5a3fafb` |
| `ext/js/dictionary/zstd-term-content-compression-worker.js` | `8cf6a50160035bb6e9238c127b51927909d1c38fd4dd47e33e11effe0733d9f1` |
| Unchanged parser WASM                                       | `f1c029745da0eec890baf951249647fa7e0ce23fb3b1b83c51f34313f08f5fd5` |

The commit contains two source files and five focused test files. Independent read-only source/protocol review found no blocker. The candidate remains separate from the cache, SIMD, canonical-counter, record-field, and metadata-publication experiments.

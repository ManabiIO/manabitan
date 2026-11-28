# Shared-span FIFO follow-up: source-only implementation plan

Status: design only. No product source, test, workflow, settings, or performance cohort was changed for this plan. Implementation is blocked on the complete, prospectively registered hosted2 component advance gate. A passing component would authorize a separately source-bound implementation and qualification; it would not establish a whole-import gain.

## Exact source and cohort bindings

| Item | Binding |
| --- | --- |
| Frozen runtime | 5048ba3e8a65fc41b9ae898c47b54d5731cd759e |
| Clean held draft | PR #977, head 4702e9e9d73dda0d0f6ea83dce399a249ebb13a6 |
| Pool source | ext/js/dictionary/zstd-term-content.js |
| Pool Git blob | 1310d598e4e230eed12c415eb4fbf9be60c8c5a4 |
| Pool SHA-256 | 4454ba014404a67a4e8c833538792131f18e5c27dd619678f98749a9191384d8 |
| Worker source, unchanged by proposed follow-up | ext/js/dictionary/zstd-term-content-compression-worker.js |
| Worker Git blob | 186bc38d0875b4fe0ae00d457d0ffcd6b4f90567 |
| Worker SHA-256 | 125b11437922f28cb09f9b9d7a8e209d68296153d82e41a766b8ef8f251f8247 |
| Active hosted2 source | 81d35bc83af349b611f9ad51cc223de788a2d0d6 |
| Active hosted2 run / job | 46113052837 / 140880647245 |
| Hosted2 plan blob | 08be9235d7b2b402e5548d36f44143f68ea40226 |
| Hosted2 plan SHA-256 | 164b283162ba8e73fada533ea8733279582bbb0e5b17bbc56985773479c6951f |
| Hosted2 component blob | 603d80ee9ab75ba31725024634c1c9222aa0ddff |
| Hosted2 component SHA-256 | d807572f19125d79121be2bb4d355e5fe108cc6fbc2048b533d9ab8445ef1407 |
| Exact gate evaluator blob | 30618c45d3bd4fce17b9a9ecba27ca88a61cfa71 |
| Current runtime full qualification | Run 46108795917, still a separate source-bound cohort |

The clean draft's ext tree (498442aef1fa20e49c414b930c23e38a29749ce4), test tree (d4e90453af7af534f5a8029179e633015e1cbfff), and ESLint configuration match 5048. Normal PR CI does not replace the fixed runtime performance cohort.

Hosted1 source 587d684fa2cd356bb150fe48d167f7e36f309aa5 / run 46111938461 remains superseded regardless of its eventual outcome: its terminal acceptance omitted a final assertion for a latched idle-worker failure. Both local exit-137 attempts, including the incomplete second attempt's partial observations, remain separate failed cohorts. They must never be pooled into hosted2.

## Gate before implementation

Use the unchanged hosted2 plan and exact evaluator. All 36 scheduled timed observations, three warmups, three source-ownership witnesses, and 42 exhaustive output-decode receipts must pass their source/plan/terminal-worker bindings. The four workers, two-group limit, 103 actual 1 MiB blocks, source spans, codec, settings, and balanced 12-round A/B/C order remain fixed.

For both B/A and B/C, the paired median saving must be at least 5 ms and 5%, at least 9 of 12 pairs must be faster, equal-work sums must be strictly lower, and the 95% paired-bootstrap upper bounds must be strictly negative for milliseconds and percentages. Use the registered 20,000 shared block resamples, xorshift32 seed 0x000da6c4, and type-7 percentiles. Absolute paired-median C/A percentage drift must be less than half the smaller magnitude of the two candidate percentage savings.

A failed or incomplete gate means reject or remain inconclusive, not implement with a relaxed criterion. No new timing run or changed threshold is proposed here.

## Narrow runtime scope

The minimal follow-up should change only the pool implementation in zstd-term-content.js and focused tests. Keep the coordinator, database, parser, producer budgets, worker entry, codec, dictionaries, block planner, stored formats, and public fallback wrappers unchanged. No worker/group/block/byte knobs or extra append owner are needed.

Queue only jobs admitted by beginCompressWrappedSpans. Keep _compress and compressWrappedBlocks on their existing immediate _dispatch path and worker selection. This is FIFO among shared-span jobs. It is not a global FIFO guarantee across mixed private and shared traffic.

## Admission, ownership, and state

Add a FIFO of admitted shared-job IDs, per-physical-worker posted-job counts, and a pump reentrancy guard. Each pending entry needs queued/posted state and its assigned physical worker. A latched terminal error may be needed to return the original failure for admissions interrupted by a synchronous failure callback.

Allocate each job ID, its completion/source-consumed promises, and the existing 60-second timeout at logical admission, including time in the main-thread queue. Starting the timeout only at physical dispatch would change the existing deadline and could hide starvation.

Preserve the current synchronous snapshot boundary. Copy source offset/length columns and capture each block's scalar start/end/content-byte values before beginCompressWrappedSpans returns. Queue immutable metadata views and the already-owned shared source, not caller scratch. Do not delay block factories or introduce an await before this snapshot completes.

The shared pump posts the oldest queued shared job only to a worker whose posted-job count is zero. Initial tie-breaking should match the component's first available physical index. It can fill at most the existing four physical workers, then resume on final replies. The existing database coordinator continues to bound append owners to two; the FIFO must not advance any producer budget.

## Preserve private transfer and clone boundaries

_dispatch must continue calling postMessage with its transfer list before returning its promise. Whole private buffers therefore detach synchronously as they do now. Partial views and repeated-buffer inputs retain their immediate structured-clone snapshot behavior. compressWrappedBlocks must continue calling every factory and dispatch before its first await.

Every direct private post increments the same physical count used by the shared FIFO, before posting. A synchronous post failure reverses that count exactly once. A worker can have several already-issued private jobs; a Boolean busy flag is insufficient. Neither one private final reply nor a shared source-consumed reply may open a lane while other posted jobs remain.

Private posts may bypass or delay the shared queue because preserving their immediate transfer boundary takes precedence over strict mixed-traffic FIFO. The component's all-shared result must not be generalized to arbitrary private interleaving.

## Worker protocol and retirement

Keep the worker payload/reply protocol unchanged. The current worker sends a source-consumed message with the job ID after native gather preparation, then sends the final compressed buffer/envelope time or a job error. Source-consumed acknowledges the source lifetime boundary; it does not indicate that the compressor is idle.

Bind listeners to physical worker index and check a known job's assigned worker. A final success/error, or a synchronous post throw, retires exactly one posted job, clears its timer, and resumes the pump. Source-consumed only settles its own barrier. Late or duplicate IDs must not decrement occupancy again.

Record the actual assigned worker internally and use it for envelopeMsByWorker. Preserve public group/block output order and format. Drop the queued message reference after successful posting, and clear all queued payload references on terminal failure, to avoid unnecessary retention after source gather.

## Failure, cancellation, and draining

Preserve the existing distinction between job and pool failures:

- A postMessage throw, returned job error string, or invalid compressed payload rejects that job. Retire its lane and continue draining other admitted jobs, because the existing aggregate source/completion promises wait for every job.
- A worker error, messageerror, timeout, or close fails the pool. Latch failure before pumping, clearing, terminating, or rejecting anything.

Terminal failure must prevent later admission/pumping, clear queued payload references and timers, invoke termination for every physical worker, and reject every unresolved source/completion promise for both queued and posted jobs. Never report successful source consumption for an unposted job. Keep the aggregate drain barriers and discardCompressionPool ownership unchanged.

Admission loops can continue after a synchronous fake-worker failure callback. They must not create new queued jobs or timers after failure; return already-failed tickets or otherwise drain prior admissions before propagating. A pump guard must prevent recursive dispatch when a test worker emits synchronously.

Browser precision: Worker.terminate() provides no awaitable thread join. Preserve the existing production boundary by making every termination call before promise rejection handlers proceed. Do not claim that this adds a stronger physical-thread termination guarantee. The hosted Node component separately awaits all four Node worker terminations; that transport-specific proof must remain distinct.

## Minimal meaningful tests

1. Two shared groups with delayed and reversed final replies: at most four posted shared jobs, FIFO dispatch across the group boundary, exact public output order, and metrics using actual physical assignment.
2. Mutate caller offset/length/block-plan arrays immediately after admission, including while jobs remain queued; poison source bytes only after sourceConsumed. Verify queued work uses its captured plan and each source barrier waits for its own gather.
3. A whole private buffer detaches synchronously even while shared work is queued. Preserve partial/repeated-buffer clone behavior and the factory-before-await boundary.
4. Several private jobs already occupy one worker. A source-consumed message or first final cannot incorrectly free it; later private posts also count.
5. Close, worker failure, and timeout with both queued and posted groups: all promises settle once, all termination calls precede rejection handlers, and no later posts, timers, or queued payloads remain.
6. Individual post throws, returned errors, and invalid payloads: remaining admitted jobs drain, source ownership remains valid, and fallback/repack behavior is unchanged.
7. Duplicate, late, or wrong-worker replies, plus a failure during admission, exercise exactly-once retirement and the pump reentrancy guard.

These tests establish ownership and error semantics, not a performance gain. A new runtime must receive its own complete correctness, browser performance, and memory qualification after the component gate passes.

## Review and remaining uncertainty

This design was checked against the exact 5048 pool and worker source. import_history independently confirmed the error taxonomy, the need for posted-job counts rather than a busy bit, the logical-admission timeout boundary, and the failure/reentrancy guards. No source-level blocker was found.

Main-event-loop pumping cost, mixed-private interference, and retained-source/browser-memory behavior remain unmeasured. Read-only arithmetic on worker wall intervals is not a FIFO saving bound: those intervals include scheduling and message effects and are not CPU time. Do not use that arithmetic to weaken the fixed gate or predict an import gain.

At the last observation on 2026-11-28 06:06:58 UTC, the active hosted2 and current runtime qualification jobs were queued. PR #977 had 24 queued checks and nine intentional skips. No result or implementation authorization is implied by this plan.

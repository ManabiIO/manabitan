# JMdict index I/O mechanism diagnostic

This isolated instrumented source is based on `467067650653c37c1f7d6b05d6737d070e1259cd`. It is for a fixed six-import acquisition (`A1,B1,C1,C2,B2,A2`), with fresh browser profiles and the existing full correctness/readback/restart oracle. It is **not performance qualification** and does not change a production import policy.

## Arms and unchanged contracts

The only source/package difference between arms is the literal in `ext/js/dictionary/term-record-import-index-diagnostic-arm.js`.

| Arm | Source eligibility                            | Startup                                                                             |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| A   | Current source threshold, at least 1 GiB      | Existing lazy worker                                                                |
| B   | Source threshold bypassed for this diagnostic | Existing lazy worker                                                                |
| C   | Same as B                                     | Starts readiness at record `beginImportSession`, after journal/checkpoint ownership |

C sends no file handle and opens/truncates no file during prewarm. Its first eligible sidecar must still satisfy B's 2 MiB admission condition; prewarm alone never admits a tiny sidecar. Once ordinary admission has occurred, subsequent sidecars follow the existing session reuse rule. All arms retain 512 KiB maximum native writes, the worker's 16 MiB periodic flush budget, the local writer's close-only flush, final header rewriting and final flush, short-write handling, fallback only before unambiguous acquisition, and joining/retirement on end, rollback and reset. A failed startup remains a local fallback. A successful import must still wait for final durability acknowledgements.

## Receipt

`bulk-finalization.details.termRecordLookupIndexIoDiagnostic` contains:

```text
{
  schemaVersion: 1,
  arm: 'A' | 'B' | 'C',
  purpose: 'mechanistic-diagnostic-only',
  events: [...]
}
```

Every event has `sequence`, `realm`, `type`, `startMs`, `endMs`, and `timeOriginMs`. Realm is `record-store` or `index-worker`. Sequence is contiguous within each realm; the combined array follows receipt arrival order. Durations and ordering comparisons use a single realm's monotonic clock. `timeOriginMs` is descriptive, not evidence of sub-millisecond cross-realm synchronization.

| Type                                   | Additional fields                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session-begin`                        | `rawTermBankSourceBytes`                                                                                                                         |
| `worker-prewarm`                       | C only                                                                                                                                           |
| `worker-start`                         | Construction begins                                                                                                                              |
| `worker-startup`                       | `status`: `ready`, `failed`, or `unavailable`; interval spans creation to client readiness/failure                                               |
| `worker-ready`                         | Appears once in each participating realm                                                                                                         |
| `worker-readiness-wait`                | `fileName`, `available`; actual wait at eligible file acquisition                                                                                |
| `file-handle`                          | `fileName`, `success`; directory file-handle acquisition interval                                                                                |
| `writer-open`                          | `writerId`, `fileName`, `periodicFlush`, `status`: `opened`, `unsupported`, or `error`; access acquisition and truncation interval               |
| `batch-enqueue`                        | `batchId`, `fileName`, `byteLength`, `chunkCount`, `recordCount`, `queuedBytes`                                                                  |
| `batch-start`                          | Same batch identity/counts, without `queuedBytes`                                                                                                |
| `batch-complete`                       | Same as start plus `success`; interval spans actual batch execution                                                                              |
| `request-send`, `request-ack`          | `requestId`, `writerId`, `action`, `batchId`, `byteLength`, `chunkCount`; ack adds `success` and spans send to ack                               |
| `request-received`, `request-complete` | Worker-side `requestId`, `writerId`, `action`, `batchId`; complete adds `success`                                                                |
| `request-failed`                       | Same identity/counts as send, transport failure before ack                                                                                       |
| `writer-flush`                         | `writerId`, `fileName`, `reason` (`periodic` or `final`), `success`, `periodicFlush`, `position`, `fileLength`, `writtenBytes`, `unflushedBytes` |
| `writer-close`                         | `writerId`, `fileName`, `aborted`, `success`, `position`, `fileLength`, `writtenBytes`                                                           |
| `worker-dispose`, `worker-retire`      | Retirement spans startup joining and disposal                                                                                                    |
| `session-complete`                     | Successful terminal: `success: true`, `writeCallCount`, `writeBytes`, `workerFileCount`                                                          |

Writer IDs use `local-N` or `worker-N`. Payload write requests carry their originating batch ID. Header/control requests use batch ID zero. Byte counters track successful native writes, including positional overwrites; `fileLength` is the current logical length. A final header rewrite therefore has position 40 without erasing the payload length. Flush receipts are emitted on success and failure; they do not turn a failed flush into a successful operation.

Worker events piggyback on existing ready/reply messages. The recorder retains primitive metadata only, never payloads, buffers, handles or error objects. It resets for each serialized record import session. Instrumentation has overhead; timings cannot be used as production speed claims.

## Locked JMdict structural expectations

The current ordinary profile for fixture JM528299 gives raw source 171,617,523 bytes, one sidecar, five payload batches, and 23,748,912 payload bytes. That implies a final sidecar length of 23,748,952 bytes and total successful writes of 23,748,992 bytes, including initial and final 40-byte headers. These must be checked against the acquired bytes and existing oracle, not assumed to establish correctness.

A should use one local final flush, no periodic flush, and zero worker files. B/C should use one worker periodic flush and one final flush, with one worker file. The first periodic receipt must have at least 16 MiB and less than 16 MiB plus 512 KiB successfully written since the previous flush. Final `unflushedBytes` equals total successful writes minus that first successful periodic receipt's `writtenBytes`. Every successful request must have exactly one receive, completion and acknowledgement, and every batch must have one enqueue, start and successful completion. Unexpected counts, fallback or missing terminal markers invalidate the intended diagnostic acquisition.

## Local witnesses

`term-record-import-index-diagnostic.test.js` exercises all three modes independently of the frozen selector, delayed readiness, tiny sidecars, startup failure, zero-sidecar end/rollback/reset, actual short-write counters and failed final flush reporting. Existing real-thread worker tests additionally bind the collected request/flush receipts to actual positional writes, digests, native flush counts, durable final header changes and error identities. The unchanged browser oracle remains required for the hosted acquisition.

Local validation used Node 24.22.3. The five focused writer/client/worker/diagnostic suites passed all 70 tests, and the build dry run passed. The initial full unit run passed 637 files and 14,356 tests, but was **not green**: two native suites could not discover a compiler, and six tests in two unrelated files exceeded the default five-second timeout while other large local checks ran. A targeted rerun of exactly those four files (`term-bank-crc`, `term-bank-memory-page`, `term-entry-content-hash`, and `android/enable-firefox-remote-debugging`) passed all 133 tests using the pinned compiler, a 30-second timeout and one worker. No runtime changes were needed to resolve those files.

Main/dev types passed on the initial run. Test types found a new witness-only mock signature mismatch; replacing the unnecessary write mock with a plain typed method resolved it, and sequential test/bench type checks passed. An initial concurrent lint process exited 137; the later sequential check identified only a missing return annotation on that same witness. The annotation was added, and the final sequential lint check passed. Initial failures and targeted rerun logs are retained separately; no full-suite success is inferred from the targeted reruns. The hosted run must use its independently pinned Node 22 and browser identities.

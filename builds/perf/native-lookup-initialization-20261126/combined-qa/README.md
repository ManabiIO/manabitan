# Combined local correctness receipts — November 26, 2026

The original full-unit run **failed**. All 653 discovered test files appear
exactly once across four sequential shards. Typechecks and the seven-target
dry build passed. The subsequent bounded baseline and candidate rechecks both
hit their fixed process cap without final Vitest reports, so they provide no
complete comparison and do not change the original failure status.

## Source and scope

The QA overlay combines these exact local sources:

| Component                          | Local source commit                        |
| ---------------------------------- | ------------------------------------------ |
| Native C and source-bound WASM     | `de7363b9cda818f6c6e2a64ab7d21fa0ffc48a97` |
| Final native test annotations      | `47194b5e4af3f1f7909a9f15c417d321a469de25` |
| Shared-media staging and its tests | `9d2e0398bdf88b82eaf2c4c993de25f311b6340d` |
| Baseline for bounded controls      | `0143e9596cd8f790d5e166d4ba6a2425fbc57f14` |

This composition is a local QA tree, not either individual published PR head.
The final native evidence commit's published counterpart at acquisition was
`a66ea6488e607d2eb6afca194101c56c4f136d6f`. Node 22.22.0 and the unchanged
lockfile were used. `provenance.json` and `completion-provenance.json` inside
the archive bind the overlays, test sources, dependency lock, and native
artifacts by hash. The 67,997-byte parser module remains
`354a71c2adb4692a9304a14274f2b277d819b9929a10057ad04af61d6f41bd3e`.

## Original complete-inventory unit run

Each shard used one worker with file parallelism disabled. The frozen inventory
and all four JSON reports reconcile with no missing, unexpected, or duplicate
files: **648 file results passed and five failed**.

| Shard | Files | Passed assertions | Failed assertions | Skipped assertions |   Exit |
| ----- | ----: | ----------------: | ----------------: | -----------------: | -----: |
| 1/4   |   164 |             2,204 |                11 |                 50 |      1 |
| 2/4   |   163 |             6,013 |                 0 |                  0 |      0 |
| 3/4   |   163 |             3,239 |                 0 |                  1 |      0 |
| 4/4   |   163 |             3,248 |                 0 |                 17 |      1 |
| Total |   653 |            14,704 |                11 |                 68 | Failed |

All 68 new cases passed: 25 content-container parser cases, 31 lookup output
initialization cases, and 12 shared-media staging cases. This does not turn the
full invocation into a pass.

The original failures remain in the raw reports:

- Six content-hash assertions and one direct-field-column assertion timed out
  at the unchanged 5,000 ms test limit.
- Three Android debugging-helper assertions timed out at the same limit, and
  a fourth failed because expected stderr text was absent. Its cause is not
  definitively attributed.
- CRC and memory-page suites failed compiler discovery before their four and
  17 assertions, respectively, could run.

The default reporter retains the timeout diagnostics; Vitest's JSON serializes
those timeout failures as `STACK_TRACE_ERROR`. Exact names, durations, and
messages remain in `failed-tests.json` and the original shard files.

## Typechecks and build

Both `jsconfig.json` and `test/jsconfig.typecheck.json` typechecks exited zero.
The combined dry build exited zero for Chrome, Chrome dev, Chrome Playwright,
Firefox, Firefox dev, Firefox Android, and Edge. Commands, runtime identities,
and raw logs are retained. An earlier missing-Node setup failure is also
retained independently.

## Bounded failure recheck

Exactly one baseline invocation and one combined candidate invocation were
started for the five originally failed files, with 148 planned assertions per
arm. Both used pinned Clang/LLD 21.1.8, one worker, no file parallelism, unchanged
test and hook timeouts, and a fixed 240-second outer cap with a 10-second kill
grace. No test arm was restarted and no limit was extended.

| Arm                | Exit | Elapsed seconds | Final Vitest JSON | Source stability        |
| ------------------ | ---: | --------------: | ----------------- | ----------------------- |
| Baseline           |  124 |          240.55 | Unavailable       | All 154 files unchanged |
| Combined candidate |  124 |          241.63 | Unavailable       | All 154 files unchanged |

The baseline partial log records Android 22/22 and direct-field 15/15 passing,
plus four CRC setup skips without a final diagnostic. The candidate partial log
contains no completed-file results. Neither arm completed, so there is no
complete pass count or baseline/candidate comparison.

Before either test process started, optional `/proc/pressure/cpu` metadata was
unavailable. The failed preflight, original runner, and checked continuation
marker are all retained separately. This metadata continuation preceded the
single test invocation in each arm.

## Archive integrity

[The raw archive](raw-receipts.tar.gz) contains **47 unchanged files**,
covering original shard logs/JSON and inventory, setup failure, type/build
receipts, exact recheck runners, status/exit records, source manifests,
environment snapshots, and partial logs. Its 6,242,783 raw bytes
compress to 572,341 bytes.

Archive SHA-256:
`bcf55588eb36ab9ef183fb5c1df175ac954a3f651a679d794830d8e0e2cb0c84`.

[The readable machine summary](summary.json.txt) records every archive member's
size and SHA-256. Every extracted member was compared byte-for-byte with its
frozen input, and a second deterministic serialization produced the same
archive. The gzip timestamp and filename and tar ownership/timestamps are
normalized; raw member contents retain their original bytes.

These are local correctness, type, and build receipts. They establish no
successful complete full-unit invocation, browser result, complete-import
speedup, or peak-memory improvement. Hosted CI is tracked separately.

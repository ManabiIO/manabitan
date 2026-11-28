# Current-base canonical checksum BA confirmation

This prospective study tests the existing optional native sidecar checksum
candidate on `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`, with the first treatment
pair in BA order. It uses the same three-stream XXH32 implementation, private-view
admission, combined 3,072-byte threshold, current-arena ownership and synchronous
fallback rules as the original candidate. It introduces no algorithm, guard,
threshold, worker, allocation-budget or parser-policy tuning.

The original AB cohort on `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` and its VNDB
memory-coverage failure remain unchanged. This is a separate current-base cohort,
not a replacement or a pooled estimate. The CRC no-unroll candidate is not included.

## Frozen runtime and study sources

The candidate is `dcbbab6d1bfcebede50969f6d4b23e4f09561aa3`, tree
`fc90894e914a29de988753bbe4b062bb2f617f93`. Its local construction commit
`45e51b53b860ac5491a6af8e6fedb5bed95dd3c0` has the identical complete tree; API
publication changes commit metadata only.

All changed executable files and the twelve-case regression test are byte-identical to
the previously reviewed, comments-corrected source
`ee903e032650430839468fef391b8d820196e61d`. The composition changes seven product
files plus that test. It regenerates the source manifest against the current
baseline while keeping the canonical module at SHA-256
`631a1c430f50579f2ca7227f05ee3793a508d3e5c2ab988024b1616e1f7b8896`
and the unchanged current parser module at
`5d216041823936521f8a70b721472fb8c42052d165d771a92b59ed967d8d2695`.

`registration.json` binds both runtime commits and trees, all eight changed source
paths, the exact six permitted changed package members, and all qualification
source hashes. The baseline's absent new test is recorded explicitly. `run.py`
verifies those identities and a tracked-clean study checkout before starting the
runner. The auditor binds the recorded study commit and tree to its own
tracked-clean frozen Git checkout; untracked evidence outputs are permitted.

The complete-import runner and memory/semantic helpers are copied byte-for-byte
from `55113f0d9f85faf4a867a311d1d78dd9d2e80609`. The prospective orchestration and
portable auditor adapt source identities and assert the existing runner's BA
schedule. Pair arithmetic, package and semantic receipts, memory eligibility and
failure rules remain unchanged. No product source overlay is used.

Only these packaged entries may differ, with no added or removed member:

- `js/dictionary/dictionary-database.js`
- `js/dictionary/term-content-canonical-layout.js`
- `js/dictionary/term-content-canonical-scan.js`
- `js/dictionary/term-record-opfs-store.js`
- `js/dictionary/wasm/term-content-canonical-scan-v1.c`
- `lib/term-content-canonical-scan-v1.wasm`

Complete unit, lint, type, pinned native reproduction, all-target build dry-run
and JSON-format gates must pass before the browser matrix starts. The unit suite
includes the unchanged twelve new checksum regression cases. A build dry run is
not an emitted release archive; the runner independently builds and checks both
actual packages before timing.

## Each dictionary has its own 42-observation cell

JMdict, Jitendex and VNDB use separate matrix hosts. Every cell starts from BA and
keeps the existing fixed schedule:

- Four warm-up imports, in BA then AB order, retained and excluded from paired
  estimates.
- Twelve complete treatment pairs, alternating BA and AB.
- Four interleaved identical-code pairs using the same baseline package under
  labels A and C, alternating CA and AC.
- Two separate exhaustive-media imports.
- Four separate memory acquisitions in order B1, A1, A2, B2.

Every observation uses a fresh browser profile, the pinned Chromium install,
ordinary production flags, and the actual three-parser-worker configuration.
VNDB retains the prospective 37/37 allocation-unit range. All original strict
semantic/storage/media and source/package receipt checks remain in force.

The primary metric is `totalImportMs`, measured in the browser from file-input
change through `completedAtMonotonicMs`. The automation's completion-poll clock
is a separate diagnostic and does not define this endpoint.

`termRecordWriteMs` contains the checksum work inside append/write work; it is not
an isolated checksum timer. The original record encoding, validation, finalizing
and parse/bulk-add diagnostic counters remain available for context. These
intervals can overlap and must not be added or substituted for complete elapsed
import time. Existing source/ownership review supports ordinary private-buffer
eligibility, but this study does not add an activation counter. Canonical scanner
activity alone is not a measured checksum-activation census.

Paired median, equal-work ratio, all pair ratios, faster-pair count, worst pair,
and the original descriptive bootstrap interval are reported. Controls remain
observations, not values subtracted from treatment. No host/corpus pooling,
outlier trimming, replacement observation, or partial-schedule acceptance is
permitted. Passing correctness and memory gates does not automatically establish
a worthwhile gain or authorize a PR.

## Memory and failure retention

Memory is measured after ordinary timing with the frozen four-PID parallel
acquisition inside each original before/after process-inventory bracket. The
unchanged identity/readability, complete-tree, pre/post bracket, five fully
contained scans, and maximum 250 ms coverage-gap rules apply. These are
diagnostic non-atomic samples, not a hard total-process peak-memory cap.

An ordinary failed observation stops that dictionary cell without replacement.
The matrix does not fail fast across dictionaries. Independent audit and raw
artifact upload run after failure so complete observations, partial schedules,
both actual package ZIPs, memory failures and logs remain available. An audit
failure remains a failure; a successful audit with a failed memory gate also
remains unqualified.

To verify the frozen source bindings without a benchmark, use a new evidence
directory with `run.py jmdict --verify-only --evidence PATH`. To execute one
registered cell, omit `--verify-only`. Audit its original directory with
`audit-browser.py PATH --out PATH/independent-audit.json`. Existing evidence
directories are never reused by the runner.

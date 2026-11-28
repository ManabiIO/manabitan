# Current-base CRC no-unroll browser qualification

This prospective study tests one existing candidate: disable compiler unrolling
of the eight-lane whole-bank CRC loop. The product change consists only of that
pragma, its reproducibly built parser WASM, and the generated source manifest.
It does not combine the short-gap CRC tail proposal, native sidecar checksums,
record encoding, or parser-policy changes.

The baseline is `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`, including the merged
compact-glossary/scalar-end change. The earlier Node component screen on `9e10`
selected this candidate; its timings do not qualify the current baseline or
predict a complete browser-import gain. There is no new variant or numerical
tuning in this study.

## Frozen sources

`registration.json` binds both runtime commits and trees, all three product-file
Git blob IDs and SHA-256 values, the exact two permitted changed package members,
and all qualification source hashes. `run.py` verifies those identities and a
tracked-clean study checkout before starting the original runner. The auditor
binds the recorded study commit and tree to its own tracked-clean frozen Git
checkout; untracked evidence outputs do not invalidate that check. The local construction commit is recorded
separately from the final remote runtime identity.

The complete-import runner and memory/semantic helpers are copied byte-for-byte
from `55113f0d9f85faf4a867a311d1d78dd9d2e80609`. The new portable auditor retains
their schedule, receipt, package, pair-arithmetic and memory rules. Its changes
are prospective runtime/source bindings, this study's attribution, and the
relevant diagnostic phase names. No previous cohort is altered or pooled.

Only these packaged entries may differ, with no added or removed member:

- `js/dictionary/wasm/term-bank-parser.c`
- `lib/term-bank-parser.wasm`

Native reproduction and deterministic correctness are prerequisites. Unit,
lint, type, native-source and all-target build validation remain independent
source gates. A build dry run is not an emitted release package; the actual
packages used by the browser are built and checked separately by the runner.

## Each dictionary has its own 42-observation cell

JMdict, Jitendex and VNDB use separate matrix hosts. Every cell starts from AB
and keeps the original fixed schedule:

- Four warm-up imports, retained and excluded from paired estimates.
- Twelve complete treatment pairs, alternating AB and BA.
- Four interleaved identical-code pairs using the same baseline package under
  labels A and C.
- Two separate exhaustive-media imports.
- Four separate memory acquisitions in order A1, B1, B2, A2.

Every observation uses a fresh browser profile, the pinned Chromium install,
ordinary production flags, and the actual three-parser-worker configuration.
VNDB retains the prospective 37/37 allocation-unit range. All original strict
semantic/storage/media and source/package receipt checks remain in force.

The primary metric is `totalImportMs`, measured in the browser from file-input
change through `completedAtMonotonicMs`. The automation's completion-poll clock
is a separate diagnostic and does not define this endpoint.

`parserSourceInflateMs` includes inflation and immediate whole-bank CRC, including
the normal JMdict/Jitendex path affected by this candidate. The populated
`parserSourceCrcMs` counter instead measures deferred verification inside parsing,
as used by eligible VNDB groups. Keep these diagnostic counters separate; do not
add them or replace complete elapsed import time with worker work. The auditor
also retains the existing parse/bulk-add context. No outcome is inferred from an
isolated phase gain.

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

# Earlier native media: hosted VNDB correctness oracle

This study runs one candidate-only correctness replay of all 6,648,310 locked
VNDB rows. It compares every emitted group with the retained complete control
from develop `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The candidate product is
frozen at `037240588ec022765b6501ab2f6441ab79f16fd2`, on top of columnar product
`56be875d6635c6bcbb44d41ea9420b709cc06869`.

The study branch changes no product file beyond that frozen candidate. Its
workflow, runner, receipt checks and archived input are study-only files. The
remote study commit may differ from the local product commit; preflight verifies
the frozen runtime tree entries and actual source bytes instead of requiring an
unpublished local commit to be fetchable from GitHub.

## Configuration and scope

The replay uses the actual production source planner and actual parser workers
with an explicitly fixed `navigator.hardwareConcurrency = 2` and
`navigator.deviceMemory = 8`. It expects **170 VNDB groups**. These are controlled
oracle hints, not a statement about the hosted runner's physical CPU count or a
memory measurement.

The same two-CPU oracle configuration produced eight JMdict groups. The current
four-CPU production configuration produces twelve JMdict groups. Those group
configurations must not be conflated. The new hosted job covers VNDB only.

The original control was recorded with Node 24.22.3; this hosted replay pins Node
22.22.0, the repository's normal CI runtime. Both runtime identities remain in the
reports. This is a semantic comparison of typed values and bytes, not a timing
comparison between those runtimes.

The standard Ubuntu hosted job has a 25-minute limit and requires at least
14 GiB reported physical memory, targeting the standard 16 GB runner class.
The observed memory inventory is retained, but no peak-memory claim is made.
V8's heap limit is 2 GiB per Node process; there are two parser workers under the
recorded navigator hint.

## Identities and retained evidence

- `control-origin-vndb.json` is the original complete baseline/columnar receipt,
  byte for byte. Its baseline arm supplies the control. It retains its own
  historical interruption.
- `seed-vndb.json` preserves that exact baseline arm and the separate failed local
  early-native attempt. That candidate-only process exited 137 before its first
  ten-group progress line. No partial candidate result or semantic success is
  asserted. The attempt's command, source identity and log remain archived.
- `protocol.json` binds the archived code and receipts, runtime tree entries,
  dependency lock, pinned fixture and compiled native asset.
- `local-validation.json` retains the 436 passing focused tests, two complete
  smaller corpus comparisons, the resource-blocked ESLint attempt, and the
  independent source review. Local test expectation corrections remain reported.

VNDB ZIP SHA-256:
`da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`.
The parser WASM remains 67,659 bytes, SHA-256
`8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee`.
Normal `npm ci` and `npm run build:libs` generate the candidate's libraries.
The control is not executed again; its generated parser asset is copied from its
own verified committed native artifact solely for the runner's identity check.

## What is checked

The unchanged replay fingerprints all content, key, deduplication, prepared
lookup, score, sequence and row-count columns. Only media transport is normalized
to row/path columns, the exact diagnostic byte arena/spans/decoded-key map,
fallback rows and merged source order. Timing fields and callback-local release
functions are excluded. Native projection call/span/rejection counts and content
ownership flags must match for every group. Every private projected-media buffer
must transfer once, remain separate from the key arena, and detach after posting.

The worker bridge additionally records fused-parser attempts and fallbacks.
It observes the existing native export without changing its arguments or result.
No importer persistence, browser timing or complete-import speed is measured.
Performance and broader source gates belong to separate frozen studies.

## Reproduction

After preparing an exact baseline checkout, installing locked candidate
dependencies, building its normal libraries and downloading the pinned VNDB ZIP:

```sh
python builds/perf/20261128-early-native-media/receipt.py preflight \
  --baseline /absolute/baseline \
  --candidate /absolute/candidate \
  --evidence /absolute/new-output

node builds/perf/20261128-early-native-media/replay.mjs \
  /absolute/baseline /absolute/candidate \
  /absolute/candidate/builds/e2e-dictionary-cache \
  /absolute/new-output/vndb.json vndb candidate
```

Preflight refuses to replace an existing output observation. The workflow uploads
its full report, source identities, command, environment, logs and outcome on
success or failure. No selective timing rerun or new performance qualification is
part of this correctness job.

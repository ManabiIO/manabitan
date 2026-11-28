# Native adjacent-key proof: current-baseline import study

This measurement branch compares the frozen native parser change with current
develop across JMdict, Jitendex and VNDB. A favorable parser component screen is
a reason to measure complete imports, not a complete-import speed claim.

The [protocol](protocol.json) fixes both source commits, candidate tree, native
binary hashes, fixture lock, Node/Chromium versions, permitted release-package
differences and the timing/memory policies. The locally reviewed source commit
and its remote equivalent have identical trees.

Each corpus receives two independent hosted jobs. A/C use one immutable baseline
package in independent fresh browser profiles; B uses the candidate. Three
excluded warmups precede six balanced three-arm blocks. The second host reverses
each block. Across six cells there are 126 scheduled imports, including 108
measured observations. Full native output parity, exhaustive media, separately
sampled memory imports and later traces remain outside the timing cohort.

The driver reuses existing strict import receipts and the complete-process-tree
memory observer. It retains source identity, fixture counts, twelve lookup probes,
browser restart, 72 lookup results, media receipts and the complete OPFS inventory.
The prospective VNDB contract fixes its current baseline's 37 active SQLite SAH
allocation units and still requires exact file-size equality. Historical failed
acquisitions are not relabeled.

No first-hover timer or immediate first-lookup timer is added. Existing restart
lookup checks remain. This native parser change introduces no deferred work.
Timing uses the unchanged file-input change through post-UI completion boundary.

All six paired B/A, B/C and unchanged C/A differences are reported separately per
host and corpus. No control subtraction, cross-host pooling, tail removal,
failed-slot replacement or appended samples is performed. Correctness or memory
failures do not erase completed timing observations.

## Reproduction

The workflow runs only on pushes to
`test/import-keyproof-study-20261127-4990` whose head message includes
`[run-keyproof-study]`. Report-only updates omit that marker.

```sh
python3 dev/perf/import-keyproof-study-20261127-4990/run.py \
  --dictionary jmdict --replication 1 --evidence /absolute/new/evidence-directory
```

Use replication 2 on a separate host. Evidence directories must not exist.
Artifacts retain the plan, driver/helper sources, source/package maps, both
release ZIPs, original command logs, every import report, native output parity,
exhaustive media receipts, raw memory scans and separate browser traces.

```sh
python3 dev/perf/import-memory-20261125-a7f7/audit_memory.py \
  /absolute/evidence-directory/memory
```

## Preserved local startup failure

The [local failure directory](local-browser-failure) preserves the official
runtime artifact identity and original attempt. Chromium 153.0.8010.12 could not
create its required Unix socket in this executor and aborted before extension
loading. No local complete-import timing was acquired. No executor restriction
was disabled; that failed attempt is separate from this hosted study.

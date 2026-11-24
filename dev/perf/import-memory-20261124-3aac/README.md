# Import-window memory qualification

This tooling runs a separate diagnostic for one frozen candidate and corpus.
It does not change product source. Replication 1 acquires `A1, B1, B2, A2`;
replication 2 independently acquires `B1, A1, A2, B2` on another CI runner.
Each replication contains two adjacent A/B pairs. Both must pass. No warmup,
retry, replacement, dropped tail, or optional stopping is permitted.

The observer and raw-scan auditor are unchanged from
`f2f08c8ee74cdea548c5c1b494ec15bf10360b46`. The same test-only marker overlay
brackets file-input dispatch through observed UI import completion. The native
benchmark's internal timing labels remain in its raw files, but **all timing in
this externally observed study is non-authoritative**. Startup, semantic
readback, and browser restart remain outside the reported memory maxima.

## Fixed gates

The observer reads the full discovered Chromium process tree, including
renderer children, using Linux `smaps_rollup`. It records process identities,
unreadable address spaces, unstable scans, and the narrow previously reviewed
single-thread exited-zombie exception. Missing reads never become measured
zeroes. Qualified maxima require at least five complete scans wholly inside
the marked import window, covered brackets within 250 ms on either side,
and no covered-scan gap over 250 ms. The wait between scans remains 25 ms.

Every observation must qualify. For both PSS and private memory, the median
paired candidate increase must be at most 5%, and every individual paired
increase must be at most 10%. An invalid observation retains null maxima;
its pair and replication fail qualification. All four scheduled observations
are attempted even when an earlier acquisition or correctness check fails.
These sampled, non-atomic maxima are not exact peak memory measurements.

Source commits and trees, dependency/harness hashes, fixture sizes and hashes,
release-package hashes, and every package-entry hash are retained. Package
differences must match an explicit sorted list supplied before acquisition.
Each source arm gets a real `node_modules` directory with hardlinked files
and a copy fallback. Both dependency manifests and the setup action must match
the tooling checkout that ran `npm ci` before either dependency copy. The only
tracked edit after its clean build is the exact
test-harness marker overlay. Product packages contain no instrumentation.

Each complete import uses the unchanged native harness's deterministic media
sample, full row inventory, 72 lookup receipts, and restart checks. Lookups,
media receipts, the explicit storage identity below, and browser identity must
match across all four observations. This is sampled semantic coverage, not exhaustive
lexical readback. The separate whole-import study retains the exhaustive media
diagnostic; memory acquisition does not replace it or add its time to a cohort.

The prospective `pinned-import-storage-20261124-v1` policy in
[STORAGE-POLICY.md](STORAGE-POLICY.md) preserves exact known non-SAH paths and
sizes and exactly eight SAH files with seven empty 4,096-byte files. Jitendex
keeps exact active SQLite allocation. VNDB alone permits one active SAH file
at 129–131 aligned 4,096-byte units, based on the two baseline allocations
captured in failed run `45465463257`. Raw inventories and totals remain in
each correctness receipt; `storage-allocation-summary.json` retains every
arm's actual allocation and failed slots. This is not SQLite byte equality.
The earlier stopped cohorts and prefix memory protocol remain unchanged.

## Invocation

The `.github/workflows/import-memory-20261124-3aac.yml` push trigger is
limited to `perf/import-media-memory-20261124-3aac` and this tooling's paths. It freezes
baseline `bbccabd520972cc351a65d9f545bd5369b6e9747`, native media candidate
`fb71a03f4611bcfa71e135693bebd1fe778153bf`, their trees, four package differences,
and the VNDB/Jitendex matrix. Its four jobs implement two independent schedules
for each dictionary; both replications must pass separately for each corpus.
The optional manual trigger uses the same frozen configuration. The portable
runner also accepts these explicit CLI arguments:

```sh
python3 dev/perf/import-memory-20261124-3aac/run_memory.py \
  --baseline "$BASELINE_SHA" --candidate "$CANDIDATE_SHA" \
  --dictionary jitendex --replication 1 \
  --expected-differences "$EXPECTED_PACKAGE_DIFFERENCES" \
  --output "$FRESH_EVIDENCE_DIRECTORY"
```

Node 22.22.0, the matching installed Playwright Chromium, and the repository's
normal dependency setup are required. Baseline must be an ancestor of the
candidate. An existing evidence directory is never overwritten. Acquisition
should run on an otherwise idle CI runner; this script is not a speed test.

Run the synthetic observer/protocol witnesses without launching a browser:

```sh
python3 -m unittest discover -s dev/perf/import-memory-20261124-3aac -p 'test_*.py' -v
```

`audit_memory.py` recomputes coverage and maxima from original raw scans and
marker bytes. `verify_receipts.py` independently reopens the retained packages,
reconstructs the marker overlay, and reconciles source and correctness receipts.
Both run after acquisition. The artifact contains all packages, raw native
reports, scans, markers, commands, failures, and the exact tooling/workflow
sources needed for an offline review.

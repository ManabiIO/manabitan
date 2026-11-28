# Separate import-window memory acquisition

These helpers preserve the full-process observer and fixed memory gates from
`dev/perf/import-memory-20261124-3aac`. They do not change extension product
code, establish complete-import timing, or relax source, package, lookup,
media, or storage checks. The qualification caller owns those independent
checks and must pass all of them before reporting success.

`chromium_memory.py`, `audit_memory.py`, and the actual Linux process-tree
witnesses were originally copied without changes. `source-provenance.json`
retains that historical import record. The prospective parallel acquisition
revision below changes only how the per-PID reads are acquired;
`parallel-acquisition-provenance.json` binds its current source and tests.
`protocol.py` contains the original function bodies for the marker
overlay, fixed four-observation schedule, and paired memory comparison. The
import-window tests change only their helper import. The paired-memory test
is retained from the original protocol suite.

## Acquisition contract

Run memory acquisition separately after the complete timed cohort. Use the
already built source arms and packages. Apply `memory_overlay` only to the
test harness in both arms, record its exact bytes and hash, and restore the
original harness after all memory observations. The extension package must
remain unchanged. Each observation still uses the native benchmark with
fresh profiles, pinned fixtures, production defaults, and strict readback.

Freeze `schedule(1)` (`ABBA`) or `schedule(2)` (`BAAB`) before starting. The
opposite schedule must run on a separate host. Attempt all four observations,
retain failed observations and raw scans, and never substitute a later run
for a failed slot. A failed command or missing acquisition must remain a
failed qualification with null memory maxima.

The caller imports `run_with_sampling` from `chromium_memory` and
`memory_overlay`, `schedule`, and `memory_comparison` from `protocol`. For
each scheduled observation, call `run_with_sampling` with the ordinary native
benchmark command, source directory, fresh log path, fresh `memory.json`
path, and fresh `markers.jsonl` path. The command is the unchanged
`dev/perf/import-benchmark.js` invocation with one run, no build, Chrome, and
sampled media. The observer sets its separate marker variable; it does not
change native benchmark flags. Its raw internal timing labels must never be
used as authoritative timing under this observer.

Store the fixed schedule in `plan.json`, the merged schedule and observer
receipts in `observations.json`, and the result of
`memory_comparison(observations, dictionary, replication, schedule)` in
`memory-comparison.json`. Each observation belongs in its schedule name
directory (`A1`, `B1`, `A2`, or `B2`). After acquisition, run:

```sh
python3 dev/perf/import-memory-20261125-a7f7/audit_memory.py EVIDENCE_DIRECTORY
```

The auditor recomputes process coverage, PSS/private sums, marker bounds,
sampled maxima, and comparison results from the original raw scans. Do not
run the auditor with Python's assertion-removing optimization option.

## Fixed coverage and memory gates

The observer reads every discovered Chromium descendant's Linux
`smaps_rollup`, including renderer processes and descendants with rewritten
titles. It records PID, process start time, parentage, unreadable address
spaces, and changes during each non-atomic scan. Missing reads never become
measured zeroes. The narrow unchanged single-thread exited-zombie exception
retains the process identity and failed read without claiming a memory value.

Qualified maxima require at least five complete scans wholly inside the
marked import window, a covered bracket within 250 ms on each side, and no
covered-scan gap over 250 ms. The wait between scans remains 25 ms. Every
observation must qualify. For both PSS and private memory, the median paired
increase must be at most 5% and each individual paired increase at most 10%.
Both independent replications must pass separately. These sampled maxima
are not exact peak-memory measurements.

## Prospective bounded parallel acquisition

Each scan finishes its complete first process inventory before submitting
one `smaps_rollup` read per discovered PID to a fresh thread pool, capped at
four workers and at the discovered process count. It consumes results in the
original sorted PID order and joins every submitted task before the second
inventory. Even an unexpected exception joins pending readers before
escaping; no partial result qualifies and no reader survives into the next
scan. Both scan timestamps still bracket inventories, reads, and pool cleanup.

Process selection, identities, errors, zombie handling, window coverage,
scan waits, sampled maxima, and paired memory gates are unchanged. The
observer threads belong to the separate Python observer, not to the
benchmark's Chromium descendants. Reads remain non-atomic. Concurrent kernel
reads can change observation overhead and scheduling, so use this revision
only for a newly registered memory cohort, identically for both source arms.
Earlier failed cohorts remain failed; they are not reinterpreted or replaced.
There is no claim that this change will satisfy coverage on a particular host.

## Tests

```sh
python3 -m unittest discover \
  -s dev/perf/import-memory-20261125-a7f7 -p 'test_*.py' -v
```

The tests launch real small Linux process trees, including a renderer with a
rewritten title, an unrelated child, an unreaped zombie, and a zombie leader
with a live sibling thread. Other cases reject denied reads, missing scan
coverage, altered markers, forged maxima, incomplete schedules, and an
individual memory regression hidden by an acceptable median.

The parallel acquisition witnesses force out-of-order completion and verify
sorted results, the inventory/timestamp bracket, a maximum four-reader pool,
and complete joins on success and unexpected failure. Thirteen fixed snapshot
cases compare concurrent and serial acquisition, including permission denial,
PID reuse, process churn, metadata changes, and the narrow zombie exception.

## Complete-import semantic receipts

`qualification_receipts.py` supplies pure validation and comparison helpers
for both the ordinary cohort and the separately observed memory cohort. The
native `extractImportResult` checks still run first. The additional validator
binds its summary to the raw report and the caller's frozen identities:

```python
receipt = validate_import_summary(
    summary, raw_report,
    dictionary=dictionary,
    fixture=frozen_fixture,
    source_sha=expected_source_commit,
    package_sha256=expected_package_sha256,
    browser_version=cohort_browser_version,
    source_hashes=expected_report_provenance_hashes,
    import_flags=registered_import_flags,
    source_dirty=False,
    media_check='sample',
)
require_matching_receipts(first_sample_receipt, receipt)
```

The first valid observation may pass `browser_version=None`; freeze its
returned `browserVersion` for all later observations. Compare every warmup,
candidate, and identical-product control. Preserve the complete raw receipts.
The validator requires exactly one native run, pinned Node 22.22.0, Chrome
headless, a successful raw report without skipped verification, false tracing,
phase profiling, phase screenshots, and native process sampling, and matching
source, package, browser, flags, timing, and summary/report bindings.

The returned `common` key preserves every validation field except `media`.
It retains the content output digest, all inventory/restart fields, and all
lookup observation fields except `elapsedMs`; observations are ordered by
pass and term. Storage keeps its exact total and sorted complete file sizes.
Only valid generation-media UUID basenames and SAH opaque basenames are
normalized. Nonrandom paths remain exact. The eight-file SAH structure and
the existing VNDB 129–131 active-page bound remain checks, and even a change
within that bound fails cross-observation equality because actual sizes are
retained. No additional storage allowance is introduced.

Exhaustive media uses `media_check='all'`. Compare its common receipt to the
timed reference with `compare_media=False`, then compare the exhaustive A/B
receipts with the default `compare_media=True`. This keeps the separate
sample/full media digests while requiring identical content and storage.

For the separate memory marker overlay, pass `source_dirty=True` and an
explicit expected hash for
`test/chromium/extension-two-dictionary-import.e2e.js` in `source_hashes`.
The caller must independently verify that this exact harness overlay is the
only tracked source edit and that package bytes remain unchanged. A dirty
source without that expected overlay hash is rejected. Other expected report
provenance hashes are also checked; the caller's complete harness manifest
remains necessary because the native report exposes only a provenance subset.

`test_qualification_receipts.py` includes deliberate same-shaped digest
changes, a one-page SAH difference inside the previous allocation bound,
changed file sizes, package/source/browser mismatches, duplicate probes and
lookup pairs, missing flags, and full-media digest divergence.

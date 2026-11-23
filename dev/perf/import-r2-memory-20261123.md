# Round 2 transfer memory diagnostics

This separate research workflow runs 24 fresh-profile Chromium imports: JMdict,
Jitendex and VNDB, each in independent ABBA and BAAB jobs with four imports per
job. A is baseline `5e1f8c12f7ff798ba407323aff675cb23b22af02`; B is the frozen
transfer candidate pinned in the adjacent JSON config. Every observation remains
in the evidence, including failures. There are no retries, warmup exclusions or
timing conclusions from this diagnostic.

The production quick-import harness is unchanged apart from the same symmetric
VNDB fixture overlay used by the timing study. Its internal instrumentation stays
off. The external observer changes the workload, so its raw timing-authority
labels do not apply here. The coordinator omits elapsed-time metrics from its
derived comparisons and labels every result `authoritativeTiming: false`.

## Observer provenance and limits

`import-r2-memory-observer-20261123.py` is byte-identical to
`dev/perf/import-memory-zombies-study-20261123/chromium_memory.py` at commit
`00da5cb2ec28211dd6d09d938dc6cf1e3a4334c9`, tree
`4d03a978213da80b70dd80bf07ad2c479712346b`. Its SHA-256 is
`ca6c0f7761062761697a810d4bd0007ff0257bbce69099df45657ffdb7ee8f10`.
The corresponding upstream witness tests are copied with only their import
adapter changed to resolve this filename.

The observer discovers browser descendants, including renderers with rewritten
process titles and arbitrary descendant executables. It inventories PID,
start-time, parentage, executable, thread count and process metadata before and
after each scan. Only stable, fully read trees containing browser and renderer
processes contribute PSS/private-byte maxima. Permission errors, incomplete
stable address-space reads and persistent identity-inventory failures invalidate
the observation. The narrow zombie exemption requires the same single-thread
zombie identity before and after, an absent executable and an ESRCH memory read;
a zombie leader with live threads remains unqualified.

These are sampled maxima during startup, import, sampled persisted-content
readback and browser restart. They are not exact import peaks. Processes between
scans or reparented before discovery can be missed, individual memory reads are
not atomic, and PSS can change when external shared-mapping users change. The
100 ms interval is a wait between scans, not a guarantee of 10 Hz collection.

## Guards and reproduction

Preparation records source commits/trees, dependency and fixture locks, package
hashes and complete package-entry maps, the runtime and Chromium versions, every
study source hash, and the target archive hash. The only permitted package
differences are the parser and record-store JavaScript files. Inputs are checked
before and after imports. Each browser report must verify the pinned dictionary
title, revision, row count and twelve sampled content probes across restart; the
unmodified harness rejects a changed pre/post-restart probe digest. Cross-arm
probe digests, native work receipts and persisted byte totals must match.

A cohort-complete receipt is written only after all four successful observations
and final source verification. Analysis requires the exact schedule and receipt,
revalidates every retained browser report and observation-file hash, and
recomputes coverage and maxima from all raw observer samples. Failed or incomplete
cells produce no memory percentage comparison. Adjacent A/B pairs are reported
separately; four imports per cell remain a small diagnostic sample.

```sh
python3 test/import-r2-memory-observer-20261123.test.py
python3 test/import-r2-memory-20261123.test.py
python3 dev/perf/import-r2-memory-20261123.py validate --case transfer-vndb --replication 1
CI=true python3 dev/perf/import-r2-memory-20261123.py prepare --case transfer-vndb --replication 1 --output /tmp/r2-memory-evidence --sources /tmp/r2-memory-sources
CI=true python3 dev/perf/import-r2-memory-20261123.py run --case transfer-vndb --replication 1 --output /tmp/r2-memory-evidence
python3 dev/perf/import-r2-memory-20261123.py analyze --case transfer-vndb --replication 1 --output /tmp/r2-memory-evidence
```

Use Node 22.22.0, the dependency-lock-matched Chromium and a fresh output/source
directory. The push-only research workflow restricts its path trigger to these
memory coordinator/config/observer/test files, so report-only updates do not
start another diagnostic cohort. All setup logs, reports and failures upload
with `always()`; source files are preserved before setup begins.

Each benchmark command runs under a recorded GNU `timeout` executable with a
fixed 180-second deadline and five-second kill grace. A timeout is a retained
failed observation; it is never retried or replaced. The unchanged observer can
finish and save its raw samples when this child wrapper exits. A runner or job
hard kill can still prevent the current in-memory sample list from being saved;
such an incomplete cell has no qualified memory result.

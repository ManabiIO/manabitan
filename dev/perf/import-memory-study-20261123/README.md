# Separate Chromium process-tree memory qualification

This research workflow repairs discovery in the earlier memory sampler. The old sampler filtered each process's first command-line segment by an exact browser basename. Rewritten Chromium process titles could therefore omit renderers and their descendants. The original samples and timing campaigns remain unchanged and do not establish whole-tree memory coverage.

The frozen comparison is owned shared content, baseline `1e235059a4c05c2509e8757fccba43a2d60222df` and candidate `51f095912b11ddd158ac173698eb322e2be99d12`. Six independent hosted jobs cover JMdict, Jitendex and VNDB, with two replications per corpus. Each job performs exactly four fresh-profile diagnostic imports: ABBA in replication 1 and BAAB in replication 2. No observation is retried or replaced. There are no authoritative timing results in this study.

Both arms receive the same pinned fixture and final semantic/restart harness. Package member hashes must differ only in the two expected parser JavaScript files. Each observation retains immutable source, tree, package, fixture, harness and study-script identities. All requested terms must have nonempty complete public lookup responses without degraded availability, identical across arms and browser restart. Physical probes must remain stable within each package; only reference offsets, encoded reference previews and their independently recomputed preview count may differ across arms.

Browser seeds are found among the benchmark command's descendants using `/proc/PID/exe`; readable browser `argv[0]` is a fallback when the executable link is unavailable. Every transitive descendant of a seed is included, regardless of its title or executable name. Each scan records parent PID, process start time, executable, command line, `comm`, process role and failed metadata reads. The tree is enumerated before and after reading `smaps_rollup`.

A sample can contribute to memory results only when its process identities and metadata remain stable, every discovered process is readable, and both browser and renderer roles are observed with at least two processes. Missing reads are retained explicitly. Permission errors, other persistent read failures, unreadable processes in an otherwise stable tree, or incomplete identity inventories leave the entire run unqualified. No privilege escalation or permission changes are attempted. Transient exits invalidate the affected sample. Runs with no qualifying samples remain unqualified; maxima are then null.

PSS apportions shared mappings; private memory is recorded separately. Scans are non-atomic, with a 100 ms wait between scans. Short-lived processes between scans and processes reparented before discovery can be missed. These are maxima of qualifying samples, not complete peak measurements. The window covers browser startup, import, complete sampled semantic readback and browser restart, so it cannot isolate the import's own memory peak.

The unmodified quick harness cannot detect an external sampler. Its raw reports retain internal timer labels and elapsed durations for provenance, but those labels do not apply to this study. The outer plan, per-run identities, memory receipts and comparison all explicitly set `authoritativeTiming` to false. No elapsed-time fields enter the comparison.

Run the subprocess-only discovery witness with:

```sh
python3 dev/perf/import-memory-study-20261123/test_chromium_memory.py
```

The witness uses a small local stand-in executable and never launches Chromium. Run a hosted study job with `PERF_DICTIONARY`, `PERF_REPLICATION` and `RUNNER_TEMP` set, then execute:

```sh
python3 dev/perf/import-memory-study-20261123/run_memory.py
```

The runner writes all four observations and fails qualification after preserving them if process coverage or readback is insufficient. Results under `builds/import-memory-tree-study` are diagnostic evidence; they do not by themselves assert memory non-regression or qualify a production performance claim.

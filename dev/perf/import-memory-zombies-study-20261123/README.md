# Separate confirmed-zombie memory qualification

This is a new, independently scheduled observer correction. The earlier browser-name sampler and process-tree campaign 45114745900 at `75dc67eb4a4f67e56c7270a278c4d034b1955c6f` remain unchanged, including every failed qualification and missing read. The process-tree campaign's 24 imports passed complete sampled semantic and restart checks. Thirteen memory observations remained unqualified under its conservative missing-read rule. This campaign does not reinterpret those results.

The frozen comparison is owned shared content, baseline `1e235059a4c05c2509e8757fccba43a2d60222df` and candidate `51f095912b11ddd158ac173698eb322e2be99d12`. Six independent hosted jobs cover JMdict, Jitendex and VNDB, with two replications per corpus. Each job performs exactly four fresh-profile diagnostic imports: ABBA in replication 1 and BAAB in replication 2. No observation is retried or replaced. There are no authoritative timing results in this study.

Both arms receive the same pinned fixture and final semantic/restart harness. Package member hashes must differ only in the two expected parser JavaScript files. Each observation retains immutable source, tree, package, fixture, harness and study-script identities. All requested terms must have nonempty complete public lookup responses without degraded availability, identical across arms and browser restart. Physical probes must remain stable within each package; only reference offsets, encoded reference previews and their independently recomputed preview count may differ across arms.

Browser seeds are found among the benchmark command's descendants using `/proc/PID/exe`; readable browser `argv[0]` is a fallback when the executable link is unavailable. Every transitive descendant of a seed is included, regardless of its title or executable name. Each scan records parent PID, process start time, executable, command line, `comm`, process role and failed metadata reads. The tree is enumerated before and after reading `smaps_rollup`.

A sample can contribute to memory results only when its process identities and metadata remain stable, every nonexempt discovered address space is readable, and both live browser and renderer roles are observed with at least two readable processes. Missing reads are retained explicitly. Permission errors, other persistent read failures, nonexempt missing reads in an otherwise stable tree, or incomplete identity inventories leave the entire run unqualified. No privilege escalation or permission changes are attempted. Transient exits invalidate the affected sample. Runs with no qualifying samples remain unqualified; maxima are then null.

PSS apportions shared mappings; private memory is recorded separately. Scans are non-atomic, with a 100 ms wait between scans. Short-lived processes between scans and processes reparented before discovery can be missed. These are maxima of qualifying samples, not complete peak measurements. The window covers browser startup, import, complete sampled semantic readback and browser restart, so it cannot isolate the import's own memory peak.

The unmodified quick harness cannot detect an external sampler. Its raw reports retain internal timer labels and elapsed durations for provenance, but those labels do not apply to this study. The outer plan, per-run identities, memory receipts and comparison all explicitly set `authoritativeTiming` to false. No elapsed-time fields enter the comparison.

## Primary-source basis and frozen zombie exception

The upstream Linux [exit path at commit ce9ecca0238b140b88f43859b211c9fdfd8e5b70](https://github.com/torvalds/linux/blob/ce9ecca0238b140b88f43859b211c9fdfd8e5b70/kernel/exit.c) calls `exit_mm` before `exit_notify` assigns zombie state. The former clears the exiting task's address-space pointer and releases its reference. The same source retains a zombie thread-group leader until its sibling threads exit, so a zombie leader alone does not establish that the process has no live address space. This commit is the target of annotated upstream tag `v6.6-rc2`, tag object `b9435475cc9bfb60f0327686d1183f498f3d51c1`.

The upstream [smaps implementation at commit 5aa3b8b3e51e5b6b254c79656e79ad3eb7dc04cc](https://kernel.googlesource.com/pub/scm/linux/kernel/git/next/linux-next/+/5aa3b8b3e51e5b6b254c79656e79ad3eb7dc04cc/fs/proc/task_mmu.c) returns `ESRCH` when opening `smaps_rollup` finds no address space. [Linux proc documentation](https://www.kernel.org/doc/html/v6.11/filesystems/proc.html) identifies stat state `Z` as zombie, describes the thread-count field and warns that dead-process descriptors can fail with `ESRCH`. These are inspected upstream reference revisions, not a claim to have reproduced the hosted distribution's exact kernel build. The subprocess witness also checks the running kernel before each hosted job.

Rule `stable-single-thread-zombie-esrch-v1` is frozen before new browser data is collected. A missing read is classified as a confirmed exited zombie only when all conditions hold:

- The same integer PID and process start-time identity occur in both snapshots.
- Both stat snapshots report state `Z`.
- Both report exactly one thread. Missing, invalid or greater counts fail closed.
- Both executable links are absent with explicit `ENOENT`, rather than a permission failure or unspecified missing value.
- The attempted `smaps_rollup` read fails specifically with `ESRCH`.

Every qualifying zombie retains its failed read, metadata and second confirming snapshot in `confirmedExitedZombies`. All failed reads also remain in `unavailableProcesses`. No measured PSS value is invented for a task without a userspace address space; its kernel bookkeeping memory is outside per-process PSS. Nonexempt failures remain in `unreadableAddressSpaces` and retain every previous rejection rule. The witness explicitly rejects a zombie leader with multiple threads, unknown thread counts, identity changes and non-zombie failed reads.

Run the subprocess-only discovery witness with:

```sh
python3 dev/perf/import-memory-zombies-study-20261123/test_chromium_memory.py
```

The witness uses a small local stand-in executable and never launches Chromium. Run a hosted study job with `PERF_DICTIONARY`, `PERF_REPLICATION` and `RUNNER_TEMP` set, then execute:

```sh
python3 dev/perf/import-memory-zombies-study-20261123/run_memory.py
```

The runner writes all four observations and fails qualification after preserving them if process coverage or readback is insufficient. Results under `builds/import-memory-zombies-study` are diagnostic evidence; they do not by themselves assert memory non-regression or qualify a production performance claim.

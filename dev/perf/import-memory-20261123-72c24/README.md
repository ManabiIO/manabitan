# Import-window memory diagnosis

This is the separate memory protocol prospectively frozen in the timing study's
README before opening candidate outcomes. It compares exactly the same baseline
and candidate SHAs and package-member allowlist, with fresh browser profiles and
ABBA / BAAB independent replications for each of JMdict, Jitendex and VNDB.
Every memory observation retains exhaustive media validation after restart.

The process inventory, full descendant discovery, identity stabilization and
narrow exited-zombie rule are adapted from the already reviewed observer at
`00da5cb2ec28211dd6d09d938dc6cf1e3a4334c9`, path
`dev/perf/import-memory-zombies-study-20261123/chromium_memory.py`. Its original
live process-tree witnesses are retained. The revised observer additionally
records Linux monotonic nanoseconds and restricts maxima to complete scans inside
two test-only harness markers: immediately before file-input dispatch and after
visible import completion, before any diagnostic readback.

The memory marker overlay is generated identically for both arms, retained in
full and hashed. It does not alter packaged runtime source. Node `hrtime` and
Python `monotonic_ns` alignment is verified by a live clock witness. The ordinary
timing cohort does not receive this overlay or process observer.

Every observation requires at least five stable, fully read import scans, at most
250 ms between covered scan midpoints or a boundary, and qualified before/after
brackets within 250 ms. Live missing reads and identity failures invalidate the
observation. Partial scans and failed samples remain in the evidence; null maxima
are never replaced with zero. Readback/startup peaks cannot enter the import
maximum. The observer waits 25 ms between scans during import.

Each cell's two fixed adjacent pairs must have median sampled PSS and private
increases no greater than 5%, and no individual pair above 10%. Every observation
must qualify. The runner collects all four observations before applying these
criteria and exits unsuccessfully if coverage or the prospective screen fails.
A failed pair is not rerun, replaced or dropped. All internal timing labels in
these benchmark reports are overridden by the outer plan: **no elapsed time here
is an authoritative latency result**.

`audit_memory.py` independently rebuilds process sums, roles, identity/coverage
reasons and exited-zombie exclusions from retained records, binds original marker
bytes, and recomputes every window summary and pair. `verify-memory.mjs` checks
source/package identities, original full public responses and complete media
readback, and verifies that the marked window covers browser-reported import time.

These are non-atomic sampled maxima, not exact peaks. Processes can arise and
exit between scans, and external sharing can affect PSS. Private bytes are
reported separately. The marked automation window includes dispatch and visible
completion overhead; it excludes media verification and browser restart.

## Prospective bounded-read revision for the key-view candidate

This new candidate uses one persistent four-thread smaps pool. A global scan
lock serializes the complete before/read/after envelope, and a four-slot semaphore
bounds read concurrency even across callers. Each scan joins every future before
its after-inventory, preserving PID order rather than completion order. An
unexpected future failure is propagated only after the other reads have joined.
The benchmark and observer cannot be reported complete while reads remain live.
All previous process-tree, identity, address-space and exact exited-zombie checks
remain intact, as do the 25 ms wait, 250 ms coverage limits and 5%/10% criteria.

Previous retained VNDB scans took about 105–179 ms at the median while their
between-scan waits stayed near 25 ms. Existing receipts did not separately time
identity inventory and smaps reads, so the exact cause of the scan latency cannot
be established from those receipts. The new observer records both inventory
phases, the joined read phase and every successful or failed read interval.
`audit_memory.py` verifies complete containment, stable PID ordering and no more
than four overlapping read intervals. Concurrency/failure witnesses verify that
rediscovery cannot race a pending future and no simultaneous caller can increase
the global bound. Existing live process/zombie and import-window witnesses remain.

This revision is frozen before any key-view outcomes. It changes only this
prospective separate diagnostic cohort. Earlier shared, native and glossary
byte-copy cells remain unchanged, including every coverage failure and null
maximum. Increased observer parallelism may change observer CPU interference;
A and B receive the same fixed observer, memory cohorts are never pooled, and
none of their durations becomes authoritative timing evidence.

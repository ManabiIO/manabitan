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

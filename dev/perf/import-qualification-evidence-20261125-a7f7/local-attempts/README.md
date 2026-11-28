# Retained unsuccessful local validation

`withheld-jmdict.patch.txt` is the exact diff of the independent, unpublished
JMdict candidate `96f5ed82a76ecca9dcb8dea382ec54af288a0ffe` against baseline
`7d1643e6147a10cb2165e9744cf0e63b59e46632`. A concurrent session published the
same optimization opportunity as PR #897 with a stronger exact-subview proof.
The duplicate candidate was therefore withheld, and qualification switched to
the actual PR head. The archived patch is historical input, not an additional
proposed runtime change.

The full local unit run on that withheld candidate did not pass. Its unchanged
log records 644 passing files, three failing files, 14,542 passing tests, three
failing tests and 68 skipped tests. Two suites could not locate a supported
WASM compiler because the invocation did not set `MANABITAN_CLANG`; three
content-hash tests exceeded their existing 5,000 ms timeout. This attempt is
retained and is not counted as successful full-suite validation.

The actual PR #897's independently reviewed focused tests and exact-head hosted
CI are separate evidence. Scoped checks on the qualification tooling also had
an initial local setup failure: the JSON linter's repository configuration
imports generated extension libraries, which had not yet been prepared in this
worktree. After linking identical existing generated-library bytes, scoped
source-provenance JSON lint passed. No lint rule or product source was changed.

Other unsuccessful local VNDB type-check and dependency-symlink package attempts
are preserved with their explanations in `../vndb-independent/README.md`.

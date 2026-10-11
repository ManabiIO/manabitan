# Native MDX failed-job cleanup review — 2026-10-10

## Source and isolation

Independent branch `fix/mdx-native-failed-job-cleanup-20261010` from verified develop `e05294d263582b58bbe92c5e9f97349f6f60df31`. Worktree: `/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-lifecycle.rrlu2z/manabitan`, attached to the isolated review clone, not the preserved dependency originals. Parent and dependency AGENTS and the optimize-manabitan architecture/MDX references govern this bounded helper-only work.

PR #486 remains open at `eda468c8b88b05da7712bb9c9e3192cac4c2fc89`; its framing fix is independent and absent from this branch. PR #482/#483/#484 and all three clean original worktrees are preserved. No lookup source, benchmark source/pins, installed dependencies, old tasks, or native closeout workers were modified. This task does not compose the draft fixes.

## Confirmed bug

`HostState.convert` stages uploads in a unique job directory before validating options or invoking conversion. On an exception, no Job is registered, so download_end cannot reclaim that directory. The long-lived helper catches conversion errors and continues serving requests, leaving every failed staging copy and partial archive until host shutdown. Large failed imports can therefore accumulate disk usage across retries. The method is inherited from experimental helper commit `2de4150cb`; the production browser client uses a Worker and does not call this host.

Fault injection reproduced retention in four phases: after staging a copy, invalid termBankSize parsing, after creating a partial archive, and archive stat after a converter returned without an output file.

## Fix and costs

Guard staging through job registration with exception cleanup of only the allocated job workspace, then re-raise the original exception. Original uploads remain usable for retry; existing completed jobs remain downloadable. Successful conversion and download paths keep their current semantics. Healthy work adds a constant-sized Path and exception boundary; it does not add payload buffers, scans, or file I/O. Failure cleanup recursively traverses and removes owned staged files, proportional to that workspace. No throughput measurement or zero-regression claim.

Cleanup follows existing shutil.rmtree(ignore_errors=True) usage so a deletion problem does not mask the original conversion error. Filesystem cleanup failure can still retain files; shutdown cleanup remains the fallback. This is best-effort resource reclamation, not a guarantee against disk failures.

## Actually executed verification

Python 3.14.6, stdlib-only with the existing stub reader, no installed packages:

- Before: filtered test_failed_job_cleanup_preserves_uploads_and_retry failed in all four failure phases because j1 remained on disk.
- After: all four subcases passed. Each checks directory removal, original error type, preservation of upload bytes and an existing completed job, then successful retry in j2 and download cleanup.
- Existing filtered test_convert_stages_workspace_and_passes_description_override passed.
- git diff --check passed.

Previous #482–#486 evidence remains historical; framing tests were not rerun in this independent branch. No full tests/build/browser/native suite, benchmark, real PyGlossary, large dictionary, user database, server, merge, or deployment. Commit requests [skip ci] to avoid automatic heavyweight workflows; not release-ready.

## Remaining gaps

Original upload lifetime and automatic matching across repeated same-basename jobs still need an explicit ownership contract. Flattened basename collisions can overwrite selected staged resources. Chained redirect handling, missing/cyclic targets, native/browser HTML/CSS parity, real PyGlossary encoding/encryption, installed media/database integration, cancellation during synchronous conversion, and real transport timing remain unverified. No broad lifecycle or fidelity rewrite was attempted.

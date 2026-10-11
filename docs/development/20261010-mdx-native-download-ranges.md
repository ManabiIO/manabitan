# Native MDX download range review — 2026-10-10

## Scope and source

Independent helper-only branch from remotely verified develop `e05294d263582b58bbe92c5e9f97349f6f60df31`. Isolated worktree `/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-download.X0lEtk/manabitan`. Parent/repository AGENTS and previously read optimize-manabitan architecture/MDX references apply. Prior drafts #482/#483/#484/#486/#487/#488/#489/#490/#491, original dependency worktrees, old tasks, native closeout workers, parent sources/pins and lookup/storage ownership are preserved. This is not a composed draft state.

## Confirmed behavior

Native download_chunk passed request sizes straight to file.read. A negative size means read-to-EOF in Python, bypassing the caller's chunk request semantics and allocating/base64-encoding the entire remaining archive. Zero size and offsets past EOF produced empty chunks, indistinguishable from valid EOF; negative offsets reached filesystem seek errors. A positive integer larger than sys.maxsize overflowed despite only four source bytes remaining. These behaviors were reproduced with a seven-byte archive and real file reads, without large allocations. This method is inherited from experimental helper addition `2de4150cb`; the production browser Worker does not invoke the host.

## Fix and cost

Validate nonnegative offset no greater than the registered archive size and strictly positive requested size before opening the file. Clamp the read length to the remaining registered bytes. Offset exactly at EOF remains a valid empty result. Valid oversized positive requests still return the available suffix; arbitrary integer conversion is performed once as before.

This adds constant-time arithmetic/validation and keeps one open/seek/read plus chunk base64 encoding per valid request. No new archive scans, buffers, fixed chunk cap, protocol version, or download job lifetime change. Invalid requests now fail without file I/O. No measured throughput or zero-regression claim.

Large positive requests can still request the entire remaining archive. This focused change rejects Python's negative-size read-all behavior and prevents allocation requests beyond known remaining bytes; it does not introduce a protocol maximum or claim a fixed memory ceiling. Immutable registered archive size is still assumed; externally truncated files are not newly detected.

## Actual evidence

Python 3.14.6, stdlib, real seven-byte archive:

- Before: two filtered download tests had three failed subcases (negative/zero sizes and beyond-EOF offset) and two errors (negative seek offset and oversized integer read). Ordinary start/middle/final/EOF chunks passed.
- After: both filtered methods passed, covering all four malformed ranges and five healthy/boundary reads. Invalid ranges prove zero Path.open calls and preserved job/archive bytes. Valid reads verify exact base64-decoded output including EOF and an integer larger than sys.maxsize clipped to four bytes.
- Existing filtered staging/description-override/download-cleanup regression passed.
- git diff --check passed.

No dependencies installed, full tests/builds, native/browser suites, benchmarks, real PyGlossary, large dictionaries, user databases, merges or deployment. Prior results remain historical and were not rerun here. Commit requests [skip ci] to avoid heavyweight workflows; not release-ready.

## Remaining gaps

A transport-level maximum chunk/frame size remains unspecified; this change does not invent one. Real disconnect timing, archive truncation after registration, cancellation during synchronous conversion, upload retirement/repeated-job matching, native/browser fidelity and normalization, actual parser compatibility, installed storage integration, and composed draft validation remain unverified.

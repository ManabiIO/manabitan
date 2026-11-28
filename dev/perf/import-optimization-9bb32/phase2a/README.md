# Manabitan import optimization — phase2A evidence

**Canonical slot fingerprints did not produce a repeatable full-import gain and
will not receive a PR. MinSize qualification remains incomplete; wide-keyword
correctness is still pending. No PR has been created by this task.**

This is the immutable status snapshot at **2026-11-28 05:16:45 UTC**. It appends to
phase1 at `35069bdeb7a904fb9a39c919717b61021af9e78b`; it does not rewrite phase1's earlier pending status.
No import, benchmark, test, or source compilation was run to create this checkpoint.

## Completed fingerprint comparison

All six fixed cohorts from run 46104243724 are retained: three dictionaries and
two independently scheduled starting orders, 42 imports per cell, **252 total**.
Each cell includes 24 measured pair imports, 8 identical-code controls, 4 warmups,
4 separate memory observations, and 2 exhaustive referenced-media checks. All
outliers remain. No observation was dropped, replaced, or rerun for this archive.

Percent changes below are copied from the frozen harness analysis; positive is
slower. The full paired ratios, descriptive intervals, stage reports, controls,
and individual observations are retained. The equal-work column is the frozen
aggregate elapsed-time comparison, not a new resampling analysis.

| Cell | Median paired change | Equal-work change | Identical-code control median |
|---|---:|---:|---:|
| jmdict-AB | +1.168% | +1.504% | -0.486% |
| jmdict-BA | -1.219% | +0.969% | -0.578% |
| jitendex-AB | +1.769% | +6.725% | +1.080% |
| jitendex-BA | -0.064% | -0.191% | +0.618% |
| vndb-AB | +1.143% | +1.575% | -1.320% |
| vndb-BA | -0.298% | -0.053% | -0.484% |

JMdict changes direction between cells and does not demonstrate a replicated
gain. Jitendex and VNDB also fail to demonstrate a consistent improvement.
Correctness and qualified sampled-memory gates passed in every cell. Those
passes establish the stated validation scopes, not a speedup.

Baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`; candidate is `178ee43328141693e88b90b4b518d483c87b2fac`. The exact qualification
workflow is `b64b3d0423d758252fce9333ceef6e98431de47b`. Each cell binds its
original GitHub artifact ID, run, job, digest, byte count, source pins, browser,
registered schedule, package identities, and all observations.

## Contents and lossless scope

`proofs-and-sources.tar.gz` contains new wide-keyword static/compiler/causal
evidence, the exact five changed files from published source `ebf4278afc59d83f191692bd587f0e1f7e8682b3`, all 56-case
test receipts, all failed local attempts, outage/alignment receipts, minsize causal
analysis and successful hosted source-QA log, frozen workflow revisions, the
reviewed untimed parity helper, six completed cell audits, and retention scripts.
The native source, parser WASM, manifest, new test, and source-QA workflow are in
`source-snapshots/wide-keyword/`. Baseline source and qualification/memory tools
are also included. Small diagnostic `.bc`, `.o`, and `.wasm` outputs remain.

Six separate `fingerprint-<cell>.raw-evidence.tar.gz` files are **unchanged copies**
of the verified per-cell archives. Each contains all **269 original JSON, JSONL,
log, and protocol-JS files**, plus a derived package-verification record. That is
270 members per cell. The checkpoint is lossless for these original raw records;
it is not a byte-complete copy of each downloaded GitHub ZIP.

Before retention, the original GitHub artifact digest was checked. Both actual
nested package byte hashes and all **554 package members per arm** were independently
rehashed and matched to the source identity. The actual changed-member set was
checked against the prospective plan's exact five entries. Only the two package
ZIP payloads and 42 rendered HTML files per cell were then omitted; their original
sizes and hashes remain in each `retention-manifest.json`. The original artifact
identities/URLs remain in `github-artifact.json` and `CELL-INDEX.json`.

The present verifier checks the retained bytes and consistency of those original
package-verification records. It cannot rehash omitted payloads without obtaining
the original artifact. Recorded HTML hashes do not claim an independent proof of
HTML/JSON equivalence. Original dictionary and media payloads are not duplicated.

## Failed and pending work stays explicit

The first wide compiler attempt preserved optimized assembly but encountered a
relocated-wrapper assembler failure. Its raw logs are retained along with the
authorized completion that assembled/linked those unchanged outputs. There was
one source-optimization variant. Ordinary production regeneration later matched
the same parser bytes.

The unsupported `--minWorkers` setup failure happened before discovery. The
corrected invocation passed all 56 actual-WASM cases. Changed-file lint and the
eleven pre-existing focused suites later ended by SIGKILL, with no complete
verdict or retry. Empty logs remain empty. The initial remote-alignment attempt
did not execute during the environment outage; a single guarded same-tree
alignment subsequently succeeded. Historical receipts remain verbatim, including
earlier statements such as static-only or not-yet-published; use `STATUS.json` for
this checkpoint's later state.

MinSize hosted source QA **46104779877 passed** at source `2907ba1bad0958c22fe363f88d7cceb4d4bc604e`: pinned
native check, 380 focused tests, JavaScript lint, four TypeScript projects,
669 unit files / 15,135 tests passed / 47 skipped, and all-target dry build.
Its full browser run **46104898097 is incomplete at this snapshot**. Two partial
JMdict log projections are included as partial notes only; minsize raw cohorts
and subsequent audits are reserved for the next checkpoint. No full minsize
performance conclusion is asserted here.

Wide source QA **46110109833** and untimed full-parser-output parity
**46111036970** remain pending at the snapshot. The parity diagnostic commit is
`52a7f01ef88021a35f90d05510cec7f58557e935`. No wide performance run has launched.
The smaller bytecode and changed long-literal loads establish an experiment
hypothesis; the causal review explicitly does not infer dictionary-specific
literal frequency, physical JIT register behavior, or an import-speed gain.

## Earlier dependencies and reproducibility

`PHASE1-DEPENDENCIES.json` gives immutable archive/member hashes for earlier IR,
assembly, baseline profiles/receipts, and local components. The complete phase1
inventory is retained under `prior-checkpoint/`. In particular, the original
`/tmp` minsize IR and toolchain paths disappeared during environment recovery;
their historical path strings are not claims that those paths still exist.
Recover the evidence bytes from phase1 rather than reconstructing a toolchain or
silently substituting new compiler output.

Phase1 lives at `dev/perf/import-optimization-9bb32/phase1` in `35069bdeb7a904fb9a39c919717b61021af9e78b`. Its archive SHA256 is
`050a01b9994034c0e070d66e17d1f879b20d724772e8c187af354a879936d161` and Git blob is `b6ce6a5a350f26074a273d3d772276867182e76a`.
Corpus capture manifests and archival receipts are retained; large corpus
payloads, compiler/runtime distributions, dependencies, and generated product
ZIPs are excluded. `EXCLUSIONS.json` states the exact retention/deferment limits.

Hosted QA and qualification use **Node 22.22.0**. The retained local correctness
and component receipts use **Node 24.20.0**. Follow each original command, runtime,
source identity, and locked dictionary manifest; do not relabel local results as
hosted observations. Complete parser-output component digests differ in scope
from hosted persisted lookup checks: the latter sample twelve fixed terms across
one cold and five warm passes. Prescribed separate media slots scan all referenced
media. Memory is non-atomic sampled process-tree PSS/private with the frozen
coverage gate, so between-scan peaks can be missed. Stage timers overlap.

## Verify without rerunning work

Run `python3 verify-phase2a-checkpoint.py .` from this directory. Optionally add
`--phase1 /path/to/checkpoint-phase1.tar.gz` to check prior dependency bytes, and
`--repack /path/to/new-proof.tar.gz` to confirm deterministic proof repacking.
These operations only read/hash retained records and write the requested repack.
They do not run any import, test, or benchmark.

`PROOF-INVENTORY.json` binds every proof member except itself; it also occurs
inside the archive. `INVENTORY.json` binds every other publication item by size,
SHA256, and Git blob SHA1. It excludes itself to avoid a recursive hash, so its
trusted identity is supplied by the containing Git tree and the external
publication receipt. A later independent audit may be published adjacent to this
sealed set; it does not alter the recorded evidence. Tar entries are sorted regular
files with mode 0644, UID/GID zero, empty owner names, and mtime zero; gzip has an
empty filename, mtime zero, and compression level 9. A second proof pack must have
identical bytes. The six existing raw archives are copied, never repacked.

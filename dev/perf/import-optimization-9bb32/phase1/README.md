# Manabitan import optimization: phase-one evidence

**Full browser qualification is pending. No PR has been created for these experiments.**
This checkpoint records the state reported at 2026-11-28 04:22 UTC. It is diagnostic
evidence, not acceptance of either candidate. Later hosted results must be retained
as a separate update; do not rewrite this checkpoint's raw observations.

## Frozen identities and current status

- Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
- Canonical slot fingerprints: `178ee43328141693e88b90b4b518d483c87b2fac`.
  Source QA run 46102827974 passed; full browser run 46104243724 remains incomplete.
- Composite minsize: `2907ba1bad0958c22fe363f88d7cceb4d4bc604e`.
  Runtime bytes equal screened 483586ae; the extra commit is a source-QA workflow.
  Local 380-test/native checks passed. Source QA 46104779877 and browser 46104898097
  remain pending at this checkpoint.
- Frozen browser workflow copies and exact commit/run bindings are in
  `profiling/hosted-plans/` and `frozen/bindings.json`. The older fingerprint run
  46102936165 was superseded prospectively for a package-member gate correction;
  its original workflow and the correction receipt are retained too.

## What is retained

`profiling/` contains ordinary and traced hosted baseline JSON, all raw component
screens and their schedules/status, failed or partial attempts, replay/analysis
scripts, source-QA logs, package comparisons, native symbol/assembly receipts,
canonical fingerprint operation counts and production assembly proof, parser-slot
counter attempts and the compatibility audit, and finalization attribution. A
small subsequent record-field-proof review is included without changing the
04:22 qualification-status snapshot.
`compiler-static/` adds minsize IR/validation receipts and both no-media static
probes. Small generated diagnostic WASMs are retained; they are not release
packages. `toolchain-provenance/` contains the compiler manifest and relocation
wrapper scripts, without the compiler distribution.

`rejected/` contains complete unapplied score-plan and record-fields patches.
The score-plan patch includes both new files, also retained separately. Each patch
passed `git apply --check` against the frozen baseline; nothing was applied.
`frozen/` retains candidate patches, native manifests, source-QA workflows, locked
dictionary manifest, and baseline qualification/memory/receipt tooling.

The original reports are not cleaned or normalized. In particular:

- `exploratory-observation-status.json` invalidates early mismatched-option screens.
- `composite-minsize-screen-1/cohort-status.json` records the SIGKILL stop. The empty
  failed observation log is retained and no missing result JSON is fabricated.
- Separate VNDB parity does not resume or replace that stopped timing cohort.
- Parser-slot compilation attempt 1 and attempt 2 failed; their logs/identities stay.
- Local interrupted unit/type/build attempts remain alongside later hosted QA.

## Integrity and deterministic packaging

Run `python3 verify-phase1-checkpoint.py checkpoint-phase1.tar.gz` beside this file.
`INVENTORY.json` binds every archived file except itself by SHA256 and byte count,
and records its source path or commit. The archive also contains the inventory.
External `SHA256SUMS` binds the archive, inventory, status, verifier, and packaging
receipt. Tar members are sorted regular files with mode 0644, UID/GID 0 and mtime 0;
gzip uses an empty filename, mtime 0 and level 9. A verified second repack must have
the identical archive SHA256. `--repack PATH` performs that check without importing
a dictionary. Packaging changes metadata only, never retained file contents.

## Reproduction boundaries

Use isolated checkouts at the commits above and the locked archives from
`test/perf/dictionaries.lock.json`. Hosted qualification uses Node 22.22.0; the
retained local component screens use bundled Node 24.20.0. Reproduce each plan with
its recorded runtime identity rather than treating those versions as equivalent.
Install project dependencies and build
generated libraries using the repository's pinned scripts. Native regeneration
uses Clang/LLD 21.1.8 and each retained manifest's unchanged arguments:
`npm run build:dictionary-wasm -- --check`. Source-QA workflow files specify the
complete gates; hosted qualification workflows specify topology, run order,
package-member gates, baseline controls and memory/semantic qualification.

The raw canonical corpus and archive payloads are omitted for size. Their manifests
and archive receipt are retained. Regenerate a capture with the retained runner:
`node pipeline-replay.mjs BASELINE_TREE jmdict NEW_CAPTURE_JSON 1 '{}' 4 capture`.
Use jitendex/vndb for the other corpora. This writes a new `.groups` directory;
verify fixture/source and group-column identities before reusing a capture.
`canonical-replay.mjs TREE CAPTURE_JSON OUTPUT_JSON REPETITIONS` replays the
canonical component. The pipeline runner's `verify` mode hashes complete parser
outputs separately; `timing` mode is a producer component, never a full import.
Hosted stored-lookup checks sample persisted lookups and verify referenced media
in the prescribed qualification slots. Complete component digests do not establish
exhaustive persisted-row equality.
Follow the original plans' failure policy and do not fill missing old observations.

The omitted `jmdict-scores.bin` is the little-endian Int32 score vector from field 4
of locked JMdict term banks in numeric bank order (528299 rows). Its required SHA256
is 8402c2d8fb9865b294b6ce20f2e704af067b77f57ad15ca144ac3b14688315eb.
Score/record component scripts also declare their synthetic/virtual reference
limitations. Some diagnostic scripts intentionally retain absolute workspace
paths; recreate that layout or adapt a separate copy and record its new hash.
Never edit these archived originals to make a rerun appear identical.

No product behavior, dictionary, worker count, threshold, or benchmark schedule was
changed while assembling this checkpoint. Original files and worktrees remain.

# Read first: two phase2A documentation clarifications

The qualification status remains frozen at **2026-11-28 05:16:45 UTC**.
Fingerprint has no reproducible full-import gain and no PR. MinSize full browser
qualification and wide-keyword correctness remain pending at that snapshot.
This clarification changes no observation, source file, compiler output, audit,
raw log, benchmark schedule, artifact, or decision.

## Partial minsize material

The initial README and exclusions describe “two partial JMdict log projections.”
The actual retained material is **one JMdict BA stage projection and its companion
binding record**, both for job `140855328275`:

- `profiling/minsize-jmdict-ba-log-stage-projection.json`
- `profiling/minsize-jmdict-ba-log-projection-binding.json`

There is no separate AB stage projection in this checkpoint. The task's status
reported disagreement between two JMdict cohorts, but the complete minsize raw
cohorts and subsequent independent audits are deferred to a later checkpoint.
Do not treat these two BA files as complete minsize qualification.

## Runtime versions

Hosted source QA and the frozen browser qualification use **Node 22.22.0**.
The separately queued **untimed full-parser-output parity** workflow uses
**Node 24.20.0**, matching the retained local component baselines. The local
correctness receipts also use Node 24.20.0. The archived workflow explicitly pins
this parity version at `profiling/hosted-wide-parity-spec/import-wide-keyword-parity-9bb32.yml`.
The original README's QA/qualification wording must not be read as applying
Node 22.22.0 to that separate parity job.

## Preservation and verification

All seven binary archives, all original proof records, the original README,
STATUS, EXCLUSIONS, PACKAGING, and the verifier remain byte-identical to the first
seal. Their archived copies retain their historical wording. This document and
`METADATA-CORRECTION.json` provide the corrected interpretation; neither grants
an exception to any byte check. The existing verifier runs unchanged.

The initial outer inventory, publication list, and verification receipt are
preserved verbatim as `INITIAL-SEAL-INVENTORY.json`,
`INITIAL-SEAL-PUBLICATION.json`, and `INITIAL-SEAL-VERIFICATION.json`.
The current outer `INVENTORY.json` adds these clarification/preservation files.
Its trusted identity comes from the containing Git tree, as before.

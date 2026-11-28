# Import research checkpoint after the UTF-8 studies

This is an evidence checkpoint, not a product release. No completed candidate in
this checkpoint supports a performance PR. Original observations, failures,
source patches and prospective decisions are preserved.

## Completed outcomes

| Experiment | Outcome |
| --- | --- |
| Conservative native gzip, JMdict | Paired median −5.67%, equal-work −1.70%, only4/6 faster; private-memory median +5.36% failed. Held. |
| Conservative native gzip, Jitendex | Paired median +25.48%,0/6 faster; memory gates failed. Held. |
| Conservative native gzip, VNDB | Paired median +0.55%; memory sampling unqualified. Held. |
| Expanded native gzip, VNDB versus conservative | Independent six-pair median +48.81%,0/6 faster; memory gate failed. |
| Expanded native gzip, VNDB versus9e | Independent six-pair median +42.49%,0/6 faster; memory gate failed. |
| Inline-only and continuation-word UTF-8 | Complete4-preflight/32-child Node cohort. Neither passed; identical control was outside the prospective CPU limits. |
| Paired-CJK v2 | Complete3-preflight/36-child Node cohort, three measured pass means per child. B/A CPU median +1.15% versus B/C −5.83%; identical C/A equal-work +8.21% failed. Held/inconclusive. |

The native correctness canaries pass their stated logical input/output and
failure-order checks; correctness does not establish speed or memory improvement.
Expanded VNDB effects belong to separate hosts and must not be pooled or
subtracted. The UTF-8 results cover parser plus completed lookup CPU in Node;
they do not measure full imports. Their complete semantic projections passed.

## What is retained

- `results.json` gives exact comparisons, intervals, controls and limits.
- `evidence/profile-evidence/utf8-parser-study-c1ec/` and
  `evidence/profile-evidence/utf8-pair-study-c1ec/` retain plans, approval receipts,
  every child/pass/group, source identities, complete audits and failed attempts.
- All inline/word/pair source gates are retained, including pairv1 (unmeasured),
  the killed v2 correctness command, its separately authorized successful retry,
  and the initial post-acquisition floating-point audit failure.
- Both expanded VNDB raw reports, strict readers, frozen plans and job receipts
  are included. Large hosted ZIPs remain outside the compact payload with their
  immutable IDs, sizes and SHA-256 recorded in the manifest.
- Direct-writer source and its frozen diagnostic/reader are retained; its pending
  hosted result is not invented. New guarded-burst code is outside this snapshot.
- Browser cancellation/CRC and CI test drafts remain explicitly unapplied.

## Unchanged prior checkpoint

`prior-checkpoints/precomponent-v1/payload.tar.gz` is the exact6,680,444-byte
archive SHA-256 `026ea697a1e738e1381ec5318fb071a2aec4b15e98a9f9a4e43c5637f78da712`.
It retains all1,076 original members: string masks, broad/narrow record fields,
publication fusion, descriptor diagnosis, original native gates, all conservative
raw reports, source closure, and failed observations. Nesting this compact payload
preserves every original byte without restoring57MB of redundant raw filesystem
extractions. Its historical summaries remain historical; this checkpoint's
`results.json` records the newer outcomes.

## Verification and source restoration

Run `python3 verify_archive.py payload.tar.gz --repo /path/to/manabitan`.
The repository needs exact published baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` and its objects. Every
retained source commit is reconstructed in dependency order by applying its
binary patch to a separate temporary Git index; each tree and raw commit object
must match. The real index and worktrees remain unchanged. The verifier also
checks every top-level and nested prior-checkpoint member hash and safe path.
`source-patches/` includes regenerated WASM/manifests and tests, not just C/JS text.
Small standalone oracle binaries/WASM are preserved with their source/receipts;
dependencies and external dictionary ZIPs are excluded.

## Publication boundary

The archive creator performs no remote write or new experiment. Root may publish
the adjacent files listed in `publication-manifest.json` on one research evidence
branch. That manifest provides local paths, exact SHA-256 and Git blob identities.
Future hosted outcomes require a new named addition, never rewriting this one.
The publication pattern screen lists its exact patterns and match count. It is
not an exhaustive secret audit. The earlier checkpoint's broader wording is
preserved as historical evidence and is not repeated as a current assurance.

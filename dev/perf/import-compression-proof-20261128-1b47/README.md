# Corrected compression proof study

This is one separate correction of a representation-sensitive validation omission
in the original Zstd level −2 experiment. The original JMdict and Jitendex trials
stopped during their initial warmups: their exact storage deltas passed, but their
physical diagnostic digests differed. They remain failed and unqualified. The
original VNDB trial is complete and is not repeated here.

The new study compares exactly the same compression change on the current common
baseline. It acquires one fixed cohort each for JMdict and Jitendex. No original
warmup or observation is reused. There are no additional optimization variants,
replacement cohorts, adaptive sample counts, control subtraction, or pooling with
the original trials or component replays.

## Source identities

| Role                                   | Exact identity                             |
| -------------------------------------- | ------------------------------------------ |
| Active common baseline                 | `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16` |
| Compression product origin             | `f7980e638ea1808701ac28339987663fd8b3dc4e` |
| Historical storage prediction baseline | `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` |
| Runtime blob                           | `9a63ef28bcf862108c407c5636eb492009ba815f` |
| Worker-context expectation test blob   | `c9b3006765f6ed3b51ba39622d5a370f46409bc0` |
| Startup-overlap expectation test blob  | `301c4ba0d8a0d1d1842479868ef44ffb878d9d49` |

Those three product/test files are copied byte-for-byte from the compression
origin. Both arms use the current baseline's native parser and all other product
files. The candidate's complete commit identity is recorded before acquisition;
the only changed package member must be `js/dictionary/zstd-term-content.js`.

The three original compression study-tool files remain byte-identical to f798.
Their nested `baselineSha` still records the historical 9e10 prediction origin;
it is not the active common baseline. The new policy, registered plan and source
identities distinguish all three roles explicitly. The unacquired corrected
preparation on 9e10 was preserved before this source-context update with zero
registered acquisition plans and zero observations.

## Physical and decoded proof

The original diagnostic digest includes physical content previews, offsets and
total-length availability. A compression representation change can alter those
inputs while preserving decoded dictionary content. The original raw validator,
validation object, diagnostic digest and report files remain unchanged.

The same registered harness overlay on A, B and identical-code control C adds
`benchmark.compressionProof` to the raw report outside the validation object. It
retains the exact original physical digest preimages before and after restart,
the corresponding sampled reference rows, and the complete JSON returned by all
twelve decoded term lookups before and after restart. It also binds all 72
existing post-restart lookup observations. The new pre-restart lookup pass occurs
after the unchanged import endpoint; the existing first post-restart lookup pass
supplies the post-restart full JSON.

The policy accepts only bounded 20-byte `raw-block-v2:jmdict` reference records for
these two dictionaries. Reference offsets are physical addresses and can differ
across A/B. Decoded entry lengths, identities, terms, row order, counts, dictionary
tags and full decoded results must remain exact. A positive reported total length
must equal the independently inventoried content-file size; the existing −1
unavailable sentinel must remain the same on both sides. Every reference must be
inside the actual stored file, and every read must have succeeded.

Only after those proofs pass does a separately labeled comparison copy remove
the physical `outputDigestSha256`, add a domain-bearing
`compressionLogicalProjection`, and make the original two storage-number
adjustments. Raw receipts and proof bytes remain intact. Independent A-family
and B anchors enforce exact physical proof and raw receipts across warmups,
measured observations, full-media checks and memory runs. The only media exception
is the explicit sample/all boundary; the separate full-media A/B comparison stays
exact. A/C and B/B never receive the cross-arm logical projection allowance.

## Fixed acquisition and gates

Each corpus has four excluded warmups, six A/B pairs alternating AB/BA from AB,
and two identical-code A/C pairs interleaved after pairs three and six. Every
observation uses a fresh browser profile and production import defaults with no
flags. The primary endpoint remains file-input change through post-UI import
completion. The original paired median, equal-work ratio and descriptive
10,000-resample complete-pair bootstrap with seed 897 are unchanged.
Every observation must report exactly three parser workers, the unchanged
production policy for these fixed inputs; this assertion does not configure the
worker count or add an import flag.

The original exact byte predictions remain fail-closed predicates: B−A content
and total storage must both be +312,404 bytes for JMdict and +750,018 bytes for
Jitendex, with the unchanged ≤2% complete-storage budget. The current baseline is
not used to recalibrate those numbers after observing a result. All other file
sizes, decoded lookup/media checks, work counts and restart checks remain exact.

After timing, the same separate exhaustive-media checks and four sampled memory
observations use the original gates and schedule. Memory markers compose on the
registered proof harness. Exact original, proof and proof-plus-memory source
hashes are emitted; before every run the only dirty path must be the registered
harness. A finalizer restores the original tracked harness and verifies clean
tracked trees and unchanged package bytes, including after failures. Missing
coverage or failed semantics remain failures; no failed record is replaced.

Fresh current-tree validation must pass the pinned native byte check, full unit
suite, build validation, changed-source lint, main/test type checks and focused
proof/driver rejection tests before either browser job starts. Historical f798
validation is provenance only. The independent artifact reader re-derives proofs,
checks exact raw sidecars, source/package identities, clocks, schedules, status
and memory gates; it does not accept the original proof-less failures.

## Bounded review disposition

A provisional compression draft is considered only if both active corpora pass
all semantic, exact-storage and memory gates. At least one must have a candidate
paired median and equal-work change below zero, a descriptive upper bound below
zero, and both changes more favorable than the corresponding identical-code
controls. Controls are reported directly and are never subtracted.

The other corpus blocks a compression PR if its descriptive lower bound is above
zero, or if at least five of six pairs are slower and both its paired median and
equal-work changes are above zero. Any remaining ambiguity must be reported.
Passing semantic and memory gates is not evidence of latency non-regression.
These rules are review triage, not statistical significance or merge readiness.

If neither corpus meets the useful-signal conditions, the compression mechanism
is closed without a product PR. The old component replay alone cannot justify a
compression PR. Even a qualifying result is one-host evidence for provisional
draft review only. This fixed correction ends after the two declared cohorts,
regardless of outcome.

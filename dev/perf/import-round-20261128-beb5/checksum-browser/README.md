# Native triple-checksum Chromium component screen

## Decision at completion

Continue to a separately frozen production integration experiment. This screen
establishes a checksum mechanism benefit, especially for VNDB; it does not
establish a complete-import benefit and did not produce a performance PR.

Frozen research source: `7de62b7f5888e8d40f0f0c48778a33a5c0407b84`, tree
`fa6c438551e995af4bc295d3bff6b68fb3b02caf`.
[Original run](https://github.com/ManabiIO/manabitan/actions/runs/46105941620).

## Results

Each corpus has eight balanced treatment pairs and eight independent identical
JavaScript control pairs, for 32 fresh-browser observations. No prehash warmup,
repetition selection, observation removal or replacement was used. All 96
observations match the expected checksum sequence and pinned input identities.
Negative changes below mean less measured work.

| Corpus   | Median checksum work | Median startup + checksum | Median time saved, including startup | Faster total pairs | Equal-work total | Identical-code equal-work total |
| -------- | -------------------: | ------------------------: | -----------------------------------: | -----------------: | ---------------: | ------------------------------: |
| JMdict   |              -71.84% |                   -12.13% |                              4.16 ms |                7/8 |          -14.24% |                          -4.67% |
| Jitendex |              -66.94% |                    +4.24% |                             -0.98 ms |                3/8 |           -0.08% |                          -4.41% |
| VNDB     |              -47.81% |                   -40.25% |                             69.00 ms |                8/8 |          -40.63% |                          +0.60% |

Jitendex has no startup-inclusive benefit in this cohort. JMdict's small absolute
saving is accompanied by substantial startup noise in the identical-code
controls. VNDB's later groups save a median 72.16 ms, so its checksum benefit is
not confined to the first call. CPU models differ between corpora: do not
interpret cross-host differences as dictionary-specific effects.

## What is measured

The checksum timer includes admission, all copies into fixed 64 KiB native
memory, ABI calls and final checksum production. The total also includes helper
module loading and native module HTTP read, compile and instantiation. Fresh
browser/worker launch, fixture HTTP reads, SHA checks, construction of the input
backing layout and comparison with expected hashes are outside those timers.
This is neither concurrent worker throughput nor browser import wall time.

The frozen capture omits actual content-dictionary run splitting and production
image-projection/escaped-key options. In particular, captured VNDB group 23 used
Float64 scores where the real worker returns Int32 scores. The original capture
and all observations remain unchanged. The separate four-group real-worker
ownership diagnostic verifies ordinary private final checksum spans and native
activation for those groups; its synthetic split is not an observed production
run distribution. See `capture-scope-correction.md` for the complete limit.

## Evidence and independent checks

The three ZIP files are verbatim GitHub artifacts. `index.json` binds their
original IDs, SHA-256 digests and byte counts. Each contains the prospective
campaign, complete raw arms, host and source identity, capture manifests and
logs. The independent verifier checks all sample files, schedules, identities,
zero warmup, complete group coverage, output digests and timing sums. A second
root audit independently recomputes paired and equal-work arithmetic directly
from the raw arms. Every outlier and every control remains included.

The next experiment may place this hash implementation in unused space in the
existing canonical module's reserved prefix. That would be a different product
integration and must receive its own correctness, source/package, complete-import
and memory qualification. These component numbers cannot be relabeled as its
results.

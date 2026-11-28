# Whole-glossary prefix witness component experiment

**Decision: hold the original candidate. No product PR is justified by this experiment.** JMdict has a repeatable component signal, but the same code regresses Jitendex, VNDB, and short unique input. A separately attributed admission/probe-order revision may be screened; none of its observations belong to the cohort below.

## Frozen source and acquisition

- Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
- Corrected acquisition source: `47f3c3262931d0a92728c72fcd5cfb9b0ccc49a0`, tree `023368b2731c17c91f16cd740d868ae2ebafa27b`.
- [Completed component run](https://github.com/ManabiIO/manabitan/actions/runs/46106527898).
- Candidate parser WASM SHA256: `9972fb2df890f77fe43b3401b464c0ff1c36c4b89784b47268e3888bd7979d23`, 68,285 bytes; baseline 67,659 bytes.
- The [initial acquisition](https://github.com/ManabiIO/manabitan/actions/runs/46104544456) failed all three package identity checks before timing. A dependency-directory symlink changed release membership. The correction copied the pinned dependency tree; it did not change the candidate runtime. Original failure artifacts and complete job logs remain in `initial-staging-failure/`.

Each original GitHub artifact ZIP is retained verbatim, with its API digest and ID in `index.json`. No artifact members, timing observations, or outliers were removed. The acquisition retained complete release-entry digest maps, but its original release ZIP bytes are not included in these component artifacts; the independent audit therefore does not claim to have rehashed those release archives.

## Measured scope

These are hosted Node component replays of all current source groups through inflate, CRC checks, native parsing, lookup encoding, and private result copies. Each group is verified before its six alternating candidate pairs and six identical-code pairs. It is replayed repeatedly before the next group. The first invocation is retained separately in the verification entries; it is not part of the warmed sums below. Pair-index sums across groups are descriptive complete-work sums, not six independent imports or six independent browser hosts.

The replay excludes shared worker transport, image projection, actual content-dictionary run splitting, lookup-route construction, compression, SQLite, OPFS, and UI finalization. In particular, its VNDB escaped-key option differs from the production worker, so its 26 Float64/fused-fallback groups are properties of this synchronous replay. They must not be reported as production activation counts. The complete exposed-output equality checks apply to the measured path.

Positive changes mean slower. No control subtraction or host pooling is applied.

| Dictionary |   Groups / rows | Median paired change | Equal-work change | Faster pairs | Identical-code median |
| ---------- | --------------: | -------------------: | ----------------: | -----------: | --------------------: |
| JMdict     |    12 / 528,299 |              -3.903% |           -3.522% |          6/6 |               +0.151% |
| Jitendex   |    22 / 436,555 |              +1.394% |           +1.064% |          2/6 |               -1.057% |
| VNDB       | 170 / 6,648,310 |              +2.638% |           +2.570% |          0/6 |               +0.414% |

JMdict glossary witnesses increase from 54,641 to 200,168, while full-content reuse increases from 154,416 to 159,158. Jitendex gains only 15 glossary witnesses and VNDB only 156. Native maximum heap bytes match baseline for each corpus; this is not a whole-browser memory qualification.

## Negative controls and correctness

The enabled short-unique control is slower in all six pairs: +7.824% median and +12.853% equal-work, versus +0.532% / +0.437% for identical code. Unique-prefix and common-prefix/different-middle workloads also regress. The deliberately favorable nonlocal-reuse fixture improves by 74.072% median, with 9,966 additional exact witnesses. That synthetic mechanism check does not outweigh the observed regressions.

The independent audit reconstructs all 5,661 append-only journal entries and their saved reports, verifies source/member maps and original artifact bytes, and recomputes every pair sum and ratio. The native edge oracle passes 242 comparisons across 42 cases: 175 successful comparisons and 67 matching errors. All three whole-corpus replay outputs and the separately retained disabled-feature checks match their corresponding baselines. Failed initial acquisition remains a failed receipt.

`assess-prefix-screen.py` accepts extracted report paths and reproduces the descriptive arithmetic. `*-assessment.json` and `independent-audit.json` retain the complete results, including controls and unfavorable observations. The two review notes document other JMdict ideas screened out because they duplicate current work or do not activate under the existing import policy.

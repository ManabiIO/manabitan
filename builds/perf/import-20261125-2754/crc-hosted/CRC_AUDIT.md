# Frozen CRC candidate audit

**Result: retain as an unqualified performance experiment.** The fixed timing screen does not establish a material, reliable complete-import improvement. Both VNDB memory replications fail their frozen coverage gate; this is not a measured PSS/private regression.

Candidate: `c2cf7647c67b02474301ed48e54a53205be0f027`, tree `074e622aec0c6537c7f0d8ac92725dd62c28b73b`. Baseline and identical control: `7d1643e6147a10cb2165e9744cf0e63b59e46632`, tree `99d23f16e973c7ae9feba77ca3643d1c27dfb93d`.

Timing run: [45644628634](https://github.com/ManabiIO/manabitan/actions/runs/45644628634). Memory run: [45644635208](https://github.com/ManabiIO/manabitan/actions/runs/45644635208). Both are attempt 1. No acquisitions, retries, replacements, exclusions, or thresholds were added by this audit.

## Timing

All 69 raw reports reopened successfully: 23 per dictionary, comprising three excluded warmups, 18 timed observations in six balanced three-arm blocks, and two excluded exhaustive-media diagnostics. The unchanged report validator, source/fixture/package/harness identities, output/lookup/media/storage receipts, and independently recomputed analysis all reconcile. A and C use identical baseline products.

Values below are medians of within-block percentage changes, followed by the descriptive 95% paired-bootstrap interval (10,000 resamples). Negative values are faster.

| Dictionary | Candidate B/A | Candidate B/C | Identical control C/A | B faster than A |
|---|---:|---:|---:|---:|
| jmdict | +1.085% [-0.491%, +2.929%] | +0.301% [-1.597%, +2.104%] | +1.078% [-0.120%, +1.757%] | 1/6 |
| jitendex | -1.186% [-1.719%, -0.220%] | -0.792% [-4.041%, +0.103%] | -0.130% [-1.335%, +3.205%] | 5/6 |
| vndb | +0.859% [-4.536%, +3.886%] | +0.131% [-8.671%, +4.740%] | +1.266% [-4.228%, +7.709%] | 2/6 |

Jitendex improves modestly against A, but its B/C interval crosses zero. JMdict and VNDB do not show a reliable advantage. VNDB also has substantial identical-product variability: its worst C/A pair is +10.625%. No tails were discarded.

## Memory

All six cell audits independently reconcile 24 scheduled observations and 2,435 original process-tree scans. All 24 correctness receipts pass, and all eight receipts per dictionary agree across the two replications. Nineteen observations meet full import-window memory coverage; five VNDB observations do not. Invalid observations retain null qualified maxima.

The frozen observer and auditor are byte-identical to the previously approved versions. Gates require at least five complete import-window scans, covered gaps/brackets no greater than 250 ms, and per-replication PSS/private median increases no greater than 5% with no paired increase over 10%. Both replications must pass.

| Dictionary | Replication | Qualified observations | PSS median / maximum paired change | Private median / maximum paired change | Result |
|---|---:|---:|---:|---:|---|
| jmdict | 1 | 4/4 | +0.478% / +0.641% | +0.179% / +0.229% | passed |
| jmdict | 2 | 4/4 | -1.655% / +1.038% | -2.063% / +1.667% | passed |
| jitendex | 1 | 4/4 | -0.414% / -0.266% | -0.459% / -0.348% | passed |
| jitendex | 2 | 4/4 | +0.871% / +2.704% | +1.142% / +3.872% | passed |
| vndb | 1 | 0/4 | — / — | — / — | failed |
| vndb | 2 | 3/4 | — / — | — / — | failed |

Every failed observation is retained:

| VNDB replication | Observation | Covered gap | Stable complete import scans | Qualified maxima |
|---|---|---:|---:|---|
| 1 | A1 | 330.483 ms | 45 | null PSS and private |
| 1 | B1 | 266.171 ms | 43 | null PSS and private |
| 1 | B2 | 322.760 ms | 43 | null PSS and private |
| 1 | A2 | 370.240 ms | 42 | null PSS and private |
| 2 | B2 | 452.155 ms | 70 | null PSS and private |

VNDB replication 1 A2 also retains one unreadable address-space scan inside the import window, which the frozen observer excludes rather than counting as zero. Its recorded failure remains the excessive covered gap. Replication 2 pair 1 is qualified (PSS −0.659%, private −0.491%); it does not replace or qualify the failed second pair.

## Correctness and storage

Exhaustive diagnostics match all 236 Jitendex media files (4,992,155 bytes) and all 146,570 VNDB media files (188,131,284 bytes); JMdict has no media. Full row inventory, the unchanged sampled lookup/restart receipts, and output digests reconcile. This is not exhaustive lexical readback.

Observed storage totals are constant across all retained reports: JMdict 43,520,477 bytes; Jitendex 67,466,332 bytes; VNDB 609,553,611 bytes. The unchanged prospective storage policy is preserved; VNDB active SAH allocation is 528,384 bytes in every memory receipt. This does not claim SQLite byte equality.

All nine artifacts have verified service SHA-256 digests. Package-entry contents are identical across all independent jobs/studies within each source arm. Whole ZIP hashes vary with packaging metadata and are retained per acquisition; timing C reuses the exact A archive.

## Retained evidence

- [Artifact identities and verified ZIP digests](artifacts.json)
- [Independent timing audit](independent-timing-audit.json)
- [Independent memory audit](independent-memory-audit.json)
- [Cross-study package-entry audit](cross-study-package-audit.json)
- [Read-only audit wrapper](audit_crc.py)
- [Unchanged timing auditor copy](timing-auditor.py)
- Exact workflow sources: [timing](workflow-timing.yml), [memory](workflow-memory.yml).

These are fixed exploratory cohorts, not an independent speed qualification. Intervals are descriptive with no multiple-comparison adjustment. Memory maxima are sampled, non-atomic process-tree observations, not exact peaks. Different stages and memory timings were not pooled.

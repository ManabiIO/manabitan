# Original browser import campaign

https://github.com/ManabiIO/manabitan/actions/runs/45110694360

Per-replication eight AB/BA candidate pairs; two AA pairs before and two after; two excluded warmups. Median of paired percentage changes, negative is faster. All observations retained; no filtering. Memory diagnostics excluded from timing.

Original browser harness samples 12 terms plus restart/count checks. Its digest can encode physical content references; a failed cross-arm digest is never accepted as performance qualification here. Separate corrective semantic readback is outside this original campaign.

Original post-timing memory sampler did not establish whole-tree/import-worker coverage. Preserve its observations, but do not use them to claim memory non-regression. Authoritative import timings are independent; see memory-coverage-audit.json.

Jobs: {'success': 22, 'failure': 2}. Verified artifacts: 24/24. Replications passing original timing guards: 22.

Passing the guards establishes comparable timing evidence; it does not by itself establish a speed improvement.

| Candidate | Dictionary | Replication | Timing guards pass | Candidate median change | Faster pairs | AA median (range) |
|---|---|---:|---|---:|---:|---:|
| owned-shared | jmdict | 1 | yes | +0.40% | 3/8 | +1.94% (-52.13% to +4.12%) |
| owned-shared | jmdict | 2 | yes | +2.39% | 2/8 | +0.88% (-0.35% to +4.80%) |
| owned-shared | jitendex | 1 | NO | -13.40% | 8/8 | -1.98% (-3.23% to -1.34%) |
| owned-shared | jitendex | 2 | NO | -16.07% | 8/8 | +1.36% (-10.92% to +3.27%) |
| owned-shared | vndb | 1 | yes | +0.66% | 3/8 | +2.70% (-1.78% to +6.96%) |
| owned-shared | vndb | 2 | yes | -2.97% | 7/8 | +0.88% (-5.65% to +3.70%) |
| content-validation | jmdict | 1 | yes | +1.37% | 2/8 | -6.62% (-49.92% to +2.79%) |
| content-validation | jmdict | 2 | yes | -0.61% | 6/8 | -1.47% (-9.32% to +1.27%) |
| content-validation | jitendex | 1 | yes | -0.74% | 5/8 | +0.65% (-4.01% to +4.59%) |
| content-validation | jitendex | 2 | yes | -1.72% | 5/8 | -0.26% (-2.56% to +1.74%) |
| content-validation | vndb | 1 | yes | -1.19% | 6/8 | +1.11% (-0.77% to +1.89%) |
| content-validation | vndb | 2 | yes | -0.75% | 6/8 | -0.16% (-10.48% to +1.69%) |
| media-diagnostics | jmdict | 1 | yes | -0.68% | 5/8 | +1.16% (-8.12% to +25.96%) |
| media-diagnostics | jmdict | 2 | yes | +0.29% | 4/8 | +0.44% (-4.04% to +13.00%) |
| media-diagnostics | jitendex | 1 | yes | -1.09% | 5/8 | -0.60% (-1.15% to +3.83%) |
| media-diagnostics | jitendex | 2 | yes | -0.19% | 4/8 | +1.73% (-2.29% to +16.95%) |
| media-diagnostics | vndb | 1 | yes | -0.11% | 4/8 | -1.55% (-2.94% to -0.19%) |
| media-diagnostics | vndb | 2 | yes | -1.41% | 8/8 | +0.26% (-0.87% to +1.90%) |
| crc-words | jmdict | 1 | yes | +0.43% | 3/8 | +0.70% (-1.79% to +12.32%) |
| crc-words | jmdict | 2 | yes | +0.47% | 4/8 | -1.23% (-3.12% to -0.26%) |
| crc-words | jitendex | 1 | yes | +0.57% | 3/8 | +1.85% (-2.64% to +5.09%) |
| crc-words | jitendex | 2 | yes | -2.13% | 5/8 | +1.08% (-12.36% to +9.53%) |
| crc-words | vndb | 1 | yes | -0.04% | 4/8 | -0.00% (-0.60% to +2.18%) |
| crc-words | vndb | 2 | yes | -0.59% | 5/8 | +1.55% (-3.14% to +9.36%) |

## Qualification failures

- owned-shared / jitendex / 1: {"Campaign did not publish qualified results.json": 1, "Sampled readback digest differs across arms": 1}
- owned-shared / jitendex / 2: {"Campaign did not publish qualified results.json": 1, "Sampled readback digest differs across arms": 1}

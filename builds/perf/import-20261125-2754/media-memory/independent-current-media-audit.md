# Independent audit: current native media projection memory

Run: 45642179064. Baseline: 7d1643e6147a10cb2165e9744cf0e63b59e46632. Candidate: 7a8b25a44a3fe165107ed816377cc72bb0fac67d.

All four artifact audits reconcile exactly with original markers, all 1,504 raw scans, retained package bytes, and source/correctness receipts. All 16 correctness observations pass. No observations were retried, replaced, dropped, or newly acquired. Both Jitendex replications pass the fixed memory gate. Both VNDB replications fail coverage, so the candidate does not pass the required memory qualification.

Both auditor/observer sources match original f2f08c8ee74cdea548c5c1b494ec15bf10360b46 byte for byte. Each arm has 616 packaged members, exactly four approved baseline-to-candidate differences, and identical member hashes across all four artifacts.

## Per-pair memory changes

All values are KiB of qualified sampled process-tree maxima; changes are candidate / baseline minus one. Unqualified values remain null.

| Dictionary | Replication | Pair | PSS baseline → candidate | PSS change | Private baseline → candidate | Private change | Qualified |
|---|---:|---:|---|---:|---|---:|---|
| jitendex | 1 | 1 | 1055722 → 1037977 | -1.6808% | 825180 → 807304 | -2.1663% | True |
| jitendex | 1 | 2 | 1087240 → 1049895 | -3.4348% | 854460 → 819940 | -4.0400% | True |
| jitendex | 2 | 1 | 1043376 → 1068192 | +2.3784% | 809388 → 836224 | +3.3156% | True |
| jitendex | 2 | 2 | 1062270 → 1075920 | +1.2850% | 829084 → 844156 | +1.8179% | True |
| vndb | 1 | 1 | 1421061 → 1411740 | -0.6559% | 1188860 → 1179096 | -0.8213% | True |
| vndb | 1 | 2 | None → 1427052 | null | None → 1193948 | null | False |
| vndb | 2 | 1 | None → None | null | None → None | null | False |
| vndb | 2 | 2 | 1383326 → None | null | 1152024 → None | null | False |

## Replication medians and result

| Dictionary | Replication | Median PSS change | Median private change | Raw scans | Qualified observations | Memory gate |
|---|---:|---:|---:|---:|---:|---|
| jitendex | 1 | -2.5578% | -3.1031% | 326 | 4/4 | passed |
| jitendex | 2 | +1.8317% | +2.5668% | 283 | 4/4 | passed |
| vndb | 1 | null | null | 466 | 3/4 | failed |
| vndb | 2 | null | null | 429 | 1/4 | failed |

## Coverage

| Dictionary | Replication | Observation | Covered import scans | Largest covered gap (ms) | Pre/post bracket gap (ms) | Qualified |
|---|---:|---|---:|---:|---|---|
| jitendex | 1 | A1 | 17 | 164.904016 | 6.789410 / 97.265250 | True |
| jitendex | 1 | B1 | 13 | 146.021474 | 32.304457 / 75.858044 | True |
| jitendex | 1 | B2 | 14 | 148.569258 | 22.081853 / 75.508088 | True |
| jitendex | 1 | A2 | 14 | 170.196895 | 7.859645 / 87.025083 | True |
| jitendex | 2 | B1 | 13 | 163.251545 | 76.655329 / 19.440650 | True |
| jitendex | 2 | A1 | 13 | 224.244401 | 83.277281 / 88.948808 | True |
| jitendex | 2 | A2 | 11 | 187.527807 | 57.769019 / 91.490809 | True |
| jitendex | 2 | B2 | 12 | 202.698431 | 19.465785 / 112.944032 | True |
| vndb | 1 | A1 | 48 | 161.775619 | 47.906649 / 81.060505 | True |
| vndb | 1 | B1 | 45 | 171.575019 | 29.259166 / 83.732689 | True |
| vndb | 1 | B2 | 42 | 173.296953 | 51.447005 / 6.440892 | True |
| vndb | 1 | A2 | 46 | 350.425804 | 6.159120 / 30.810581 | False |
| vndb | 2 | B1 | 42 | 324.494085 | 116.675495 / 49.009626 | False |
| vndb | 2 | A1 | 41 | 258.866332 | 104.368673 / 36.558205 | False |
| vndb | 2 | A2 | 45 | 244.012203 | 117.945740 / 129.901225 | True |
| vndb | 2 | B2 | 40 | 275.215655 | 105.866841 / 69.250356 | False |

The only qualification failures are covered-import-scan-gap-over-250ms: VNDB replication 1 A2, and replication 2 B1, A1, B2. Every observation has at least five complete scans and valid pre/post brackets. No import-window observation has an unreadable address space. Jitendex replication 2 B2 retains five unavailable reads belonging to one confirmed exited zombie; they satisfy the unchanged exception and are not counted as measured zero memory.

## Receipts and storage

Correctness receipt keys are identical across all eight observations of each dictionary, including 72 production lookup receipts per observation, sampled source-media receipts, browser identity, full row inventory, and restart checks. Chromium version: 153.0.8010.12.

All Jitendex observations: active SAH 5,459,968 bytes; total OPFS 67,466,332 bytes; non-SAH 61,977,692 bytes. All VNDB observations: active SAH 528,384 bytes (129 × 4,096); total OPFS 609,553,611 bytes; non-SAH 608,996,555 bytes. Actual allocation delta is zero in every pair, including VNDB, so the prospective 129–131-unit allowance is not needed to reconcile this cohort.

These are non-atomic sampled maxima, not exact peaks. Memory-study timing is non-authoritative. VNDB unqualified observations and replication medians remain null; the one qualified VNDB pair cannot replace failed coverage or establish promotion.

# Independent review: corrected VNDB screens

Both corrected six-block screens from workflow `45469432793` pass independent receipt and arithmetic reconciliation. Tooling is `f44fbe93a4cb2da44cf94cc2a03236acde8755a8`. Every cell retains its three excluded warmups, eighteen measured imports and two exhaustive-media diagnostics: **46 original observations total**, with no retries or dropped measured tails. This audit performs no new acquisition and does not pool these hosts or any earlier stage.

## Timing results

Negative is faster. Intervals are descriptive paired-bootstrap 95% intervals, independently recomputed from the raw native file-input-change-to-completion clocks with the frozen 10,000 resamples and seed 20261124.

| Candidate | B/A paired median [95%] | B/C paired median [95%] | Identical C/A [95%] |
|---|---:|---:|---:|
| Media PR #875 | −4.0211% [−7.4645, −0.6227] | −4.3249% [−6.7483, +0.2274] | −0.5984% [−2.9101, +2.2661] |
| Private prefix PR #874 | +0.1498% [−1.5322, +1.1304] | +0.7809% [−0.2489, +3.3681] | −1.3669% [−2.5213, −0.1805] |

| Candidate | B faster than A / C | Equal-work B/A | Equal-work B/C |
|---|---:|---:|---:|
| Media | 5/6 and 5/6 | −4.0737% | −3.6376% |
| Private prefix | 3/6 and 1/6 | −0.0846% | +1.3065% |

The media screen is a positive signal supporting the already-planned independent qualification, not sufficient evidence for promotion. Its B/C interval crosses zero. The final B observation remains included despite being slower than both baselines. The previously documented Jitendex private-memory failure remains unresolved and is not overridden by VNDB timing.

The private-prefix VNDB control shows no gain. Its unchanged A/C product also exhibits a −1.3669% median difference, reinforcing the need to inspect control variation rather than interpret isolated arm medians as improvements.

## Source, package and harness invariants

Both cells use baseline A/C `bbccabd520972cc351a65d9f545bd5369b6e9747`, tree `f81fc2c29b58f1c2329de6b8fa6b2a91015b6b07`.

- Media B: `fb71a03f4611bcfa71e135693bebd1fe778153bf`, tree `0939bd1eec85dc0b3f15ef002a8f0f5111c80103`.
- Prefix B: `ebb1da8d2cc2b28901400968891b632605f1b3f0`, tree `243ab638da9cb73e08d84609c41dcdfdf08475cd`.

The audit checks exact committed runner, workflow and storage-policy bytes; all **75 frozen harness/dependency files** against baseline, candidate and tooling Git objects; clean-source receipts; the exact six-order schedule; every observation's source and package receipt; and unchanged production defaults. Every observation uses Node 22.22.0 and Chromium 153.0.8010.12, without profiling, tracing, screenshots or process sampling.

C uses A's identical archive hash and all 550 identical package-entry hashes. A/B inventory differences match the prospective four-file media allowance or six-file prefix allowance exactly. Product ZIPs are not retained in these screen artifacts, so archive and decompressed-entry hashes are reconciled as receipts rather than independently rehashed from missing package bytes.

## Correctness and prospective storage policy

All 46 imports retain **6,648,310 rows** after restart and the same 72 canonical lookup receipts (twelve deterministic terms across six passes). The offset-sensitive probe digest also matches in every observation and both cells: `230a48feb02e7586ecff364ae58aac25d63de213cdf5047f24629857f0a08094`. This is not an exhaustive all-row canonical-content claim.

Each cell's A/B exhaustive diagnostics match all **146,570 media files / 188,131,284 bytes**, digest `ea94d392bc833baf0bee7b3d6becc3d3517eee84ee314a44986438ac6d5217cb`. Timed runs and warmups retain the same deterministic 64-file media sample.

Every non-SAH file path and size matches exactly after normalizing only the media generation UUID. Their total is **608,996,555 bytes**. Each observation has exactly eight SQLite SAH files, including seven empty 4,096-byte files. The prospective VNDB policy permits the active file to occupy 129–131 allocation units of 4,096 bytes.

- Prefix: all 23 totals are **609,553,611 bytes**, with a 528,384-byte active SAH file.
- Media: 22 totals are **609,553,611 bytes**. `block-03-1-B` totals **609,561,803 bytes**, with a 536,576-byte active SAH file. That +8,192-byte allocation variation is within the already-frozen rule; all other paths and sizes remain exact.

Raw file inventories and totals remain retained. The policy is an allocation-size allowance, not proof of identical SQLite file bytes. Earlier failed cohorts remain failed and are not pooled with these corrected observations.

## Retained supporting files

`reconcile.py` independently reconstructs schedules, raw clock durations, comparisons, bootstrap endpoints, storage classifications and correctness checks. `receipt.json` preserves every raw timing, report hash, storage total and comparison. `artifact-provenance.json` records the GitHub API-reported ZIP digests for artifacts 14958292893 (media) and 14958616835 (prefix); original artifact ZIPs were downloaded by root, and this audit used their extracted contents.

The already-planned two-host, twelve-block media VNDB qualification is separate run `45475087387`, head `2fb6c247852c64be1b836aff60b3eba5eb1acc7e`. Its results are pending this screen receipt. No memory rerun is proposed.

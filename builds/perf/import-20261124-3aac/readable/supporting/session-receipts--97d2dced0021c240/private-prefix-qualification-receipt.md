# PR #874 — private content prefix qualification

## Recommendation: HOLD

Keep the candidate draft. One independent Jitendex host shows a modest gain; the other does not establish a gain and has slower equal-work totals. Both memory replications pass the bounds frozen before acquisition, but this is not a memory reduction. The combined evidence does not establish a consistent material complete-import benefit. Do not pool the screen and qualification stages or remove tails. No further identical-code timing rerun is recommended from this receipt.

The runtime source remains `ebb1da8d2cc2b28901400968891b632605f1b3f0`, tree `243ab638da9cb73e08d84609c41dcdfdf08475cd`, against baseline `bbccabd520972cc351a65d9f545bd5369b6e9747`, tree `f81fc2c29b58f1c2329de6b8fa6b2a91015b6b07`.

## Complete-import qualification

Workflow run `45468314006`, tooling commit `eeec4c2055ed911de92ba98fdc815c8ff0444edb`, ran four independent cells: JMdict and Jitendex with forward and reverse schedules. Each cell retained three excluded warmups, twelve complete ABC blocks (36 measured imports), and two separate exhaustive media diagnostics. All 164 observations succeeded. All measured observations remain included.

The following percentages are paired medians, with descriptive 95% paired bootstrap intervals. Negative means faster. C used A's exact source, release archive, and package-entry bytes. Independent hosts remain separate.

| Dictionary / schedule | B/A | B/C | Identical C/A |
|---|---:|---:|---:|
| Jitendex / forward | −0.8208% [−2.4723, +3.3402] | −0.2010% [−3.6589, +4.6285] | −0.1098% [−2.4155, +0.7648] |
| Jitendex / reverse | −1.6260% [−2.2756, −0.5527] | −1.4761% [−2.5394, −0.0685] | +0.0428% [−1.1577, +2.3319] |
| JMdict / forward | −0.9607% [−1.7665, −0.2823] | −0.2799% [−1.6154, +0.3286] | −1.1683% [−1.7521, +0.6271] |
| JMdict / reverse | +0.7441% [−0.4657, +1.4295] | +0.0900% [−1.1507, +2.0472] | −0.0012% [−0.7284, +0.5863] |

| Dictionary / schedule | B faster than A | B faster than C | Equal-work B/A | Equal-work B/C |
|---|---:|---:|---:|---:|
| Jitendex / forward | 8/12 | 6/12 | +0.9831% | +0.3549% |
| Jitendex / reverse | 10/12 | 9/12 | −2.6941% | −1.5285% |
| JMdict / forward | 9/12 | 7/12 | −1.5835% | −0.4335% |
| JMdict / reverse | 4/12 | 6/12 | +1.5174% | +1.6091% |

The forward Jitendex cell includes substantial candidate and identical-control variation: the worst B/A pair was +13.8712%, and the largest identical C/A increase was +15.0453%. Its intervals and positive equal-work changes prevent treating the lower candidate median as an established benefit. The reverse cell supports a small gain on that host. JMdict, which uses the existing shared path, is inconclusive overall; its forward B/A improvement is also present in the unchanged-code control.

## Memory qualification

Workflow run `45468614083`, tooling commit `a96671c223ed1e7ed49f0c96427b2ef09229f4cc`, retained two separate Jitendex replications: ABBA and BAAB. Each has exactly four observations, with no retries or replacements. Both required replications passed.

The prospective limits were at most +5% paired-median increase and at most +10% in any individual pair, separately for sampled PSS and private bytes. Every observation had to satisfy the original coverage rules. These are sampled import-window bounds, not exact peak measurements.

| Replication | PSS median paired change | PSS worst pair | Private median paired change | Private worst pair | Result |
|---|---:|---:|---:|---:|---|
| 1 — ABBA | +0.6794% | +3.3597% | +0.8814% | +4.5753% | Pass |
| 2 — BAAB | +3.6625% | +4.9013% | +4.2566% | +5.5697% | Pass |

All 808 raw scans were independently reconciled: 359 in replication 1 and 449 in replication 2. Each observation had 14–23 stable, fully contained import scans. Maximum covered gaps were at most 183.570 ms, below the frozen 250 ms limit; pre/post brackets also satisfied the limit. Sampling retained process identities, parentage, before/after discovery, unavailable reads, and original marker bytes.

Replication 1's B2 observation contains seven unavailable-smaps records for one confirmed exited zombie identity. Every exclusion has the original same-PID/start-time, single-thread Z-to-Z, executable ENOENT, and smaps ESRCH evidence. No unreadable live address space was assigned zero. The independent audit recomputed per-process PSS/private sums, scan qualification, covered-window maxima, and all paired changes. Instrumented memory timings were not used for speed comparisons.

## Correctness and provenance

The timing cells independently reconciled exact source identities, unchanged harness hashes, fixture locks, production defaults, Node 22.22.0, Chromium 153.0.8010.12, fixed schedules, complete observation lists, and the exact six-file package difference allowance. Every paired percentage, equal-work ratio, and bootstrap endpoint was recomputed from the retained native timing values.

For memory cells, both retained product archives were rehashed and all decompressed package entries were compared with their retained inventories. Observer, workflow, and dependency source hashes matched their frozen plans. The only dirty runtime-checkout path was the explicitly recorded test harness marker overlay; both arms used the same overlay. No production file was changed for memory acquisition.

Every timing and memory import passed the full expected row-count and restart checks. The 72 canonical production lookup receipts matched across observations and arms. This covers twelve deterministic terms across six lookup passes, not exhaustive canonical content for every row.

Exhaustive Jitendex diagnostics matched all 236 media files and 4,992,155 bytes. JMdict has no media in this lock. OPFS totals and individual file sizes matched exactly after normalizing only random SQLite opaque filenames:

- JMdict: 43,520,477 bytes.
- Jitendex: 67,466,332 bytes.

The offset-sensitive probe digest intentionally differs for Jitendex B because it includes `rawEntryContentOffset`; each arm's digest remains stable across restart and observations. Canonical lookup receipts remain equal. Entire final sidecar bytes are not claimed identical: the prefix layout relocates content references and corresponding record fields/checksums.

## Activation diagnostics

The first activation workflow `45468163108` failed due to instrumentation of the fallback owner instead of the production offscreen owner; Jitendex separately timed out before browser startup. All original failures remain retained. Corrected workflow `45470204352`, tooling commit `200b8680bad62e9f40b015ceebebc7382b54dd4b`, completed all four jobs successfully. Every captured phase explicitly identifies the production offscreen owner. Runtime source remained frozen.

| Diagnostic | Attempts | New private admissions | Private prefix placements | Guard suffix fallbacks | Existing shared admissions |
|---|---:|---:|---:|---:|---:|
| Prefix / Jitendex | 22 | 21 | 21 | 0 | 0 |
| Prefix / JMdict | 12 | 0 | 0 | 0 | 12 |
| Prefix / VNDB | 170 | 0 | 0 | 0 | 0 |

Jitendex's raw sequence is exactly one owned private, unforced selection attempt, followed by 21 attempt → begin → prefix groups. All private begins have `initialSelection: false`. Their selected unique content totals 372,728,692 bytes across 351,495 entries; eligible owned source slabs total 372,749,014 bytes. For every placement, the primary frame start equals the reservation start plus 20 bytes per unique entry, and the codec-bound final cursor remains at or below `0xfffffffe`. No real-fixture high-offset fallback was exercised; that case is covered by the focused synthetic-cursor tests.

JMdict retains twelve shared admissions, including exactly one initial shared selection. VNDB has 170 private-source attempts with no compression dictionary, including two unforced attempts followed by 168 forced attempts; none enters the new dictionary-specific reservation route. These are positive shared-path and negative private-path controls, respectively.

PR #876's separate JMdict diagnostic at `cdb23a11d991a72f860e400d0d81bb0747a5b4f9`, tree `1edef4035041ef848175e3278169daf2260ac34a`, records twelve publisher/receiver pairs. Every receiver immediately follows its matching publisher, and all twelve reuse a true contiguous-range publication proof. These cover 362,032 unique entries and 101,143,985 source bytes.

All four downloaded artifact ZIPs were independently SHA-256 verified. The audit reconciled committed instrumentation, workflow and summarizer bytes; exact source identities; unchanged harness hashes; prepared fixture hashes; package-hash receipts; report hashes; Node 22.22.0 and Chromium 153.0.8010.12; raw event order; complete row counts and restart; 72 canonical lookup receipts per import; and exact per-file logical sizes after normalizing only media generation UUIDs and SQLite opaque basenames. All comparisons pass. The diagnostic product ZIPs are not retained in these artifacts, so package-hash receipts are reconciled with each other rather than independently rehashed from product bytes.

These four instrumented observations are **non-authoritative for timing**. The unchanged generic harness still labels its ordinary timing boundary authoritative; the instrumentation overlay and activation summary explicitly override that interpretation. Activation proves actual route coverage and leaves the **HOLD** recommendation unchanged.

## Retained evidence

- `/workspace/scratch/3aacd533c01f/round2/prefix-timing-qualification-independent-review.json`
- `/workspace/scratch/3aacd533c01f/round2/prefix-memory-qualification-independent-review.json`
- `/workspace/scratch/3aacd533c01f/round2/prefix-qualification-artifact-provenance.json`
- `/workspace/scratch/3aacd533c01f/round2/activation-failures-45468163108/diagnosis.md`
- `/workspace/scratch/3aacd533c01f/round2/activation-corrected-45470204352/independent-review.json`
- `/workspace/scratch/3aacd533c01f/round2/activation-corrected-45470204352/activation-receipt.md`

The artifact provenance file records the GitHub-reported archive digests and tooling commits for all six cells. Raw artifacts remain under `/workspace/scratch/3aacd533c01f/round2/artifacts/` with their original workflow-derived names. This receipt was produced entirely from retained evidence; it performed no new browser, import, timing, or memory acquisition.

# Indexed score validation: complete browser qualification

**Decision: hold; no performance PR.** The two-line loop restoration passes source and semantic checks, but the completed cohort does not establish a useful complete-import speedup on any corpus. All unfavorable observations and failed memory coverage remain part of the result.

## Source and protocol

- Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
- Candidate: `79a9e1abbeff1a56bcc20cb958f03290c0fa0711`, tree `4ecebc3a54f8ae865ae3f98943695fa9cbb8341d`.
- Frozen workflow: `55cd5bc4fa19348281ca13f082c9cf3b3e64f848`, tree `b1ec05e7ebb817d2b2af5654bdd56ce893216f29`.
- [Complete acquisition run](https://github.com/ManabiIO/manabitan/actions/runs/46106190962).

The candidate restores indexed Uint16 score-key traversal that had been introduced in #944 and then replaced by a `for...of` loop during the #897 integration. Exactly one packaged entry changes: `js/dictionary/term-record-opfs-store.js`, candidate Git blob `b17f72437f196aa1fd21b282c03f147aad7d633f`. There is no new WASM module or storage-format change.

Each corpus runs on its own host with four excluded warmups, six alternating AB/BA treatment pairs, two interleaved identical-code control pairs, two separate exhaustive-media imports, and four separate memory imports: 26 observations per corpus, 78 total. Every import uses a fresh profile. Actual parser-worker count is three throughout; VNDB's prospectively fixed allocation is 37 units. Existing defaults are used without experiment overrides.

The primary clock is browser-side file-input change through the import completion signal. Automation observation time and overlapping phase counters are distinct. Memory instrumentation runs only after ordinary timing and media checks. No host pooling, control subtraction, outlier deletion, or replacement observations are used.

## Complete-import timing

Positive values mean slower. Intervals are the registered descriptive percentile bootstrap intervals of paired median ratios, with 10,000 complete-pair resamples and seed 897.

| Corpus   | Median paired change | Equal-work change | Faster pairs | Descriptive 95% interval | Identical-code median |
| -------- | -------------------: | ----------------: | -----------: | -----------------------: | --------------------: |
| JMdict   |              -1.112% |           +1.152% |          4/6 |       [-2.311%, +7.120%] |               -6.196% |
| Jitendex |              -0.440% |           -0.031% |          4/6 |       [-1.746%, +2.139%] |               -0.634% |
| VNDB     |              +0.358% |           +0.629% |          3/6 |       [-4.174%, +6.250%] |               +8.832% |

JMdict retains a +13.220% candidate pair and a -12.711% identical-code pair. VNDB retains a +10.112% candidate pair and +15.378% identical-code pair. The favorable control drift on one host and unfavorable drift on another are not adjustments to the candidate results. Warm component improvements do not override these complete-import findings.

An independent concurrent study used an identical candidate runtime tree in [run 46104264150](https://github.com/ManabiIO/manabitan/actions/runs/46104264150). It also did not establish a replicated complete-import gain. Its hosts, schedule and observations are not pooled into this study.

## Correctness, storage, memory and source gates

Independent validation passes every source/package, work-count, stored-content, storage-layout, media, restart and lookup receipt across all 78 observations. Both release packages were checked against their complete entry maps and the frozen changed-source blob before timing arithmetic was accepted. Exhaustive media checks retain the expected Jitendex and VNDB file counts and byte totals. The full source gate passes 669 unit files (15,135 tests passed, 47 existing skips), full JavaScript lint, all four TypeScript projects, and all-target dry builds.

JMdict's four memory observations qualify across 257 raw scans, and VNDB's four qualify across 632. Their registered memory screens pass. Jitendex preserves 274 scans, but B1 and A2 have covered scan gaps of 416.531 ms and 335.425 ms, above the fixed 250 ms requirement. Both Jitendex memory comparisons remain null; its browser job and overall workflow therefore remain failed qualifications. These are observation-coverage failures, not measured memory regressions, and they were not retried or imputed.

The sampler in this original cohort remains the frozen serial acquisition. A later parallel acquisition design belongs only to a different prospective study and does not change this result.

## Retained evidence and reproduction

`index.json` binds the original GitHub artifact IDs and digests, the reduced observation archives, and every original member's content digest. The three `*-observations.zip` archives preserve all 597 non-package members exactly, including every raw report, memory scan, failure, plan, source identity, complete package-entry map and log. They omit only the two release package ZIPs from each original artifact; their exact archive digests are retained in the member census. The full original artifact ZIPs remain in the working results and in the linked acquisition's artifact retention. No timing or memory observation is omitted.

The `*-independent-audit.json` reports retain all 26 validated observations per corpus, paired arithmetic, phase diagnostics and independent memory audit. `source-job-status.json` records final job outcomes, and the two `hosted-*.log` files retain the decoded complete source-gate logs.

To repeat the complete package-bound audit, extract an original full GitHub artifact, including `package-A.zip` and `package-B.zip`, and run `audit-score-browser.py EXTRACTED_DIRECTORY --out RESULT.json` from a checkout containing the pinned fixture lock and qualification helpers. The copied auditor changes only its repository-root locator to be portable. The reduced observation archive alone cannot rerun the original release-archive byte check without those two package files.

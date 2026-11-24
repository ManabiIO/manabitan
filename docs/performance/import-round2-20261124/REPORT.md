# Manabitan import optimization evidence — round 2

This report covers three independent candidates based on frozen `develop` commit `d24b4e56ceb1fe14ad96ef3853f4d397efa6fa26`. They remove specific repeated work and pass the recorded correctness gates. All nine completed browser screens do **not** establish a complete-import performance improvement. None of these candidates is qualified for a speed or peak-memory claim.

## Published sources

| Candidate | Pull request | Frozen published head | Main CI |
| --- | --- | --- | --- |
| Sequence index | [#862](https://github.com/ManabiIO/manabitan/pull/862), draft | `ec4e81395a1eb0f6f5fbf4f6d4c591201887e8cf` | [45352630251](https://github.com/ManabiIO/manabitan/actions/runs/45352630251) |
| Media bookkeeping | [#863](https://github.com/ManabiIO/manabitan/pull/863), draft | `ebb0777114578c5cee879877274e7d872bfea27e` | [45352943424](https://github.com/ManabiIO/manabitan/actions/runs/45352943424) |
| Canonical counters | [#864](https://github.com/ManabiIO/manabitan/pull/864), draft | `d147a60fc4845e898d98d8924968d6094b417007` | [45353056708](https://github.com/ManabiIO/manabitan/actions/runs/45353056708) |

Each published head has the exact baseline as its immediate parent. These changes are not stacked. [Publication identities](publication-identities.json) preserve full local/published commits, equal trees, changed file blobs, and study tooling identities. Canonical's local history contains a separate test-style commit; its final tree equals the published tree.

## What the changes remove

**Sequence index.** Increasing sequence IDs append directly; the first decrease initializes and backfills the existing hash table. Repeated and absent IDs retain their behavior, and the original output layout and first-encounter order remain intact. The [full corpus oracle](components/sequence/corpus-oracle.json) covers 7,613,164 rows in 937 banks with exact parser/content/key/index/media-projection byte parity and independent JSON-derived checks. Under its fixed four-bank component grouping, JMdict avoids 200,916 interner hashes and 1,605,632 scratch-clear bytes; Jitendex avoids 211,563 and 901,120; VNDB avoids 167 and 21,790,720. Scratch capacity is unchanged.

The [component screen](components/sequence/lookup-component.json) is exploratory resident-call timing on a shared host. Its first-four-bank B/A and B/C medians were −3.92%/−1.93% for JMdict, +0.78%/−4.29% for Jitendex, and +2.01%/+0.59% for VNDB. A late-first-decrease control was slower by +6.03%/+6.89%. The fallback tradeoff and all control observations remain in the packet; these calls omit compression, persistence, and browser scheduling.

**Media bookkeeping.** Projected image requirements reuse an owned diagnostic arena, dense ZIP entries receive their reader directly, and already ordered media records avoid a copied sort. The [component summary](components/media/vndb-bookkeeping-component-summary.json) and [independent audit](audits/media-components-independent.json) establish that the locked archive's 147,237 catalog entries avoid that many temporary assignment objects; its 146,570 physically ordered images avoid one reference-array copy and 146,569 sort comparisons. All 188,131,284 decoded media bytes pass CRC checks, and the complete 195,649,882-byte pack, index, descriptors, record order, and read metrics match.

The per-bank replay covers all 665 VNDB banks and 6,648,310 rows. It removes 147,186 diagnostic-entry wrappers while preserving selected typed fields, content, lookup bytes, requirement order, and diagnostics after subsequent native-arena reuse. An intentionally all-unique deferred scenario avoids another 293,140 requirement/source clones. Browser grouping and prefetch choices can change these counts; they describe source-level object creation, not measured allocation bytes or peak memory. Unordered inputs retain the sorted-copy fallback and existing integrity checks.

**Canonical counters.** Five working counters remain local until return or explicit trap boundaries. Journal-progress publication, barriers, authoritative mutation order, and the private ABI remain unchanged. The [canonical evidence](components/canonical/canonical-local-counters-EVIDENCE.md) covers all 436,555 Jitendex rows and 55 native calls with complete header/configuration/journal/output/arena parity, excluding the compiler's private stack. Those calls imply 1,089,805 repeated counter stores become 275 boundary stores; initial header stores and journal-progress stores are excluded and unchanged. This is a source-derived statement count, not an instruction or latency measurement.

Its native-only screen yielded wall-time B/A −5.54%, B/C −0.19%, and same-code C/A −6.44%; process-CPU effects were −5.66%, −0.77%, and −5.58%. The two slower A rounds, 80.92 and 97.66 ms, remain included. The control drift prevents attributing a gain. Parser WASM grows by 221 bytes in #862; canonical WASM grows by 136 bytes in #864. Both reproduce with pinned Clang/LLD 21.1.8; #863 changes no native binary.

## Validation gates

| Candidate | Focused tests passed | Full local suites | Full tests passed / skipped |
| --- | ---: | ---: | ---: |
| [Sequence](components/sequence/validation-summary.json) | 107 | 642 | 14,427 / 47 |
| [Media](components/media/vndb-bookkeeping-component-summary.json) | 140 | 641 | 14,414 / 47 |
| [Canonical](components/canonical/canonical-local-counters-EVIDENCE.md) | 59 | 642 | 14,437 / 47 |

Final scoped lint, applicable type checks, all-target dry builds, and native reproduction gates pass. Full units used unchanged timeouts. Earlier development attempts remain preserved separately from these final results.

The [frozen-head CI audit](ci/audit-summary.json) records 15 successful executed main jobs and four expected skipped jobs per PR. JavaScript/CSS/HTML/Markdown/JSON checks, all four TypeScript targets, unit/options tests, pinned native reproduction, Chromium/Firefox extension tests with enforcement and JSON uploads, and Chromium Anki deduplication ran. CodeQL, actionlint, and static web acceptance also passed. Separate witnessed restart/interruption campaigns passed for [#862](https://github.com/ManabiIO/manabitan/actions/runs/45352630091), [#863](https://github.com/ManabiIO/manabitan/actions/runs/45352943634), and [#864](https://github.com/ManabiIO/manabitan/actions/runs/45353056824).

Edge, both Android jobs, and published-release upgrade/reimport are dispatch/release-gated and skipped. Release-package retention and failure/manual HTML-report uploads were also inapplicable. Dependency Review's workflow succeeded through its explicit unavailable branch: the dependency vulnerability scan did **not** execute. This CI audit verifies execution/enforcement receipts and retained logs, not independently downloaded CI browser/restart artifact payloads.

## Frozen browser protocol and inputs

Each screen uses six predeclared block orders: ABC, CBA, BAC, CAB, BCA, ACB. A is the frozen baseline, B is one candidate, and C is the same A product/package. There are 18 measured imports plus separate A/B all-media diagnostic imports. Fresh profiles and production defaults are used. Timing spans file-input change through post-UI completion on the browser monotonic clock. No tracing, screenshots, phase profiling, process sampling, retries, excluded warmups, or discarded tails are used.

The [protocol](browser/screen/monotonic-sequence-jmdict/protocol.json) and [audit aggregate](audits/v2-all-available-results.json) bind sources, package manifests, 66 frozen harness/tooling files, and nine emitted harness files per observation. Hosted runs use Node 22.22.0 and Chromium 153.0.8010.12. Runner SHA-256 is `81931ea66937ebdf7fc55c6cdac2998a54d364485de7aae19909beef5aaa917b`; unchanged browser-harness SHA-256 is `d0ae122bd22f7b460cedb11f06d2cb018224674abf9669e0fed567b5f3a870cf`. Tooling commits differ by dispatch and remain recorded individually.

| Locked source | Archive bytes | Term rows | Referenced images / decoded bytes | Archive SHA-256 |
| --- | ---: | ---: | ---: | --- |
| [JMdict 2026-11-22](browser/baseline/jmdict/fixture.json) | 15,645,766 | 528,299 | 0 / 0 | `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f` |
| [Jitendex 2026.10.03.0](browser/baseline/jitendex/fixture.json) | 38,831,822 | 436,555 | 236 / 4,992,155 | `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356` |
| [VNDB Characters by Bee 1.0.0](browser/baseline/vndb/fixture.json) | 291,705,969 | 6,648,310 | 146,570 / 188,131,284 | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` |

Jitendex's archive also contains 13 images excluded by the lock's unreferenced-media list. Baseline snapshots from [run 45351292649](https://github.com/ManabiIO/manabitan/actions/runs/45351292649) are separate diagnostics: ordinary timings were JMdict 872.0/800.5/701.4 ms, Jitendex 1596.7/1902.6/1650.2 ms, and VNDB 4843.5/4842.6/4789.9 ms. Their reported storage totals were 43,520,477, 67,466,332, and 609,553,611 bytes respectively. These are neither comparison cohorts nor peak-memory measurements.

## Completed browser screens

Effects below are medians of six paired percentage changes, with descriptive 95% bootstrap intervals in brackets: 10,000 paired resamples, seed 20261123, no multiplicity correction. Negative means faster. B/A and B/C must be assessed alongside identical-product C/A drift. [Sequence dispatch](https://github.com/ManabiIO/manabitan/actions/runs/45352695368) and [media/canonical dispatch](https://github.com/ManabiIO/manabitan/actions/runs/45353118407) are independent cohorts; none is pooled with baseline or component timings.

| Screen and complete analysis | B/A % [interval] | B/C % [interval] | C/A % [interval] |
| --- | ---: | ---: | ---: |
| [Sequence · JMdict](browser/screen/monotonic-sequence-jmdict/analysis.json) | −1.03 [−11.73, 2.47] | −1.52 [−3.58, 1.09] | −0.00 [−10.44, 4.30] |
| [Sequence · Jitendex](browser/screen/monotonic-sequence-jitendex/analysis.json) | +0.61 [−3.43, 8.13] | +4.14 [−0.66, 19.39] | −3.39 [−11.81, 0.68] |
| [Media · JMdict](browser/screen/media-bookkeeping-jmdict/analysis.json) | −4.06 [−6.76, 12.45] | −0.74 [−5.96, 13.26] | −0.26 [−6.37, 1.91] |
| [Media · Jitendex](browser/screen/media-bookkeeping-jitendex/analysis.json) | −0.81 [−6.08, 0.98] | +0.80 [−3.48, 7.02] | −3.68 [−9.77, 3.95] |
| [Canonical · JMdict](browser/screen/canonical-counters-jmdict/analysis.json) | −1.07 [−2.58, 1.20] | −0.40 [−11.60, 1.95] | +0.88 [−3.35, 12.50] |
| [Canonical · Jitendex](browser/screen/canonical-counters-jitendex/analysis.json) | −1.15 [−2.87, 0.05] | −0.40 [−2.32, 1.83] | −1.36 [−2.32, 0.62] |
| [Sequence · VNDB](browser/screen/monotonic-sequence-vndb/analysis.json) | −3.11 [−8.90, +2.46] | +0.76 [−1.32, +4.46] | −4.53 [−11.75, +3.54] |
| [Media · VNDB](browser/screen/media-bookkeeping-vndb/analysis.json) | +0.48 [−3.19, +5.71] | +1.01 [−1.18, +7.28] | −1.93 [−5.67, +3.97] |
| [Canonical · VNDB](browser/screen/canonical-counters-vndb/analysis.json) | −0.35 [−13.06, +1.18] | +0.78 [−3.53, +1.81] | −1.03 [−10.55, −0.27] |

| Completed screen | A / B / C median ms | Equal-work B/A / B/C / C/A % | Faster pairs B/A / B/C / C/A, each of 6 |
| --- | ---: | ---: | ---: |
| Sequence · JMdict | 946.50 / 941.50 / 949.70 | −4.01 / −1.34 / −2.71 | 3 / 4 / 3 |
| Sequence · Jitendex | 1887.20 / 1904.55 / 1828.90 | +1.78 / +7.62 / −5.42 | 3 / 1 / 5 |
| Media · JMdict | 1005.85 / 988.25 / 994.70 | +0.30 / +2.08 / −1.75 | 4 / 3 / 4 |
| Media · Jitendex | 1457.00 / 1424.80 / 1398.70 | −2.10 / +1.33 / −3.39 | 4 / 2 / 4 |
| Canonical · JMdict | 959.75 / 951.60 / 958.65 | −0.83 / −4.05 / +3.35 | 4 / 3 / 3 |
| Canonical · Jitendex | 1840.60 / 1821.45 / 1823.25 | −1.34 / −0.32 / −1.02 | 5 / 4 / 5 |
| Sequence · VNDB | 6887.60 / 6730.90 / 6729.45 | −3.57 / +1.28 / −4.79 | 5 / 2 / 4 |
| Media · VNDB | 6760.25 / 6702.40 / 6666.20 | +1.01 / +2.33 / −1.29 | 3 / 2 / 3 |
| Canonical · VNDB | 5466.75 / 5380.90 / 5434.85 | −4.95 / −0.36 / −4.61 | 4 / 2 / 6 |

Equal-work effects use ratios of summed times, so retained tails can change their direction. Those tails include sequence JMdict A1156.2 ms; sequence Jitendex A2280.4/B2375.7 ms; media JMdict B1228.2 ms; and canonical JMdict C1177.9 ms. Media/JMdict's negative paired median coexists with slower total equal work. Every B/A and B/C interval crosses zero. VNDB also retains its sequence A8341.1 ms, media B7511.2 ms, and canonical A6960.8 ms tails. Its canonical same-code C/A interval is entirely below zero, demonstrating drift even when the product is identical. No screen warrants independent qualification. The linked analyses retain all 162 measured observations and all paired changes. Overlapping phase/worker counters cannot be summed into a wall-time budget.

## Audit scope and retained evidence

All twelve available packets pass the [independent strengthened audit](audits/v2-all-available-results.json): 192 successful imports, 13,824 lookup receipts, and 21 separate all-media diagnostics. Inventory, storage, restart, and source-media receipts are checked. Terms use **12 sampled probes across six lookup passes per import**, not exhaustive term semantics. Exhaustive media checks are separate from ordinary sampled-media checks.

The [auditor review](audits/v2-independent-review.json) records 37 rejection controls and two implementation corrections: matching the runner's phase projection, and handling canonical's local test-style commit while requiring exact published parent/tree identity. Earlier validator logs remain preserved; benchmark packets and observations were unchanged.

Original downloaded [artifact ZIPs](browser/original-artifacts/) retain every raw observation, including tails, logs, receipts, and diagnostic runs; the report duplicates only selected top-level summaries. Their digests, CRCs, safe membership, and extracted contents are audited. These evidence ZIPs are distinct from product release ZIPs, which are not retained. Product verification checks reported archive identities, retained manifests, changed runtime hashes against frozen Git, and per-run package digests; it does not independently rebuild or inspect every release ZIP entry.

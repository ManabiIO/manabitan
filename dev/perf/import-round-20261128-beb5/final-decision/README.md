# Final current-baseline decision: no performance PR

**Do not promote either candidate. Retain both as held research.** The fixed current-baseline studies establish correct outputs and useful diagnostic evidence, but neither candidate demonstrates a repeatable complete-import gain across the requested dictionaries. JMdict, the priority corpus, has an adverse paired median in both current studies. The canonical checksum mechanism consistently reduces its owning write-phase counter, but that does not justify its integration cost without an established benefit to the completed import.

This is a decision about these exact candidates and the evidence collected in this round. It is not a claim that every future checksum implementation is ineffective, or that an interval crossing zero proves no possible benefit. No replacement measurement, combined candidate, tuning change or additional cohort is proposed.

## Exact scope

Both studies use baseline `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`, after PR #972. The candidates are separate:

| Candidate | Runtime | Frozen browser study | Start order |
| --- | --- | --- | --- |
| Disable unrolling of the existing eight-lane CRC loop | `19db774b564064a7e339d3c3a79ea8da04ab48b5` | `477fb271ef25fac533fb1faf737a5dab898190e3` / [run 46127721419](https://github.com/ManabiIO/manabitan/actions/runs/46127721419) | AB |
| Three-stream native checksums inside the existing canonical module | `dcbbab6d1bfcebede50969f6d4b23e4f09561aa3` | `07307bed49e6fd80ec28c37e0313a6bff402b66f` / [run 46128439514](https://github.com/ManabiIO/manabitan/actions/runs/46128439514) | BA |

Each corpus has its own fixed host/cohort, 12 treatment pairs, four separate identical-code control pairs, four planned warmup observations, two exhaustive-media observations and four memory observations. All 42 source/package/output/storage/media receipts per corpus pass. Actual parser-worker count is three in every audited observation. The six local raw-artifact audits agree with their original CI audit reports.

The arithmetic below was independently reconstructed from the unfiltered ordinary observations. [recompute.py](recompute.py) verifies the exact source identities, packaged member changes, complete pair schedules and agreement with the reported ratios. [recomputed-inputs.json](recomputed-inputs.json) preserves every pair, the absolute differences, input hashes and separately reported controls. The descriptive bootstrap intervals are taken from the frozen auditors; they are not a guarantee across hosts.

## Complete-import results

Negative values mean faster. “Equal work” is the ratio of summed candidate times to summed baseline times; it is reported alongside the median of paired ratios, not selected in preference to it.

| Candidate | Corpus | Paired median | Equal work | Median absolute difference | Faster pairs | Descriptive 95% interval | Memory |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| CRC pragma | JMdict | +1.628% | −0.496% | +14.90 ms | 4/12 | [−0.525%, +2.850%] | Unqualified coverage |
| CRC pragma | Jitendex | +2.368% | +2.089% | +27.50 ms | 3/12 | [−0.090%, +3.349%] | Pass |
| CRC pragma | VNDB | −0.234% | −1.028% | −11.60 ms | 6/12 | [−2.297%, +1.805%] | Pass |
| Canonical checksum | JMdict | +0.922% | −1.486% | +9.65 ms | 5/12 | [−1.579%, +1.987%] | Pass |
| Canonical checksum | Jitendex | +0.167% | +0.238% | +2.70 ms | 6/12 | [−1.061%, +1.472%] | Pass |
| Canonical checksum | VNDB | −0.001% | −0.484% | approximately 0 ms | 6/12 | [−3.035%, +2.271%] | Unqualified coverage |

Current raw audits: CRC [JMdict](../current-browser/crc/jmdict/local-independent-audit.json), [Jitendex](../current-browser/crc/jitendex/local-independent-audit.json), [VNDB](../current-browser/crc/vndb/local-independent-audit.json); canonical [JMdict](../current-browser/canonical/jmdict/local-independent-audit.json), [Jitendex](../current-browser/canonical/jitendex/local-independent-audit.json), [VNDB](../current-browser/canonical/vndb/local-independent-audit.json).

### Controls and retained tails

The identical-code controls remain separate observations. Their paired medians are +0.483%, −0.683% and −3.298% for CRC JMdict/Jitendex/VNDB, and −0.727%, +2.843% and −0.679% for the canonical study. Their absolute medians are respectively +4.35, −8.25, −171.40, −7.75, +47.15 and −39.05 ms. These changes show that host/order variability is material at the scale of the proposed complete-import gains. None is subtracted from treatment.

The conflicting JMdict estimators are explained by the retained observations, not resolved by discarding them. CRC pair 10 is A 1117.7 ms versus B 918.6 ms, a −199.1 ms difference. Canonical pair 12 is A 1307.8 ms versus B 1067.2 ms, a −240.6 ms difference; pair 9 also contributes −74.7 ms. These observations pull the summed-time ratios downward while the paired medians remain positive. CRC VNDB similarly retains its −600.5 ms pair 7. Canonical VNDB retains both a −421.5 ms pair and a +429.7 ms pair. All scheduled observations remain in the decision.

## What improved, and what did not translate

### CRC: the Node component signal did not become a browser import gain

The [original production-module Node screen](../crc-component/README.md), on the older `9e10d3b3` baseline, measured a −4.149% first-pass median in allocation, input copying, inflation and immediate CRC work. It was a serial owning-work component study, not a concurrent Chromium import measurement.

On current Chromium imports, the corresponding `parserSourceInflateMs` diagnostic has medians of **+10.135% for JMdict, +10.234% for Jitendex and +0.954% for VNDB**. Jitendex is slower in all 12 treatment pairs for this counter. The counter includes immediate whole-bank CRC; it is not an isolated CRC timer. Deferred CRC is a separate parsing counter. The current browser evidence does not support carrying the Node improvement into a product speed claim.

This candidate is inexpensive in source terms: one pragma, the rebuilt native module and the updated build manifest. That low maintenance cost does not supply a missing performance benefit. The uncompressed WASM becomes 1,021 bytes smaller, from 69,068 to 68,047 bytes. This is not a download-size saving: the compressed WASM member grows by 55 bytes and the release ZIP grows by 74 bytes in the verified package comparison.

### Canonical checksum: consistent write-phase benefit, no confirmed complete-import benefit

The current `termRecordWriteMs` diagnostic improves in every treatment pair of each corpus:

| Corpus | Write-phase paired median | Median absolute phase difference | Faster phase pairs |
| --- | ---: | ---: | ---: |
| JMdict | −25.588% | −17.50 ms | 12/12 |
| Jitendex | −33.495% | −29.90 ms | 12/12 |
| VNDB | −10.408% | −78.85 ms | 12/12 |

This is useful mechanism evidence. However, this counter includes append/write work as well as checksumming, and its exact isolated checksum contribution is not identified. JMdict's identical-code write-phase median also falls by 18.644%; those numbers are not subtracted. Phase counters overlap other work and do not identify how much time was removed from the import's critical path. The measured complete-import medians remain +0.922%, +0.167% and approximately zero.

The [older JMdict complete-import study](../hosted-audit/canonical-jmdict/independent-audit.json) on `9e10d3b3` had a −1.097% median, 10/12 faster pairs and a wholly negative descriptive interval. That justified one separately frozen current-baseline confirmation. The current result does not repeat that signal. The baseline, host and initial order differ; this comparison does not attribute the change to PR #972 or to any single environmental factor. Old and current observations are not pooled.

The implementation avoids a new module and arena growth by using reserved space in the existing canonical module. Nevertheless, it adds optional native exports, scratch/state layout, ownership and alias admission, captured-intrinsic handling, fallback behavior and session lifecycle integration. The exact current diff has seven product files plus one regression-test file, 390 product-line insertions and 407 test-line insertions. Uncompressed canonical WASM grows from 1,624 to 6,206 bytes; this raw-module figure is not a compressed download claim. Given the absent current complete-import gain, I do not consider that maintenance burden justified for a performance PR in this round.

## Correctness and memory qualification

Both candidates pass their complete source/unit qualifications. CRC has 669 passing unit files, 15,139 passing tests and 47 skipped tests; canonical has 670 files, 15,151 passing tests and the same 47 skipped tests, including the original 12 checksum regression cases. Full JavaScript checks, all four type projects, pinned native reproduction, all-target dry builds and JSON formatting pass. CRC also passes 837 deterministic vectors, 157 production-source cases and all 53 JMdict banks across 12 groups. See the retained [CRC gates](../crc-current-source/local-gates-summary.json) and [canonical gates](../canonical-current-source/local-gates-summary.json). These checks support the tested semantics; they are not evidence of a speedup.

The unchanged memory coverage requirement is 250 ms. CRC JMdict B1 has a 349.048089 ms covered-scan gap; canonical VNDB A1 and B1 have gaps of 373.125723 and 328.369735 ms. Each of those memory observations is unqualified. The second pair qualifies in both affected studies, but the aggregate memory metrics remain unavailable. The other four corpus/candidate combinations pass their memory screens.

These are acquisition-coverage failures, not measured memory regressions. No missing scan is assigned a zero, no failed observation is replaced, and no threshold is relaxed. The timing evidence already fails to establish a review-worthy gain independently of these incomplete memory qualifications.

## Decision and retained evidence

The disposition for both exact candidates is **HOLD / no product PR**. The CRC mechanism failed to transfer its component benefit to the actual target pipeline. The canonical mechanism achieved a consistent write-phase improvement but did not establish a current complete-import benefit large or repeatable enough to justify its added integration surface. Preserve the code and complete unfavorable evidence; do not combine their phase numbers or suggest additive gains.

The bounded [native inflater follow-up](../inflater-followup/README.md) found no further concrete removable operation justified by the existing source/profile evidence. It proposed no new implementation or timing run.

[decision.json](decision.json) records the conclusions, source and evidence identities, current-versus-original distinction, limitations and memory failures. The arithmetic reproducer operates on retained audits only; it never runs an importer:

```sh
python3 recompute.py --input-root ../current-browser --out recomputed-inputs.json
```

The durable browser archives preserve every original member except the two previously audited package ZIPs; original outer hashes, full member censuses, omitted package identities and source/package maps are retained. Repeating a full package-byte audit requires those original packages. This report's arithmetic can be reproduced from the retained local audits and the original CI audit inside each reconstructed archive. No new performance claim is inferred from the archival work.

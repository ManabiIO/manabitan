# Round seven: import optimization review — September 16, 2026

## Retained change

[PR #45](https://github.com/ManabiIO/manabitan/pull/45) retains targeted native string-scanner inlining. The production diff changes only the `parse_string_span` declaration to `static __attribute__((always_inline)) inline int`; its body and parsing semantics are unchanged. The PR also adds 23 actual-WASM caller/grammar tests. There are no runtime flags, new dependencies, new SIMD requirements, cache changes, larger batches, worker-count changes or storage/compression format changes.

Independent twelve-pair production comparisons measured **1.368% lower JMdict runtime and 3.184% lower Jitendex runtime**, with **10/12 pairs faster for each**. With #44 present in both arms, separate comparisons measured -1.798% / -2.952%, with 9/12 and 11/12 pairs faster. The improvement is modest and noisy; it is not a guarantee for every import or device. No PR was merged.

Qualified head: `8b14c7528ed33707681068d652144f7e59fac018`, tree `c793d71543d65affd33b30304d34a153ee686a68`. Baseline: `b4094a423c20bb0ed424d944238f922c1b36559c`, tree `604c5c2b64b8d217e87895dbd981aa3a30579bcb`. With-#44 base: `78837c89c3d251fcedebc8ecaf14a4c2c2c1f6cb`, tree `de6e56e27ebb5503cdd36a07e0e1eba475b2eb33`.

## Research and code review

The round-six profiles were revisited, not represented as fresh round-seven captures. Native byte hashing, string copying, compression span gathering, composite-parser transitions and compiler call boundaries were examined. Existing workers already dispatch multiple compression jobs without waiting for every individual reply; message samples were not treated as proof of an unobserved serialization bug.

The official [xxHash specification](https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash.cry) motivated vectorizing the independent XXH32 stripe accumulators while preserving exact seeds, arithmetic, tails and output. [Emscripten's SIMD guidance](https://emscripten.org/docs/porting/simd.html) warns that expected instruction-level gains can fail to translate into application performance. The browser results below determined rejection, not SIMD width or a favorable microbenchmark.

The official [Clang attribute reference](https://clang.llvm.org/docs/AttributeReference.html#always-inline-force-inline) documents overriding ordinary inlining heuristics. [Emscripten's optimization guidance](https://emscripten.org/docs/optimizing/Optimizing-Code.html) discusses runtime/code-size tradeoffs. These sources motivated separate string and composite inlining experiments, but are not performance evidence for Manabitan. The retained override is targeted, not a blanket forced-inline policy; compiler upgrades should remeasure it.

## All paired browser results

Values are `median(100 * (B_ms / A_ms - 1))` over adjacent pairs. **Negative means faster.** Different hosts and baselines are not pooled. Initial cells have six alternating AB/BA pairs, three interleaved A/A control pairs and two excluded full warmups. Confirmations have twelve pairs starting BA, six A/A pairs and two warmups. No completed observation was retried, trimmed or removed.

| Initial isolated candidate | JMdict | Jitendex | A/A: JMdict / Jitendex |
| --- | ---: | ---: | ---: |
| Dual-xxHash32 SIMD | +5.581% | -1.443% | -17.487% / -0.056% |
| Bulk native key copying | +0.953% | +0.624% | -1.187% / +1.024% |
| Single-loop compression-span gathering | +0.138% | +0.746% | +2.312% / +1.389% |
| Adjacent key-colon transition | +1.605% | -1.233% | -2.570% / +0.777% |
| Adjacent string delimiters | +0.648% | -0.704% | +2.589% / +0.934% |
| Force-inline composite parser | -3.407% | -2.217% | -10.601% / -2.781% |
| Force-inline string scanner | -2.173% | -3.243% | -6.334% / -0.480% |

| Independent twelve-pair comparison | JMdict | Jitendex | A/A: JMdict / Jitendex |
| --- | ---: | ---: | ---: |
| Hashing against production | -0.027% | +3.589% | +0.028% / +3.716% |
| Hashing with #44 in both arms | +0.146% | -1.375% | -0.621% / -0.744% |
| String inlining against production | **-1.368%** | **-3.184%** | +0.708% / -0.610% |
| String inlining with #44 in both arms | -1.798% | -2.952% | +1.337% / +0.560% |

### Interpretation and rejected candidates

The original inlining/JMdict screen had control drift larger than its candidate change. The independent production result is the more useful evidence. Production confirmation equal-work totals are -1.403% JMdict and -0.896% Jitendex; with-#44 totals are **+0.572% JMdict** and -1.346% Jitendex. The latter JMdict total is slightly slower despite the favorable paired median. The +19.015% production Jitendex outlier and +19.594%/+8.231% JMdict and +17.642% Jitendex with-#44 outliers remain included. No general tail-latency improvement is claimed.

Hashing was favorable in all twelve with-#44 Jitendex pairs but did not agree across the production-baseline replication. That subset does not justify promotion or dictionary-specific thresholds. Composite inlining's favorable initial medians were smaller than same-binary movement. The remaining copying, gathering and delimiter experiments were mixed or slower. **Only string inlining is promoted; all six alternatives are excluded.** Closed allocation-only #42/#43 remain closed.

## Costs and controls

There are **584 complete timing imports across 22 cohorts**: 180 measured A/B pairs, 90 A/A pairs and 44 excluded warmups. The selected candidate accounts for 116 production observations plus 76 separately labeled with-#44 observations. Lifecycle tests and diagnostics are not included in these counts.

A and B packages were actually built at the same filesystem path. Unrelated ZIP members must match byte-for-byte; no package-member substitution or comment normalization was used. Every observation checks clean source and exact package identities. The retained change grows parser WASM **42,936 → 45,265 bytes (+2,329)** and the actual Chrome-dev ZIP **16,459,768 → 16,460,348 bytes (+580)**. With #44, increases are +2,319 and +598 bytes.

The pinned complete fixtures are JMdict 2026-09-06 (526,942 rows; ZIP SHA-256 `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a`) and Jitendex 2026.08.11.0 (435,448 rows; ZIP `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc`). CI uses Ubuntu 24.04 x64, Node 24.20.0, Clang 18.1.3 and Chromium 153.0.8010.12. Fresh profiles, warmed hosts, real OPFS-SAH-pool, production batching/concurrency/source budgets and all ten false worker experiment receipts remain fixed. Timing is file-input change through post-UI completion, without traces/profiling/screenshots/process sampling.

The offline audit rereads all reports for complete plans, monotonic timing, exact identities, title/revision/row counts, twelve persisted lookup/content probes, real storage, actual flags and equal source/group/worker/deduplication/storage work. Maximum individual parser-worker heaps match; this is not a total-process memory measurement or exhaustive persisted-store equality proof.

## Executed qualification

[Standalone run 35070081084](https://github.com/ManabiIO/manabitan/actions/runs/35070081084): **6,489 unit tests passed with 46 existing skips; 594 focused tests; 27 options tests; all four strict typechecks; new-file lint without rewriting; all build plans; actual Chrome/Firefox builds; and all 85 strict Chromium lifecycle phases with no skipped verification.** The 23 new tests also pass against the untouched parent. Runtime A/B, not an invented functional failure, establishes the optimization evidence.

The new tests cover 16 alignments, whitespace/delimiter transitions, every ASCII suffix, malformed separators, physical/logical EOF, independent-bank bounds, media/normalization hints, nested parent states through the existing depth limit, and 2,000 mutation iterations checked against independent JSON parsing. They originated in delimiter exploration and protect the same callers under inlining; the rejected delimiter shortcuts are not included.

C SHA-256: `e234fc1413b1560a5aac129f71ffddf5db196572ca1fe173e30eb46fcb1efcf3`; measured/qualified WASM: `8815ce7d99b8d3f95ebce3dfb1e0a3e6678ea609e041971f2bc5ef173875c2fc`.

[Combined run 35070553577](https://github.com/ManabiIO/manabitan/actions/runs/35070553577) composed #41, #44 and inlining locally. It passed **6,547 unit tests with 46 existing skips, 27 options tests, all four typechecks, lint, actual Chrome/Firefox builds and all 85 strict Chromium lifecycle phases**. Composition tree: `ef1fe23cac3c8852279c4e9bc3821ea8e9c4959e`; WASM `2153214ae9a00c0eec4973e52060fcf83d2df53a5c12b627c0425940dc377d8a`. No refs were pushed or PRs merged by that workflow. This is functional compatibility evidence, not a new three-change speedup claim.

Before timing, native cohorts pass 571 focused tests and complete resident parser/lookup output comparisons; gathering cohorts pass 123 focused tests. Local supplementary suites pass 25 hash and 23 grammar tests on both parent/applicable candidate, and an actual-codec gather check passes 408 cases totaling 30,188,871 gathered bytes. Local Node 22.16/Clang 17 diagnostics are not CI release qualification. An early local mixed-compiler component run, a 45-second-limited incomplete component attempt, corrected test-format diagnostics and an initially incorrect empty-frame oracle are preserved but excluded from authoritative timing. No product behavior was weakened to satisfy them.

## Reproduction and limits

- [Initial hash/copy/gather screens](https://github.com/ManabiIO/manabitan/actions/runs/35067919000)
- [Delimiter screens](https://github.com/ManabiIO/manabitan/actions/runs/35068166538)
- [Hash confirmations](https://github.com/ManabiIO/manabitan/actions/runs/35068724456)
- [Inlining screens](https://github.com/ManabiIO/manabitan/actions/runs/35069326746)
- [Inlining confirmations, both baselines](https://github.com/ManabiIO/manabitan/actions/runs/35069883428)

Artifacts retain exact drivers, patches, plans, identities, all raw observations/reports and completion markers for 30 days. The offline evidence adds the manifest-checking `audit.py`, recomputed CSV/JSON, supplementary tests/logs, extracted patches, research and raw qualification archives. Existing non-failing build warnings remain visible. No Firefox/Safari/ARM timing, cold-OS claim, total-browser-memory reduction or exhaustive stored-byte equality is established. No production or release ref was changed and no PR was merged by this round.
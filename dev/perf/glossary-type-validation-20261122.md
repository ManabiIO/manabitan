# Glossary type validation: evidence and decision

## Current status

**Retain the frozen revised implementation as a draft with the measured JMdict and VNDB tradeoffs documented. Leave the baseline in production. The first implementation was rejected, and the revised evidence establishes no general import improvement or approval to merge.**

The first Chromium cohort measured a slower JMdict import and an approximately flat Jitendex import. A single code revision removes the added checks from generic string and key handling. Its fixed local component screen is mixed: JMdict slowed and Jitendex improved. The completed revised browser comparisons measure **+1.94% JMdict**, **−2.85% Jitendex**, and **+0.79% VNDB** median paired total-import changes. Native parser sums are approximately flat, so the Jitendex improvement cannot be isolated to the modified parser work.

[Revised qualification run 45105028836](https://github.com/ManabiIO/manabitan/actions/runs/45105028836) completed all three dictionary comparisons and one unchanged-product Jitendex control successfully. All four completed artifact sets pass their recorded correctness checks. The decision uses all retained observations, including unfavorable results. No further code variants or outcome-dependent timing retries are planned.

## Source and binary identity

All comparisons use the same frozen baseline. Qualification commits include the measurement workflow and verifier; their identities are distinct from the runtime revision.

| Role                                            | Git identity                               |
| ----------------------------------------------- | ------------------------------------------ |
| Frozen baseline                                 | `5e1f8c12f7ff798ba407323aff675cb23b22af02` |
| Rejected first browser candidate                | `1bf95d706e9ccf1d7e83ccf46b39b18fce21b485` |
| Revised runtime commit used by the local screen | `571233801ed90c9a829da7fd29ee2c40c6f3a24c` |
| Revised remote qualification commit             | `5002f320432d9f5c14066b5ccfcda34ccc012bb2` |
| Equivalent local qualification commit           | `8eb2dee0d4a7da87c21348c9651134ad11f094ea` |
| Shared revised qualification tree               | `c852ec7c06f93afaeb84b12e9285e14de0596f45` |

| Artifact                     | SHA256                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| Baseline parser WASM         | `cc749c53fc32dfb28eefbd69f99868f8c303caa1a3f1354231516dfa5a6e1b0f` |
| Rejected parser WASM         | `7a8621081066b18e832ce18b7448cfd91774eca049bcfef646b9652ae6328958` |
| Revised parser WASM          | `8bed82314d89c67feab6e01173d1d67ad9ac939d86ddfc0289bd8ca3aab5f537` |
| Revised native parser source | `49f51dffd25401f1b358b00621da4be692b19e6d1fac3805e1f9b11245ab1591` |

The revised checked-in WASM and generated `ext/lib/term-bank-parser.wasm` matched. Source and binary bytes were frozen before the revised local screen. The revision was then committed without changing those bytes during the screen; every observation's recorded source and WASM hashes match the committed revision.

### Toolchain check

The frozen baseline was rebuilt with the exact pinned Clang and LLD **21.1.8**, using the manifest's build arguments. `node dev/bin/build-dictionary-wasm.js --check` compiled into a temporary directory and reproduced both checked-in native artifacts byte for byte. In particular, the parser reproduced `cc749c53fc32dfb28eefbd69f99868f8c303caa1a3f1354231516dfa5a6e1b0f`. No baseline source or artifact was overwritten. This check rules out a mismatched compiler or linker build as the explanation for these comparisons.

## What changed

The first implementation recognized literal `"type"` keys in the common object-key helper and checked for a supported discriminator at each string token. It replaced repeated scanning and matching for `"text"`, `"image"`, and `"structured-content"`, but added predicates to shared parser paths. The first browser phase measurements did not demonstrate that this tradeoff reduced parser time.

The revision restores the baseline generic string dispatch, common content/tag key helper, and normalization helper. Only the existing schema-validation branch that has already identified a top-level glossary `"type"` field tries the literal-value shortcut. It consumes the colon, intervening whitespace, and complete supported literal together, then updates the existing type, media, text, and whitespace hints. All other values retain the general parser. Both content-before-type and type-before-content property orders are covered.

This is a narrower mechanism, not evidence of a speedup. The revision preserves JSON bounds, required-field checks, duplicate-field semantics, escaped-value fallback, output bytes, and persisted formats. It changes no import defaults, worker counts, batching thresholds, cache limits, or compression settings. See the [native parser](../../ext/js/dictionary/wasm/term-bank-parser.c) and [discriminator regression tests](../../test/term-bank-glossary-discriminators.test.js).

## Rejected first browser cohort

Each dictionary used eight adjacent baseline/candidate pairs, with all sixteen measured imports retained and one excluded warmup per arm. The order was `A1 B1 B2 A2 B3 A3 A4 B4 A5 B5 B6 A6 B7 A7 A8 B8`. Chromium was **153.0.8010.12**. The authoritative boundary was file-input change to the current import's post-UI completion event. Trace captures were separate and are not timing observations.

Negative changes mean faster. Percentages are medians of within-pair candidate/baseline changes, not the percentage change between the two arm medians.

| Dictionary | Baseline median ms | Candidate median ms | Median paired change | Faster pairs |
| ---------- | -----------------: | ------------------: | -------------------: | -----------: |
| JMdict     |             946.55 |              974.95 |           **+2.94%** |          2/8 |
| Jitendex   |            1439.50 |             1424.20 |           **−0.38%** |          5/8 |

The corresponding reported native parser sums also increased in six of eight pairs for each dictionary:

| Dictionary | Baseline native sum median ms | Candidate native sum median ms | Median paired change | Faster pairs |
| ---------- | ----------------------------: | -----------------------------: | -------------------: | -----------: |
| JMdict     |                       1086.50 |                        1137.50 |           **+4.76%** |          2/8 |
| Jitendex   |                       1072.50 |                        1124.00 |           **+4.23%** |          2/8 |

These native figures aggregate worker durations. They overlap worker wall time, storage work, and other phases; they must not be added to the complete-import timings. JMdict's term fast-path wall increased by a median paired **3.65%**, while Jitendex's decreased by **0.82%**. Sixty-seven reported workload fields matched exactly across all sixteen observations of each dictionary, including row counts, content bytes, reuse counters, and zero fused fallbacks. Configuration and recorded capacity fields also matched.

The additional shared-path conditions are a plausible cost, but the phase data do not uniquely establish that cause. Another candidate with unchanged native term-parser function bodies also showed timing variation, and separate unchanged-code local controls were noisy. The planned unchanged-product browser control addresses this uncertainty. Absolute times from different jobs or hosts must not be pooled or used to infer an implementation effect.

The first implementation is retained as rejected evidence rather than presented as an optimization success.

## Revised local component screen

The fixed schedule was four alternating adjacent pairs per dictionary: `A1 B1 B2 A2 A3 B3 B4 A4`. All eight observations per dictionary were retained. There were no retries, exclusions, or extensions based on results.

The boundary is sequential full-corpus native parsing plus completed lookup-index construction. It excludes source I/O, compilation, warmups, explicit GC, digest verification, persistence, worker IPC, and UI. This workload differs from the production browser pipeline.

| Dictionary | Median paired change | Equal-work total change | Faster pairs |
| ---------- | -------------------: | ----------------------: | -----------: |
| JMdict     |          **+30.10%** |                 +25.21% |          1/4 |
| Jitendex   |          **−16.24%** |                 −16.47% |          4/4 |

This is a mixed exploratory result on a noisy shared host. It establishes no general import improvement and does not justify discarding the JMdict slowdown. The revised browser cohort is a single planned check of the changed implementation against the same baseline; the negative local result remains part of the evidence.

Complete component content and prepared-lookup digests matched between arms for every observation:

| Dictionary |   Rows | Full component output SHA256                                       |
| ---------- | -----: | ------------------------------------------------------------------ |
| JMdict     | 526942 | `430a59f035c1e6bb66352f50b3d722b8bf853b394d56d5816f0576594e1ebb57` |
| Jitendex   | 435448 | `b618d21aa8c89a3f2f21613fa15c9fa8689bdd9efb991c9475e78e8ac057e805` |

The fixed plan, all raw observations, source identities, host records, and summary are preserved for the revised evidence archive. Equal-work total change means the ratio of the summed candidate and baseline durations over the same retained work; it is separate from the median paired statistic.

## Correctness and verification scope

The revised source passed the pinned native build and **994 tests across three focused suites**:

```text
test/term-bank-glossary-discriminators.test.js
test/term-bank-composite-state.test.js
test/dictionary-importer-glossary-types.test.js
```

Coverage includes both property orders, duplicate type and required fields, escaped keys and values, unsupported and near-prefix literals, whitespace around the colon, multiple glossary objects, media/text normalization hints, and truncation at every character position with valid-looking bytes placed beyond the logical input boundary. Scoped ESLint and `git diff --check` passed. The only scoped-lint warning was the existing vendor `pako-inflate.js` CommonJS/ESM warning.

The first browser cohort verified exact dictionary title, revision, row count, readable content, twelve persisted content probes, and restart visibility for JMdict and Jitendex. Those are sampled persistence checks. They are not exhaustive stored-byte equality and must not be conflated with the full component content/lookup digests. No complete-import peak-memory benefit is established.

All four completed revised browser jobs pass their recorded correctness and sampled persistence checks. VNDB reports **6648310 term rows**, **146570 media rows**, and **146314 entries** in the activated **195649882-byte** source-media pack. Its twelve content probes, dictionary counts, packed-media metadata, and five image byte/hash probes agree between arms; the sampled content and images remain readable and identical after restart. This remains sampled persistence verification, not a digest of every persisted VNDB row or image.

[Main CI run 45105028926](https://github.com/ManabiIO/manabitan/actions/runs/45105028926) passed on the exact qualification commit **`5002f320432d9f5c14066b5ccfcda34ccc012bb2`**: **628 unit-test files, 14044 unit tests passed, and 47 tests skipped**, plus all four TypeScript projects, lint, build, Chromium, Firefox, Anki, and options checks. The 994 focused tests above were also run against the frozen runtime revision. The focused suite is not an additional count to add to the full unit total.

These CI results qualify that exact source head. A subsequent commit containing the report, evidence, and registry entries requires its own CI result; the successful qualification run is not attributed to an untested future commit. The browser performance comparisons here cover Chromium on the recorded hosts, not a cross-browser or cross-device performance claim.

## Revised browser cohort and unchanged-product control

Run `45105028836` includes revision comparisons for **JMdict, Jitendex, and VNDB**, plus exactly one **unchanged-product Jitendex control**. Each job uses the fixed eight-pair order, two excluded warmups, a shared measurement harness, and the same pinned baseline. The control's candidate checkout uses the qualification workflow but restores the baseline native source, manifest, and WASM. The workflow requires identical full extension-package entry hashes before timing; the verifier repeats that identity check. The completed control reports no changed package entries and identifies the baseline as both arms' product source. This separates product identity from qualification-checkout identity.

The control investigates variation in functions unchanged by a candidate. It does not supply a correction factor to subtract from another job, and its absolute times must not be compared across hosts. All scheduled observations, including unfavorable results, must remain in the evidence.

| Job                                | Baseline median ms | Candidate median ms | Median paired change | Faster pairs | Artifact verification             |
| ---------------------------------- | -----------------: | ------------------: | -------------------: | -----------: | --------------------------------- |
| Revised JMdict                     |             855.60 |              865.20 |           **+1.94%** |          3/8 | Passed recorded checks            |
| Revised Jitendex                   |            1920.80 |             1873.10 |           **−2.85%** |          6/8 | Passed recorded checks            |
| Revised VNDB                       |            8156.55 |             8194.10 |           **+0.79%** |          3/8 | Passed recorded checks            |
| Unchanged-product Jitendex control |            1395.05 |             1381.75 |           **−0.51%** |          4/8 | Passed; identical package entries |

Each row is a separate within-job comparison. The different jobs' absolute times are not comparable. The revised median paired differences are **+16.35 ms JMdict**, **−54.95 ms Jitendex**, and **+64.30 ms VNDB**. All eight pairs are included in every job, including the unfavorable observations.

The phase analyzer reports the following median paired percentage changes. These are overlapping diagnostic intervals, not an additive explanation of the total:

| Reported phase               | Revised JMdict | Revised Jitendex | Revised VNDB | Unchanged-product Jitendex control |
| ---------------------------- | -------------: | ---------------: | -----------: | ---------------------------------: |
| Native parser sum            |         +0.65% |           +0.17% |       +0.50% |                             +2.12% |
| Source inflate sum           |         −0.65% |           −5.24% |       +0.60% |                             −1.89% |
| Parser result-copy sum       |         +0.30% |           −1.60% |       −0.86% |                             +1.60% |
| Importer term-parse interval |         −1.63% |           −4.29% |       +2.98% |                             +0.21% |
| Term fast-path wall          |         +2.38% |           −2.50% |       +1.02% |                             +0.28% |
| Parser worker wall           |         −2.63% |           −1.20% |       +1.02% |                             +0.90% |
| Data-bank wall               |         +2.36% |           −2.78% |       +1.09% |                             −0.07% |
| Bulk finalization            |         +2.38% |           −8.36% |       +0.16% |                            −11.51% |

For revised JMdict and Jitendex, the native parser is faster in four pairs and slower in four. VNDB's native sum is faster in three pairs and slower in five, with a median paired change of **+0.50%**. JMdict's parser worker wall is faster in six of eight pairs despite its slower total import. Jitendex's total improvement accompanies lower inflation, data-bank, and finalization times while its native parser sum stays approximately flat. The measurements do not establish how much of the total improvement the literal shortcut caused.

All sixty-seven reported workload fields match exactly across the sixteen observations within each completed job. Configuration and capacity fields match within each job as well. The control shows that unchanged product code can produce phase shifts: its native parser sum increases by **2.12%** while its total changes by **−0.51%**, with four total-import pairs faster and four slower. This is context about variation on a separate host, not a statistical correction, a universal noise threshold, or an effect to subtract from either revision result.

### Final recommendation

Keep the frozen revision as a **draft with a documented JMdict tradeoff**, and leave the baseline in production. The existing measurements do not establish clear, repeatable native parser harm that by itself requires removing the draft, but they also do not justify presenting the change as a validated general optimization. Jitendex's favorable complete-import result is limited to this cohort and is not isolated to the changed native code. The slower JMdict and VNDB browser results and the substantially slower local JMdict component screen remain material evidence.

This decision retains all completed evidence without another variant or favorable-result retry. A decision to retain a draft is not approval to merge or deploy the production change.

## Fixtures and retained evidence

| Fixture                            | Archive SHA256                                                     |
| ---------------------------------- | ------------------------------------------------------------------ |
| JMdict English, 2026-09-06         | `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a` |
| Jitendex, 2026.08.11.0             | `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc` |
| VNDB Character Names by Bee, 1.0.0 | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` |

The [rejected evidence archive](evidence/glossary-discriminators-rejected-20261122.tar.gz) and [its manifest](evidence/glossary-discriminators-rejected-20261122.manifest.json) preserve the original timing observations, warmups, source/package identities, comparison outputs, and fixture identities. Rendered HTML duplicates and separate candidate trace captures are omitted from that archive; the manifest records the omissions. Dictionary archive bytes are not embedded.

The [revised evidence archive](evidence/glossary-type-validation-revised-20261122.tar.gz) and [its manifest](evidence/glossary-type-validation-revised-20261122.manifest.json) retain all four completed browser cohorts, the mixed revised component screen, their source identities, and the complete phase analysis. The original VNDB workflow artifact SHA256 is `5ebd99faefe063e91504a204fb747f33cdccbe26a095aeb4d50ab75b206c982d`.

All **64 measured browser observations and eight excluded warmups** are retained. Archive SHA256: `40c59a05a9a26dbe063aea366bd4390006a3685a3b7813832e8d6aa3ec638687` (2423155 bytes). Adjacent manifest SHA256: `0e37608a4596886da8b5167adffe1ab32925a533ed610e2a72153f2d2db9b71d` (437963 bytes). Both file hashes and the embedded analyzer/output hashes were verified after packaging. Inside the archive, the complete phase output is `analysis/revised-complete-phases.json` and the analyzer is `analysis/analyze_browser_phases.py`.

The read-only phase analyzer uses all declared `A1..A8` / `B1..B8` reports, rejects trace and non-authoritative timing, checks end-to-end durations against `comparison.json`, and reports missing optional phases without dropping pairs. It reproduced the first cohort's native changes of **+4.7601948857%** and **+4.2344969929%**. Analyzer SHA256: `182a9b6684ec1a00eaaf2752768d7ec8d6c078d0d9efeed6bad5d9898b1e290c`. Complete four-cohort phase-analysis SHA256: `7c1f2712e917e7b5cd209f959460fb71f12e0f8c98e55e63d653ea2087c1229c`. Both the analyzer and its input-report hashes accompany the revised evidence.

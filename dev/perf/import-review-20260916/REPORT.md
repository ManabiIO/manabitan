# Import optimization review — 2026-09-16

## Disposition

**No optimization PR promoted from this round.** Six new implementation ideas plus one combined candidate were built and A/B tested. The apparent gains did not survive independent confirmation strongly enough to justify changing production. No production or release ref was changed, no PR was merged, and no previous optimization's gain was counted again.

The complete measurement set is **432 fresh-browser imports: 132 A/B pairs, 66 interleaved A/A control pairs, and 36 excluded warmup observations**. All 18 cells completed their predeclared plans with successful integrity checks, zero retries, and no outlier removal.

All recipes, candidate generators and new native test inputs are retained on `verify/import-review-20260916-1705`. Experimental source changes are not a recommendation to merge them.

## Exact baseline and corpus

- Repository: `ManabiIO/manabitan`, target branch `develop`.
- Baseline commit: `c0a1b7ee6fa1383a0a422361d2a8b7f826499fff`.
- Baseline tree: `a48da18d4244b00661d0c6518b2ce77b9f2f9b55`.
- This already includes the earlier first-special-byte and forced-inline scanner work. It retains the production miniz path; the separate libdeflate proposal was not mixed into these experiments.
- JMdict: release 2026-09-06, 526,942 term rows, archive SHA-256 `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a`.
- Jitendex: revision 2026.08.11.0, 435,448 term rows, archive SHA-256 `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc`.
- Dictionary lock SHA-256: `4e3e98dfd2bf06968aefaa4f72328ec3736121124e57752e374c7ee507975b13`.

## Source review and hypotheses

The review concentrated on the remaining native parser and exact-dedup/cache-copy costs rather than changing durability or parallelism.

1. **Integer overflow guard:** replace the per-digit signed-limit division expression with an equivalent quotient/final-digit test before multiplication. Preserve int32 extremes, strict JSON token grammar, null handling, and rejection of arbitrarily long numbers.
2. **Escape-word scan:** scan quoted key interiors in bounded eight-byte words with a scalar tail. Never read a word beyond the token interior; preserve escaped/multibyte key handling.
3. **Overlapping equality tail:** replace the final zero-to-seven scalar comparison bytes with a fully in-bounds overlapping eight-byte load. This remains exact equality, not a probabilistic check.
4. **Fixed-width glossary signature samples:** make the common first/middle/last four-byte loads explicit, retaining the original short-input path. Signatures remain bit-identical and do not replace full equality.
5. **DataView exact comparisons:** compare unaligned spans in four-byte units, preserving invalid-span behavior and scalar short/tail cases. No hashes or sampled equality were substituted.
6. **Owned cache copy with set:** allocate the same bounded owned Uint8Array and copy the same source range with `set(subarray(...))`, instead of `slice`. No borrowed parser/WASM memory is retained, and cache budgets, eviction, rollback, and mappings are unchanged.
7. **Compact native combination:** separately measure hypotheses 1, 2 and 4 together. Do not sum their individual percentages. The larger equality-tail variant is excluded from this combination.

The safety-sensitive invariants reviewed were overflow-before-multiply, bounded unaligned loads, signature collisions requiring exact verification, source ownership after shared/WASM slab reuse, rollback/eviction, complete dictionary publication, and lookup continuity. No storage format, CRC validation, compression policy, worker count, batch/prefetch limit, durability setting, or experiment default was changed.

## Initial screens

Six alternating A/B–B/A pairs per candidate/dictionary, with three interleaved A/A control pairs and one excluded warmup per arm. Percentages below are the **median of within-pair `100 * (B/A - 1)`**, not a ratio of aggregate medians. Negative is faster.

| Candidate | JMdict | Jitendex | Disposition |
| --- | ---: | ---: | --- |
| Integer overflow guard | -1.325% | +1.183% | Mixed/noisy; not promoted |
| Escape-word scan | -0.689% | -0.208% | Below useful confidence; not promoted |
| Overlapping equality tail | -0.192% | -0.911% | Small/noisy with code growth; not promoted |
| Fixed-width signature samples | +0.023% | -0.600% | No demonstrated end-to-end win |
| DataView exact comparisons | -0.708% | +0.593% | Mixed/noisy; not promoted |
| Owned cache copy with set | -0.166% | -3.097% | Independently retested |
| Compact native combination | -3.633% | -1.072% | Independently retested |

These are screening observations, not claimed improvements. In particular, one escape-scan JMdict host had a -13.304% signed A/A median: ordinary host variability was much larger than the apparent candidate effect there.

## Independent confirmation

New jobs/hosts, **12 alternating pairs starting B/A**, six interleaved A/A control pairs and one excluded warmup per arm. The initial six-pair cohorts are not pooled into these results.

| Candidate / dictionary | A median ms | B median ms | Median paired change | Faster pairs | Median absolute A/A variation |
| --- | ---: | ---: | ---: | ---: | ---: |
| Owned copy / JMdict | 1496.2 | 1459.2 | -1.153% | 9/12 | 1.572% |
| Owned copy / Jitendex | 1541.3 | 1538.2 | +0.135% | 5/12 | 1.921% |
| Native combination / JMdict | 1514.7 | 1507.9 | -0.037% | 7/12 | 2.809% |
| Native combination / Jitendex | 2529.2 | 2534.6 | -0.178% | 7/12 | 1.246% |

Absolute times across different hosts/cells are not directly comparable. A/A controls describe variability; their percentages were not subtracted from A/B measurements. All observations, including large scheduling/I/O outliers, remain in the evidence.

The native combination's component-only confirmation was -1.250% on JMdict and -1.133% on Jitendex, but each had only one of two component pairs faster. Those are not substitutes for a complete browser-import improvement. The native WASM was 353 bytes smaller (45,253 to 44,900), while the Chrome package was 268 bytes larger; neither establishes a meaningful import-runtime win.

The copy change's initial Jitendex improvement did not replicate. Jitendex retained zero recent-source cache bytes under the existing policy in both confirmation arms. For JMdict, both arms retained exactly 100,661,232 bytes; the measured full-import difference remains within the observed control variation. **Retain both as unpromoted experiments, not winning PRs.**

## Measurement controls and integrity

Remote measurements used Ubuntu 24.04, Node 24.20.0, Clang 18.1.3 and Playwright Chromium 153.0.8010.12. Each observation starts a fresh browser profile and performs a complete UI import using real `opfs-sahpool`, not a fallback store.

Both extension packages were built using the real repository build command at the same filesystem path. ZIP member sets were checked equal; the only differing members were the changed product source and, for native candidates, its WASM. Source, package, parser, fixture-lock and harness hashes were checked before every observation and after the plan completed.

The primary timing is the existing `totalImportMs` boundary, from file-input change through import/UI completion. Worker timings are retained separately. Production defaults and empty experiment flags were fixed; receipts from the actual parser/import workers verified all ten experimental flags remained false.

Every browser observation verified the expected full row count, dictionary title/revision and 12 persisted content probes. This is **not a claim that every persisted row was read back**. Native candidates additionally compared complete canonical output digests and lookup-index/plan output across the complete JMdict and Jitendex corpora using the existing component driver. All compared outputs agreed. The component harness has its own fixed grouping and is not the browser timing authority.

## Correctness qualification

The two shortlisted sources additionally completed:

| Check | Native combination | Owned copy |
| --- | --- | --- |
| Full unit suite | 6,548 passed; 46 skipped | 6,520 passed; 46 skipped |
| Options suite | 27 passed | 27 passed |
| All four typecheck projects | Passed | Passed |
| All build plans | Passed | Passed |
| Actual Chrome and Firefox packages | Built | Built |
| Strict Chromium lifecycle | 84 phases passed | 84 phases passed |
| Full JavaScript lint | 38 inherited errors | 38 inherited errors |

The lifecycle runs used real OPFS, did not skip verification, and covered restart persistence, update/crash recovery, multiple dictionaries/batch import, existing lookup continuity, hover/search responsiveness and deletion. They are correctness checks, not the A/B timing cohorts.

The lint errors are all in unchanged `test/term-bank-composite-state.test.js` (SHA-256 `9384dca84f8e29bc0cc728c19d50bc946191ce25a6ce48566c75480dc99edd17`). The same 38 errors were reproduced against the unchanged baseline file. No unrelated style cleanup was mixed into an optimization. The qualification workflow deliberately failed closed, so its optional publication steps did not create qualified source refs. Do not describe the complete workflow as green.

New native coverage comprises 20 integer-boundary tests and eight token/dedup tests, passing before and after each native candidate. It uses independent arbitrary-precision integer expectations, input alignments, physical memory-end/guard cases, long/malformed numbers, every-byte near matches, escaped and multibyte keys, and fused/fallback parser paths. Supplemental ASan/UBSan checks execute verbatim extracted primitives: 1,608,500 checks passed for the baseline and each native candidate, including the combination. This does not claim the entire WASM translation unit ran under native sanitizers.

The DataView experiment also received 67 new tests covering shared/non-shared backing stores, unaligned spans, every mismatch position, long tails, mutations, invalid spans and type/detachment behavior. They passed on parent and candidate; the candidate passed 174 focused tests including the existing dedup/block-store cases. Those additional local test sources and receipts are retained in the downloadable evidence, not promoted as an optimization.

The first native screen listed a nonexistent extra filter `term-bank-first-special-byte.test.js`. The real file is `term-bank-first-special.test.js`. Later screens and full qualification used the correct path; both the real first-special and adjacent-delimiter suites were also run locally against each of the four initial candidates: 54 tests passed per candidate. The historical raw command is preserved rather than silently rewritten.

## Reproduction and retained evidence

- [Initial native screens](https://github.com/ManabiIO/manabitan/actions/runs/35124979269): eight artifacts, all four candidates on both dictionaries.
- [Sink and combination screens](https://github.com/ManabiIO/manabitan/actions/runs/35126090712): six artifacts.
- [Independent twelve-pair confirmation](https://github.com/ManabiIO/manabitan/actions/runs/35126804113): four artifacts.
- [Complete source qualification](https://github.com/ManabiIO/manabitan/actions/runs/35127103920): two artifacts, including functional success and the inherited lint failure.

Each performance artifact retains the exact plan, all per-import reports, observations, component results where applicable, candidate patch, source/build identities, sizes, logs and executed driver inputs. Artifacts were configured for 30-day retention. The downloadable evidence bundle also retains these artifact ZIPs, the independent audit, new tests and local sanitizer receipts.

Pinned recipe commits are `6578f49ff9db89cb7124438c8b5b15a59e4398bf` (native screens), `1b102253fc7f42016b4786dedb7ec9e84123bd5d` (sink screens), `147ce6f57157c747c1a36b1e90ba8e0a011259a4` (confirmation), and `f8379d2d71ba08116265ac3034695c2811a09e48` (qualification). The reused fixed-plan driver is read from `23524cf48cb08482ebd271406fe48da773bb516c`; the executed derived copy is retained in each artifact.

Limitations: these are Linux Chromium results, not native Manabi Reader or macOS/Safari performance qualification; a Firefox package build is not a Firefox runtime benchmark. No browser peak-memory improvement is claimed. Component memory/output sizes and package sizes are retained separately. No CI badge or microbenchmark-only result was treated as permission to ship.

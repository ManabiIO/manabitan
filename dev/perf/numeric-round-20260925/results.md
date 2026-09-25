# Numeric projection import qualification — 25 September 2026

## Selected result

PR #298: https://github.com/ManabiIO/manabitan/pull/298

Select the smaller length-first integer decoder. Final-source complete WTY imports improve **12.52% with production defaults** and **13.82% with generic shared-span compression enabled**, **12/12 pairs faster in both cohorts**. This is measured incremental benefit alongside #291's setting, not summed percentages from separate hosts. No PR was merged and #291 was not modified.

Product baseline: `76362775484661b3cd8b9d2c84b228802c023a76`.
Exact product head: `74b09d33937448ae990e61752d6cb749c7c63317`.
The two-file diff is 14 added runtime lines plus a 140-line, 12-case test file.

## Mechanism and safety

Non-fused projection previously copied each numeric token from shared Wasm memory, decoded it with TextDecoder, allocated a string and called Number. Retain the original boundary scan; convert all-digit tokens of at most 15 digits directly from bytes. Every intermediate is below 2^53, and negation preserves negative zero. Longer integers, fractions and exponents retain the original Number rounding, finite rejection and sequence safety checks. Native JSON grammar validation is unchanged.

No new flag, dependency, cache, worker, batch threshold, dictionary-specific heuristic, persistence format, codec or native parser/Wasm change. Already-fused imports usually bypass this helper.

## Final-source complete imports

Twelve alternating source pairs, seven A/A pairs and two excluded warmup observations per cohort, 40 complete imports. Negative is faster. Percentages are medians of per-pair changes, not ratios of arm medians. Each row has a separate host: do not compare absolute times across rows, including defaults versus generic spans.

| Dictionary | Configuration in both arms | Baseline median ms | Candidate median ms | Paired change | Faster pairs | Median absolute A/A change |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| WTY English | Production defaults | 5224.60 | 4512.05 | **-12.518%** | **12/12** | 0.829% |
| WTY English | Generic spans on | 6363.25 | 5475.50 | **-13.815%** | **12/12** | 0.829% |
| JMdict | Production defaults | 1370.30 | 1368.65 | -1.698% | 9/12 | 2.144% |
| Jitendex | Production defaults | 1968.65 | 2024.10 | +2.554% | 4/12 | 4.754% |
| JMnedict | Production defaults | 928.65 | 919.95 | +1.352% | 5/12 | 3.115% |
| JMnedict | Generic spans on | 1131.10 | 1126.85 | -0.224% | 8/12 | 1.936% |

All six consecutive two-pair WTY block totals improve. Defaults: -13.38%, -10.55%, -10.31%, -14.61%, -11.35%, -13.79%. Generic spans: -14.42%, -12.38%, -14.72%, -14.97%, -14.38%, -13.09%.

The Japanese cohorts do not establish a useful general speedup. Their small observed slowdowns remain visible. A/A variation is descriptive, not a confidence interval or proof of zero overhead. No A/A subtraction, trimming, retries replacing unfavorable measurements, or cross-host pooling.

## Audit and correctness

All 480 successful timing observations are retained and audited: 240 for the initial prototype and 240 for the final source, including controls and excluded warmups. The source versions are not pooled.

Every observation uses pinned complete archives, a fresh Chromium profile, real OPFS-SAH-pool storage and browser-monotonic timing from file-input change through UI completion. Builds, downloads and probes are outside the timer. Tracing, profiling, screenshots and process sampling are disabled. The audit checks actual worker receipts, error-free completion, title/revision/full row counts, twelve persisted-content probes, raw timing and stable work.

Every pair and control has matching source/encoded byte counts, rows/chunks/groups/workers, fused attempts/fallbacks/discarded rows, deduplication, content/index writes and parser heap highwater. WTY has 1,643,040 rows; content writes remain 133,821,475 bytes, lookup-index writes 59,637,832 bytes and parser highwater 173,735,936 bytes. Aggregate worker row decoding falls from 1693 to 434 ms with defaults and 2386 to 589.5 ms with generic spans. Parallel-worker phase totals are not additive wall-clock time.

Full-corpus digests match numeric columns, canonical content, hashes and prepared lookup output across 3,273,372 rows in four distinct dictionaries. Off-clock package-member checks find only the intended parser JavaScript member differs. Wasm is byte-identical. Per-observation ZIP-container hashes are retained; fresh ZIP metadata means those container hashes need not remain constant across builds.

The final product tree passes 7,360 unit tests (46 existing skips), 27 options tests, all four TypeScript projects, changed-file lint and the full build. Baseline passes 11 new semantic cases and fails only the no-TextDecoder-allocation assertion; the candidate passes all 12. Cases cover 15/16 digits, int32/2^53 boundaries, signed zero, fractions/exponents, subnormals, maximum finite doubles, non-finite rejection, safe sequences, offset views, split banks and chunk boundaries. A local differential check verifies 192,400 numeric inputs against Number for each candidate.

The exact final runtime passes 85 Chromium lifecycle phases in each configuration, including crash recovery, concurrent lookup, update/restart persistence, multi-file imports and deletion. The initial imports carry the requested compression setting; later lifecycle scenarios reset their own options. Earlier validation jobs retained formatting-only test lint failures; final delivery fixes the formatting without changing the measured runtime or weakening assertions, and all its checks pass. Normal PR CI is tracked separately.

## Alternatives and limits

The initial 18-line digit-first prototype measured WTY -12.21% / -13.24%, 12/12 faster, but these are not the final source's timings. The smaller implementation retains the original scan and has lower observed adverse-control overhead. Final synthetic short-integer projection improves about 59–66%; decimal/exponent-only projection remains **4.45% slower**, with wide-integer/long-exponent controls around +1%. Those costs are retained. The initial prototype's decimal/exponent control was +6.82%. Component results are not complete-import claims.

These measurements are Linux x64 Chromium only. Parser highwater is not whole-browser peak memory. Full-corpus equality is at the parser/lookup-preparation boundary; persistent contents are sampled, not exhaustively compared. No Firefox/Safari/ARM, cold-OS or total-memory gain is claimed.

## Exact identities and retained evidence

- Baseline JS SHA-256: `26f1eee368eaee1f68674beccc7f01737a3c64d4ae18d7c7a0c2a2453e2bfe4d`
- Prototype JS: `3944437a38bf8711c43722bc29a15b2be22e9aa5c7cdbe3dc1e20e021d469834`
- Final JS: `f617cce1a6c253a86470d4dc0a38d0edc08a38b957c77390e64460da791014aa`
- Final tests: `44e62d1a34f91a52ba0ddffc1eb848ce3ffed4838e1e1e4c99126d7c6fc0bb0b`
- Unchanged Wasm: `1fabe63bd6cdf98ba987f9b5c6848e48a08bd526e44f3d0332868ee49d8b6ee5`

First-source run: https://github.com/ManabiIO/manabitan/actions/runs/36170504977

Final-source timing/lifecycle run: https://github.com/ManabiIO/manabitan/actions/runs/36171093061

Final passing delivery and baseline allocation regression: https://github.com/ManabiIO/manabitan/actions/runs/36171539480

Normal PR CI: https://github.com/ManabiIO/manabitan/actions/runs/36172198317

Static-web acceptance: https://github.com/ManabiIO/manabitan/actions/runs/36172198320

Final timing input: `da89ec3c9befdbd457ad66b47b5786a3243c7518`. Passing delivery input: `8080480d236f0ef58aaccd688a81b1de2182d69f`. All workflows and candidate alternatives stay on this research branch, not in the product PR.

The session evidence bundle `manabitan-numeric-projection-evidence.zip` has SHA-256 `f04286c489604308977eb0363495d6cf867c3b2e4f1f3fdd42dc8d85e014153c`. It contains all raw cohorts, early failures, final tests, exact product patch, synthetic controls and a verified offline audit; no font files or full extension packages. The two-file product patch SHA-256 is `6138e09a5ffc3a8d692f9291cb2c0c0b38ee1d04a2aaa9229ffbc06b76cca314`.

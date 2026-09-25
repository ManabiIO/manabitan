# Native escaped-key import qualification — 25 September 2026

## Decision and exact source

Retain the small native string-plan change in PR #308, stacked on #298. Independent confirmation measured **4.27% lower complete WTY import time after #298**, and **6.73% lower with generic shared-span compression enabled in both arms**. Both confirmation cohorts were faster in 12/12 pairs. Normal PR CI and static-web acceptance are green. No merge was performed; #291 and #298 were not modified.

Product PR: https://github.com/ManabiIO/manabitan/pull/308
Parent: `74b09d33937448ae990e61752d6cb749c7c63317`.
Product head: `46c54d548c6d0739a9aed81f764c98ffb4d8fde8`.
Product tree: `c29fdcd3a41388a5a025012200a11138054f19bb`.

Only three product files change: one C function, 21 new actual-Wasm test cases, and stronger byte-parity expectations in existing parser tests. Runtime diff: 21 additions, 7 deletions. Full diff: 174 additions, 10 deletions. Research tools and workflows are not in the product PR.

Baseline C SHA-256: `b65eebac1d7a83eeb6ae14969069afc376a0084ddb0f6ffa01a84d1266dde108`.
Candidate C: `bd9f6754dcaa861af3c674a444c42b701088b852e1e60760efa49834235bc525`.
Baseline Wasm: `1fabe63bd6cdf98ba987f9b5c6848e48a08bd526e44f3d0332868ee49d8b6ee5`.
Candidate Wasm: `0cd848b78b51307a67a8e0e2bd7dee523de12fec2bc24c89e740445697558483`.
Both-arm parser JavaScript, including #298: `f617cce1a6c253a86470d4dc0a38d0edc08a38b957c77390e64460da791014aa`.

## Mechanism and compatibility

One escaped expression or reading previously caused the standalone non-fused string-plan builder to abandon an entire chunk to JavaScript interning. Decode exceptional keys with the existing native decoder into the unused tail of the already-allocated string arena, then continue interning without copying the decoded key again. No new decoder, allocation, cache, worker, flag, dependency, compression setting, persisted format or dictionary-specific heuristic is added.

Invalid raw UTF-8 and insufficient scratch capacity retain JavaScript fallback. Distinct raw expression/reading tokens that decode to equal keys also retain fallback, preserving existing raw-token reading-equality semantics. Numeric semantics, content hashes and stored data remain unchanged. This does not enable experimental fused-parser flags or increase failed fused attempts.

## Complete-import results

Each native cohort uses twelve alternating pairs, seven unchanged-code A/A pairs and two excluded warmup observations. Percentages are the median of per-pair changes; negative is faster. Each row uses a separate host. Do not compare absolute times across rows, pool cohorts or add historical percentages.

### Initial twelve-pair cohorts

| Dictionary | Both-arm configuration | Baseline ms | Candidate ms | Paired change | Faster pairs | Median absolute A/A |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | After #298, defaults | 1345.90 | 1343.05 | +0.09% | 6/12 | 2.52% |
| Jitendex | After #298, defaults | 1706.65 | 1695.50 | -0.85% | 7/12 | 2.63% |
| JMnedict | After #298, defaults | 971.55 | 983.65 | +1.46% | 3/12 | 4.75% |
| WTY English | After #298, defaults | 6651.05 | 6334.15 | -5.12% | 12/12 | 0.87% |
| WTY English | After #298, generic spans on | 5511.60 | 5144.95 | -6.12% | 12/12 | 0.91% |

### Independent confirmation, opposite initial order

| Dictionary | Both-arm configuration | Baseline ms | Candidate ms | Paired change | Faster pairs | Median absolute A/A |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| JMnedict | After #298, defaults | 1148.00 | 1151.15 | +0.32% | 5/12 | 1.09% |
| WTY English | After #298, defaults | 6657.30 | 6368.65 | **-4.27%** | **12/12** | 1.09% |
| WTY English | After #298, generic spans on | 5612.60 | 5238.20 | **-6.73%** | **12/12** | 0.86% |

All six two-pair WTY block totals improve in each confirmation configuration. Defaults: -4.20%, -3.67%, -3.74%, -5.71%, -4.78%, -4.10%. Generic spans: -5.40%, -5.71%, -6.83%, -8.57%, -7.41%, -6.83%.

A/A variation is descriptive, not a confidence interval. No controls are subtracted, observations trimmed, unfavorable outcomes replaced or hosts pooled. The Japanese controls do not establish a useful speedup, and adverse observations are retained. Generic spans are enabled in both arms of composition cohorts; the result is incremental benefit, not a sum of earlier experiments.

## Protocol and audit

Fresh Chromium profiles, checksum-pinned full dictionaries, real OPFS-SAH-pool persistence and monotonic browser time from file-input change through import/UI completion. Builds, downloads, corpus checks and persisted-content probes are outside timing. No tracing, profiling, screenshots or process sampling during timing. Both arms are built at the same filesystem path from SHA-checked source. Per-observation package hashes are retained; ZIP metadata can vary.

The portable offline audit rereads every raw report and verifies actual worker receipts, full row counts/title/revision, twelve persisted-content probes, completion, storage mode and clock intervals. Within every native-key pair and control, source/encoded bytes, rows/chunks/groups/workers, failed fused attempts/discarded rows, deduplication counts, content/index writes and parser heap highwater match. Full-corpus content, numeric columns, hashes and completed lookup digests match across **3,273,372 distinct rows** in four dictionaries. Package-member comparison finds only C source and parser Wasm differ.

In the initial WTY cohorts, aggregate worker row decoding falls from 575 to 175 ms with defaults and 585.5 to 197 ms with generic spans. These parallel totals are diagnostic, not additive wall-clock costs. Lookup construction remains a separate cost.

## Completed validation

Final exact-source validation passes **7,381 unit tests**, with 46 existing skips; 27 options tests; all four TypeScript projects; changed-file ESLint; and the full build. Both strict Chromium lifecycle runs pass, recording 83 phases with defaults and 84 with generic spans. The initial runs passed with 82 phases each; these counts are preserved rather than represented as identical journeys. Source hashes are rechecked after all final runs. Normal PR CI and static-web acceptance pass on the published head.

The 21 new cases exercise escapes, control characters, Unicode/surrogates, invalid raw UTF-8, exact decoded-key length limits, reading equality, offset input views, multiple banks, fractional scores and wide sequences. The old routing-only assertion now requires native lookup bytes to match the JavaScript encoder exactly.

Supplementary local differential checks compare 10,240 generated rows and 16 decoded-length boundaries with original behavior and forced JS interning. The exact remote benchmark Wasm passes 3,360 arena-capacity/alignment cases, including 2,880 handled capacity failures, without altering guard bytes or previously committed keys. These checks supplement tests; they are not a formal proof.

## Rejected alternatives and retained costs

Four experimental flag configurations consumed 216 complete observations. On WTY, escaped fused decoding alone was +1.10%; single-bank fusion +7.19%; both fused flags +6.87%; direct lookup arena plus single-pass compaction -0.12%. Single-bank fusion increases failed fused attempts from 12 to 45 and discarded rows from 226,900 to 540,986. These flags remain off. Escaped fused decoding processes some escaped keys but still fails later; it is not a no-op. A separate descriptor-allocation candidate also failed to improve the production-staging component (+4.49%) and is excluded.

The synthetic no-escape, forced-non-fused preparation control is slower: +23.13% in the initial local Clang-17 cohort, and +3.36% in a separate 31-pair run of the actual remote Clang-18 Wasm with 7.83% median absolute A/A variation. Both are retained, not pooled or replaced. This does not establish zero overhead on unescaped non-fused workloads. Remote-Wasm component gains for one late escape (-31.47%, 30/31) and all escapes (-63.54%, 31/31) are not complete-import claims.

Initial validation retained an outdated lookup-routing expectation and new-test formatting failures. The corrected assertion is stronger byte equality; formatting fixes do not change measured runtime. A research-only delivery workflow succeeded while separate actionlint flagged unquoted `HEAD^{tree}`. Quoting was fixed and completed delivery changed to manual-only; no research workflow enters the product PR.

## Evidence, reproduction and limits

**536 successful complete timing observations**: 216 flag screens, 200 initial native-key observations and 120 independent confirmations. Breakdown: 56 excluded warmups, 160 A/A observations and 320 candidate/baseline measurement observations. Lifecycle journeys and component experiments are separate. Historical #291/#298/SIMD results are not pooled.

Session files: `manabitan-native-key-report.md`, `manabitan-native-key-plan.patch`, `manabitan-native-key-evidence.zip`. Evidence ZIP: 12,182,953 bytes, SHA-256 **`cb049f0901988202ac1c130d9ea68b8034061807b8b70a38198ab548f315c424`**. Extract and run `python3 analysis/audit-all.py` to audit all 536 observations. Internal manifest and ZIP CRCs were checked. No font files or full extension archives are bundled.

Apply the three-file patch to the pinned #298 parent or check out the published product head. WTY uses release `21b1b22cd655d7936d62b127e6404fbb8a88c7c3`, revision `2026.08.29`, ZIP SHA-256 `b9603db16dee82afd811386302ccd78bab591a6513b0d3194d937dc9110dd4a5`, 106,918,350 bytes and 1,643,040 rows. Its benchmark-only allowlist and larger off-clock probe buffers are equal in both arms. Other archives use the committed lock.

Qualification is Linux x64 Chromium, not Firefox/Safari/ARM timing or cold-OS behavior. Parser heap highwater is not whole-browser peak memory. Corpus equality is exhaustive at parser/lookup preparation; persisted contents are sampled. No universal dictionary speedup, total-memory improvement or exhaustive persisted-store equality is claimed.

- Flag screens: https://github.com/ManabiIO/manabitan/actions/runs/36184016216
- Initial routing failure, before native-key timings: https://github.com/ManabiIO/manabitan/actions/runs/36184891548
- Initial complete-import cohorts: https://github.com/ManabiIO/manabitan/actions/runs/36185320888
- Independent confirmation: https://github.com/ManabiIO/manabitan/actions/runs/36186782074
- Initial validation: https://github.com/ManabiIO/manabitan/actions/runs/36185153769
- Final full validation: https://github.com/ManabiIO/manabitan/actions/runs/36186417583
- Exact product delivery: https://github.com/ManabiIO/manabitan/actions/runs/36186997368
- Normal PR CI: https://github.com/ManabiIO/manabitan/actions/runs/36187263176
- Static-web acceptance: https://github.com/ManabiIO/manabitan/actions/runs/36187263022

Initial benchmark input `a1f3a891a96da1b980d4069f4847d5fefbce9a00`; confirmation input `19ea5eb2f7209def990c540ef6cd2637c3f6d6c0`; final validation input `853fe8387903d181b0f7338039e5f432af0d0e8e`. No measured runtime changes occurred between these cohorts.

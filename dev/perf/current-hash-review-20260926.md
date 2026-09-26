# Current import hash review — 2026-09-26

## Decision

Do not promote the long-input JavaScript hash specialization on this evidence. It is byte-compatible, but complete-import effects are small/mixed and overlap substantial unchanged-code ordering/noise. This is not proof that the implementation cannot help a different workload. No performance defaults or product hash source were changed.

Product baseline: `384d1c97dae6bd17555973b77ad415e038438499`, after the #323 correctness integration. Both arms use current production defaults, including generic shared-span compression, native segmented lookup and lookup scratch reuse. Other recorded experimental flags are false.

The correctness review separately produced #324, which rejects incomplete term-artifact imports or falls back to ordinary source banks before storage admission. Hash experiments are not in that PR.

## Exact retained candidate: independent current-code qualification

Candidate SHA-256: `12b275412b3930669ed7986f9d692ec12926c01716eb4447cbd6a238a2d4ace6`.
Baseline SHA-256: `3a661e6875bf8dcb4c3b9f301e79506539b27d83cb069b3d5566e9bad9346620`.

This is the exact previously retained candidate: a separate long-input XXH32 routine uses one bounded DataView for both seeds at 512 bytes or more; the existing short-input routine remains separate. The source checksum was asserted before builds.

Run: https://github.com/ManabiIO/manabitan/actions/runs/36222212587

| Corpus | Baseline median ms | Candidate median ms | Median paired change | Faster pairs | Median absolute A/A change |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | 1134.90 | 1110.50 | -2.86% | 8/12 | 2.83% |
| JMnedict | 741.45 | 757.60 | +0.72% | 4/12 | 3.16% |
| Jitendex | 2364.85 | 2336.40 | -1.11% | 11/12 | 1.25% |

Negative is faster. These are medians of within-pair ratios, not ratios of the marginal medians. Each corpus runs on its own host. A/A variation is descriptive, not a confidence interval, and is never subtracted from A/B. Retained slow observations materially affect equal-work totals; no sample was trimmed or replaced.

## Initial current-code screen: related variant, not pooled

Before the exact retained candidate was recovered, a related DataView long helper retained the original length>=16 conditional. Its source SHA-256 was `fedbd64cca85a6fb5eb8c8cbe616d9db2991629580abccf999d3844c41f6bd4f`. That screen is retained separately and is not presented as a replication of byte-identical code.

Run: https://github.com/ManabiIO/manabitan/actions/runs/36221674262

| Corpus | Baseline median ms | Candidate median ms | Median paired change | Faster pairs | Median absolute A/A change |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | 1354.40 | 1323.60 | -2.31% | 10/12 | 1.53% |
| JMnedict | 1134.45 | 1142.20 | +0.67% | 5/12 | 1.70% |
| Jitendex | 2419.60 | 2435.20 | +1.28% | 5/12 | 2.11% |

The initial JMdict A/A pair included a -35.60% change. It remains in the raw evidence rather than being removed as an inconvenient observation.

## Protocol and independent audit

Each cohort/corpus has 38 planned timing observations: two excluded warmups, twelve counterbalanced A/B pairs, and six bracketing A/A pairs. The exact-candidate cohort reverses initial arm order and uses independent hosts. Across both cohorts: 228 completed timing observations, plus six separate diagnostic imports. Corpus and variant results are not pooled.

Linux x64, Node 22.16.0, Chromium 153.0.8010.12. Fresh browser profiles, pinned real dictionary archives, OPFS-SAH-pool with no fallback. Timing is browser-monotonic file-input change through post-UI completion. Build/download/probes are outside timing. Trace, phase profiling, screenshots, process sampling and forced GC are disabled during timing. Both packages are built at the same filesystem path; the member-by-member comparison finds only `js/dictionary/term-entry-content-hash.js` differs. Generated build/license files can make the checkout dirty; package identities and exact source pin, rather than an inaccurate clean-tree claim, establish the comparison.

Each observation verifies expected title/revision and full term count, at least twelve readable persisted-content probes, no import/settings errors, current operation timing sequence, and executed parser/compression experiment receipts. An independent Python auditor rereads all raw reports and recomputes paired statistics. Stable work matches within every A/B and A/A pair: rows, chunks, source/encoded bytes, worker/group counts, discarded fused rows, parser heap highwater, dedup counts and recorded content/index write bytes. These counters do not prove total-browser memory equivalence or exhaustive stored-content equality.

Both implementations pass 10,550 differential hash/immutability cases, including boundary lengths, shared storage and nonzero-offset views. Hash compatibility is not a speedup claim.

### Pinned archives

- JMdict 2026-09-06: 526,942 terms; SHA-256 `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a`.
- JMnedict 2026-09-06: 667,942 terms; SHA-256 `d3afb02f2dbe4837ce1799c4a9fd9917bca6749c77a440ca87bc9f0890b3cd12`.
- Jitendex 2026.08.11.0: 435,448 terms; SHA-256 `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc`.

## Separate traffic diagnostic

Instrumentation was excluded from all timing statistics. Before bulk-finalization completes, the importing worker recorded 39 long JavaScript hash calls over 4,248,783 bytes for JMdict, and 19 over 1,497,826 bytes for Jitendex; neither recorded short calls. JMnedict's importing-worker counter was absent. Both cohorts agree.

This supports the inference that the earlier synthetic per-row JavaScript serialization benchmark overstated this helper's opportunity on these current default import paths. It does not measure every worker/context or imply that no hashing occurs elsewhere; native parser hashing remains in use.

## Limits

No WTY, MDict, macOS, ARM, Firefox or Safari comparative-performance run is included here. No total-process memory improvement is claimed. The correctness PR uses real archive/importer regressions with a storage fixture; these malformed-archive tests are not claimed as new OPFS browser E2E scenarios.

Raw reports, schedules, exact sources, parity scripts, actual executed drivers, audits, failure observations and qualification logs are retained in the two linked runs for 30 days and in the accompanying conversation evidence bundle. Product code does not include audit workflows or experimental hashing.

# Generic shared-span compression qualification — 2026-09-18

## Decision and exact source

The isolated `experimentalGenericSpanCompression` path is a material WTY import winner. Keep it opt-in in this PR; it is not an all-dictionary speedup or a claim about Safari/Firefox. The change removes intermediate JavaScript content packing and uses the existing native envelope path, without changing compression levels, dictionary training, worker count, scheduling, storage format, or lookup behavior.

The measured baseline is `fb7241deb70950dc113089cd774c9489ede48f8a`. The isolated runtime changes were reconciled into PR #55 at `1045c8da203093236e8200d96f863f5254ac562f`, preserving normal merge ancestry. All seven changed runtime/type files were byte-compared against the qualified source before that merge commit was published. The new real-codec test file changes no runtime behavior. This note is documentation-only.

## Complete-import results

Each dictionary used one fixed six-block same-build ABBA schedule: four excluded full warmup observations, twelve measured candidate pairs, and twelve interleaved A/A control pairs. All 208 observations across the four dictionaries were retained, including the slower WTY candidate observation. Fresh browser profiles and OPFS stores were used for each observation. No timing observations were retried, trimmed, or discarded.

| Dictionary  | Median paired change | Candidate pairs faster | A/A median paired change | Equal-work time change |
| ----------- | -------------------: | ---------------------: | -----------------------: | ---------------------: |
| WTY English |              -14.02% |                  11/12 |                   +0.52% |                -12.37% |
| JMnedict    |               -3.34% |                  11/12 |                   +2.02% |                 -3.53% |
| JMdict      |               +0.34% |                   5/12 |                   -0.90% |                 +0.10% |
| Jitendex    |               +0.42% |                   4/12 |                   +0.97% |                 +0.53% |

WTY arm medians were 4,474.35 ms off and 3,863.25 ms on. Every WTY ABBA block total improved: -12.52%, -17.14%, -9.77%, -3.19%, -17.05%, -14.40%. The one slower candidate pair (+6.96%) remains in the median and equal-work calculations. The JMnedict gain is modest; JMdict and Jitendex are effectively unchanged in this cohort. Do not pool absolute times between dictionary hosts or add this result to the separate native-lookup result.

Content-store write bytes were identical between both arms for every dictionary. WTY remained 133,821,475 bytes. Each report also checked exact pinned title, revision and row count, persisted content probes, effective worker/storage flags, successful finalization and non-fallback OPFS/SQLite storage. Source byte counts, bank counts, dedup counts, record/lookup writes, worker count and group count matched across arms.

The timing boundary is the raw report's browser-monotonic current-operation file-input-change event through post-UI import completion. The outer ABBA summary uses schema version 1; it validates the schema-3 browser timing contract rather than measuring process startup or a parser microbenchmark. Chromium was 153.0.8010.12 with Node 22.23.2.

## Reproduction and retained evidence

The research workflows and drivers are deliberately outside this product PR.

- [Four-dictionary isolated qualification](https://github.com/ManabiIO/manabitan/actions/runs/35388885914): completed JMdict, JMnedict and Jitendex cohorts plus the 83-phase browser lifecycle. Raw summaries, observations, source patch, fixture lock, hashes and drivers are retained in `generic-qualified-*` artifacts.
- [Completed WTY isolated qualification](https://github.com/ManabiIO/manabitan/actions/runs/35390043569): `generic-qualified-wty-complete`, artifact 10565517556, archive SHA-256 `6c979bb745dfabd94af0b142b1a165447e8add0a038dde4f4e351ac5357b94c5`.
- [Exact merged-source validation](https://github.com/ManabiIO/manabitan/actions/runs/35390147184): `generic-merged-source-validation`, artifact 10566221111. The retained `qualified-product-hashes.json` binds the merged files to the measured source.

The first WTY setup stopped before any browser observation because an existing 20 ms idle-worker unit test failed under file-level concurrency. All other dictionary hosts passed that same source. The subsequent WTY run serialized unit-test files without removing tests or weakening assertions; this completed the previously unmeasured cohort rather than replacing unfavorable measurements. The failed setup artifact and explanation are retained.

The complete WTY archive is pinned at SHA-256 `b9603db16dee82afd811386302ccd78bab591a6513b0d3194d937dc9110dd4a5`, 106,918,350 bytes, revision `2026.08.29`, 1,643,040 rows and 67 banks. Other fixtures use the committed dictionary lock. Wasm parser SHA-256 is `755344a733e0256999007a56aa2bae6d5cd2467433e9f79698b72513e5ff4702`.

## Correctness and checks

The exact merged product source passed 6,622 unit tests (46 existing skips), options tests, main/dev/benchmark TypeScript checks, changed-file ESLint and build-plan checks. The generic-enabled Chromium lifecycle passed 83 phases, including staged-update crash recovery, restart persistence, multi-file import, lookup behavior and deletion.

Six added real-codec tests exercise the compiled Zstd implementation rather than fabricated compression results: packed-versus-span frame/checksum equality, persisted reads at three block sizes, shared-source overwrite after consumption, non-zero source view offsets, gaps and odd boundaries, single-use prepared operations, per-import flag reset, and invalid-span rejection. Existing actual worker-message tests cover option propagation and source-consumption behavior.

Generic record-write overlap was also screened. Its incremental gain was much smaller than the shared-span change, so it was excluded rather than expanding this PR's concurrency surface.

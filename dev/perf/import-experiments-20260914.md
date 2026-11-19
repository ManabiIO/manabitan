# Codex instructions: import optimization experiments

## 2026-11-19: JMdict source optimization round

This round starts from `develop` commit `d829f5b6e6a75ee8859d38d537d224ec33c4930e`, tree `841406cd33f6871ab24aee771c1a7881d9e465f0`. The later sections retain the September flag-experiment handoff. Use the November identities below to reproduce this source comparison.

The target is complete JMdict import with current production defaults (`--flags '{}'`). Worker counts, group planning, cache budgets, compression settings, persistence formats, and dictionary fixtures are unchanged. All remote qualification uses Ubuntu; no macOS runner is involved.

**Outcome: retain the parser work in [draft PR #761](https://github.com/ManabiIO/manabitan/pull/761), without merging or claiming a reproducible complete-import speedup.** Row-token reuse improves the measured native-call interval, but its initial complete-import results disagree across hosts. The separate adjacent-key experiment has favorable final point estimates and a material unique-key regression on one host. It remains separate from the PR. The investigation retained all 396 browser observations: 360 measured imports and 36 warmups, across six independently audited cohorts. Neither hosts nor experiment stages are pooled.

### Candidates and exact artifacts

| Candidate                                   | Product commit                             | Parser WASM bytes | Parser WASM SHA-256                                                |
| ------------------------------------------- | ------------------------------------------ | ----------------: | ------------------------------------------------------------------ |
| Original baseline                           | `d829f5b6e6a75ee8859d38d537d224ec33c4930e` |            52,930 | `f1c029745da0eec890baf951249647fa7e0ce23fb3b1b83c51f34313f08f5fd5` |
| Row token facts plus constant integer bound | `45cc145f5273c100042b218eb4a0b5ce40bf5523` |            53,165 | `14dc09dcff3d42597be31ffbd7fdcc64f071a80cabc6cd4ba38df9e531cce446` |
| Incremental previous-row key reuse          | `97aa1167f5cbcd44e37d8cd39da48b8e693ba16b` |            53,391 | `2b0ee40a732c70b9ebe05bb37793141e91bf78ade202605e1d638b61d7c74a7b` |

The first candidate retains escape flags and bounded integer values from the existing row grammar scan, eliminating later scans of those same tokens. The witness is a 16-byte stack value reset for every row. It does not change `TermRowMeta`, exports, persistent formats, or parser admission. Negative-zero scores, fractions, exponents, overflow, malformed JSON, and omitted/null sequences preserve existing behavior. The overflow guard uses the exact constant quotient `214748364` and sign-dependent final digit instead of division in each digit iteration.

The second candidate adds 13 C lines. After existing escaped-key decoding and size admission, complete raw-token equality with the preceding row's same field permits reuse of its interned key ID. Current-row reading-equality metadata remains independent. The witness ends with the synchronous parse. The 20-group opportunity count found 393,110 matches, avoiding hashes of 5,185,253 key payload bytes plus table probes; these counts are not timing results. Opposite-field probing was rejected: 14 extra matches required 481,995 additional attempts.

Pinned dictionary WASM is part of the current source/build contract. These candidates include the rebuilt parser WASM and `dev/data/dictionary-wasm/manifest.json`, produced with Clang/LLD 21.1.8. The canonical scanner is unchanged (`40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af`). A clean pinned baseline rebuild matched byte-for-byte before experimentation.

### Qualification protocol and evidence

The first research commit is `3462f2336f586222eae2312ce699de90155128d2`; its [Actions run](https://github.com/ManabiIO/manabitan/actions/runs/44597837976) compares the first candidate with the original baseline. The incremental key research commit is `b57f1f930e350cf98ab4e41cc4f69e97e3a37f52`; its [Actions run](https://github.com/ManabiIO/manabitan/actions/runs/44600383900) uses `45cc145` as the baseline. Runtime sources remain frozen during each complete cohort.

Each comparison uses two independent Ubuntu 26.04 jobs, Node 22.22.0, release Chrome packages, and the pinned dictionary lock. Each host runs two excluded warmup triplets followed by twelve measured triplets. A and C are identical baseline packages; B is the candidate. All six arm permutations occur twice, with reversed starting order on the second host. Every observation creates a fresh browser profile and OPFS store. The timing boundary is the browser's file-input change through completion of the current operation's post-UI work. Tracing, phase profiling, screenshots, and process sampling are disabled during authoritative timing.

The runner checks clean Git commit/tree identity, runtime source hashes, unchanged browser helpers and dependency/fixture locks, exact packaged WASM, package SHA, browser version, production flags, successful OPFS persistence, exact dictionary identity and row count, and twelve readability probes. It rechecks source/package identity at completion. Failed observations abort the cohort and remain preserved; there are no retries, omitted tails, or stopping at favorable results.

Before browser timing, the existing full-output oracle compares every row and prepared index byte for JMdict (526,942 rows), JMnedict (667,942), and Jitendex (435,448). This oracle is component-level correctness evidence; its timing is not a complete-import result. After timing, one host runs the full release Chromium lifecycle and the other captures a separate diagnostic trace.

The key comparison additionally runs a native-only negative control: 20,000 rows with 20,000 unique expressions and 20,000 unique readings (40,000 distinct keys total), with common prefixes and two banks in one fused group. Twelve balanced triplets use fresh Node children; each child has three complete warmups, explicit GC, ten measured fixture repetitions, and a final untimed full-output fingerprint. Only the native fused export contributes timing. Allocation/setup, lookup construction, transport, compression, persistence, and UI are excluded. Every invocation must emit all rows with zero fallback. Runner SHA-256: `3c3ade3d3b28f5366575ddc4fbda252eb4952a9e9afa82f83df72ee2fbb5b066`.

The reusable browser runner is `test/perf/import-source-cohort.mjs` on the research commits, SHA-256 `969ab7216c250c466667a680394b2c44bd4d22eda2ec44cb2b3a4eb855a05de7`. Workflow files capture the complete build and execution commands. The first browser host reports Chrome 153.0.8010.12 and four available CPUs on an AMD EPYC 9V45 runner.

### First browser comparison: hold

Both hosts completed all 42 observations, all three dictionary byte oracles, and their post-timing gates. The parser change did not show a reproducible complete-import improvement. Negative percentages mean faster; positive percentages mean slower. Each row is a separate host, and absolute times are not pooled.

| Host / initial order | Median A / B / C (ms) | B/A equal-work | C/A identical-code control | B/C equal-work | B/geometric-controls equal-work (95% interval) | B/geometric-controls paired median |
| -------------------- | --------------------- | -------------: | -------------------------: | -------------: | ---------------------------------------------- | ---------------------------------: |
| EPYC 9V45 / CBA      | 814.7 / 772.7 / 811.3 |         -2.66% |                     -1.03% |         -1.65% | -2.13% [-6.47%, +4.56%]                        |                             -5.11% |
| EPYC 9V74 / ABC      | 953.2 / 980.0 / 942.5 |         +2.37% |                     +1.56% |         +0.80% | +1.65% [-1.18%, +4.42%]                        |                             +1.67% |

The intervals are descriptive paired percentile bootstraps of all twelve complete triplets (200,000 resamples, fixed NumPy seed 20261119). They do not establish absence of rare regressions or hidden host effects. CBA's worst candidate/geometric-control pair was +31.12%; it remains included. ABC's candidate was faster than geometric controls in only four of twelve rounds. **Decision: hold the source optimization as an experiment; do not promote it as a demonstrated import speedup.**

All oracle runs preserved native heap high-water marks and prepared index sizes: JMdict 61,603,840 / 19,446,728 bytes, JMnedict 46,989,312 / 26,292,164, and Jitendex 89,128,960 / 20,031,116. These are component heap/index observations, not whole-process peak memory or actual OPFS file-size measurements.

The release Chromium lifecycle passed 91 phases with OPFS SAH-pool storage, no skipped verification, and the exact package used by ABC timing. Coverage included initial JMdict/Jitendex imports, concurrent lookups during import/update, dictionary update, restart persistence, JMdict/JMnedict batch import, hover/Reader flows, and deletion. The four recorded import flows reported zero errors and no fallback storage.

The ordinary untraced reports support a narrower mechanism observation: the aggregate `parserParseBankMs` interval fell 10.97% on CBA and 4.92% on ABC against geometric controls, while identical-code C/A changes were -0.76% and -1.33%. Independent source and raw-report review confirmed one profile per group, twelve groups and twelve successful fused calls per observation. This is summed `Date.now()` elapsed time around native calls across three workers, including descheduling and overlapping intervals. It includes row validation, key interning, integer extraction, fused content encoding/hashing and within-group deduplication. It excludes inflation, JavaScript setup/copies, lookup preparation, transport, cross-group matching, compression, storage, and UI. Encoding is included in this fused interval even though the separate encode counter is zero. This is exploratory phase evidence, not CPU time or a complete-import gain.

### Incremental key reuse: hold

The two incremental browser cohorts compare the additional key reuse with the first parser candidate, not with the original source. Both completed all 42 observations and three full-row dictionary oracles before the later synthetic-control harness failure described below.

| Host / initial order | Median A / B / C (ms)    | B/A equal-work | C/A identical-code control | B/C equal-work | B/geometric-controls equal-work (95% interval) | Faster paired rounds |
| -------------------- | ------------------------ | -------------: | -------------------------: | -------------: | ---------------------------------------------- | -------------------: |
| KEY-CBA              | 944.95 / 918.2 / 914.85  |         -2.02% |                     -0.53% |         -1.49% | -1.71% [-3.49%, +0.03%]                        |                 8/12 |
| KEY-ABC              | 989.1 / 1004.4 / 1006.05 |         +2.87% |                     +2.88% |         -0.01% | +1.46% [-1.84%, +5.33%]                        |                 3/12 |

The worst candidate/geometric-control pairs were +2.85% and +18.03%, respectively, and remain included. These results do not replicate an incremental complete-import benefit.

The original unique-key control failed in its **untimed output checker**, after its first baseline child had completed three warmups and ten native measurements. The checker incorrectly required native prepared lookup indexes for this fixture; the normal parser can validly leave their construction to JavaScript. Both failed jobs, partial child reports, and timings remain in the evidence. Their browser results were already complete and were not rerun or discarded. Those partial synthetic timings are not qualified performance results.

The corrected runner prepares missing indexes with the production helper after taking a stable snapshot and before any subsequent native parse, outside timing, and requires the complete output fingerprint. Native timing, exact row counts, zero fallback, and clean-source checks remain intact. Runner SHA-256 is `15b3258e97898d3a8ddfa29ce539d79f70dddd9913e4e55a25e13d2860162ddf`; research commit `05fe95754c9a3efccc711a4ea08333ab5e4b98a5` and [run 44603297727](https://github.com/ManabiIO/manabitan/actions/runs/44603297727) contain the correction. The product remains unchanged at `97aa116`.

Both corrected cohorts completed: 72 fresh children, 216 warmup calls, 720 measured native calls, and 72 untimed verifications. Each emitted all 20,000 rows with zero fallback; all full-output fingerprints matched `1a2f70e79595f42118044def6035297c59ccf195d6a599d52f3eb4a3be2fae9e`.

| Native-only unique-key control | B/A equal-work | C/A identical-code control | B/C equal-work | B/geometric-controls equal-work |
| ------------------------------ | -------------: | -------------------------: | -------------: | ------------------------------: |
| ABC process CPU                |         -4.57% |                     -0.38% |         -4.20% |                          -3.98% |
| ABC elapsed wall               |         +0.02% |                     +4.66% |         -4.43% |                          -2.03% |
| CBA process CPU                |        +20.19% |                     +3.57% |        +16.05% |                         +20.64% |
| CBA elapsed wall               |        +10.22% |                     +1.84% |         +8.23% |                          +9.86% |

The CBA regression concern is not cleared by the favorable ABC result. These are native-only Node measurements, not browser import results or proof of a universal regression. They prevent promotion of the extra key comparison on the present evidence.

### Longer direct comparison: possible small gain, still hold

The final fixed comparison tests the full combined candidate `97aa116` directly against original baseline `d829f5b`. Research commit `73b5648e29387c4375158787c35a6f3922f68eda`, [run 44603681425](https://github.com/ManabiIO/manabitan/actions/runs/44603681425), and `.github/workflows/jmdict-final-source-qualification.yml` preserve its exact commands. Each host completed two warmup triplets and **36 measured triplets**; all six permutations occur six times. Runtime source, pinned WASM, browser runner, production settings, fresh profiles, and timer boundary remain frozen. Both hosts also passed all three full-row dictionary oracles and 386 focused tests. This phase does not repeat full unit/lifecycle coverage already obtained for the same product.

| Final host / initial order | Median A / B / C (ms)       | B/A equal-work | C/A identical-code control | B/C equal-work | B/geometric-controls equal-work (95% interval) | Faster paired rounds |
| -------------------------- | --------------------------- | -------------: | -------------------------: | -------------: | ---------------------------------------------- | -------------------: |
| EPYC 9V74 / CBA            | 936.30 / 925.65 / 950.60    |         -1.15% |                     +0.56% |         -1.70% | -1.38% [-3.10%, +0.40%]                        |                23/36 |
| EPYC 7763 / ABC            | 1049.55 / 1025.60 / 1047.25 |         -2.70% |                     +0.42% |         -3.11% | -2.87% [-4.33%, -1.32%]                        |                30/36 |

Candidate/geometric paired medians were -1.47% and -1.82%; the worst pairs were +11.85% and +14.28%. All observations are retained. For each triplet, the geometric control is `sqrt(A * C)`; the equal-work estimate compares total B time with the sum of those controls. The descriptive 95% intervals resample complete triplets 200,000 times with fixed seed 20261119, separately for each host. They do not account for every host effect or all exploratory selection.

Both final point estimates favor the combined candidate, and ABC's interval is below zero. CBA still includes no effect, the earlier incremental cohorts disagree, and the synthetic unique-key regression remains. **Decision: preserve this as a promising but unqualified combined experiment. Do not fold key reuse into the primary PR or promote either source change as a general 2–3% import speedup.**

### Local evidence and rejected directions

Local component timing was inconclusive. In the strongest token-only screen, 36 fresh children performed 2,160 timed native calls with identical complete output fingerprints and zero fallback. Candidate equal-work CPU changed by -6.30%, while source-identical controls changed by -12.61%; paired medians were -10.42% and -13.22%, respectively. The control drift exceeded the apparent improvement. These measurements do not establish a speedup and are not pooled with browser results.

| Direction                                               | Observation                                                                                                                                                        | Decision                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Hoist native key validation across segmented compaction | About 0.7 ms component difference across eligible groups, requiring a new trusted ABI/witness; no eligible groups in either the 12-group or 20-group configuration | Reject complexity for this payoff   |
| Direct two-pass storage field construction              | Component screen was 43% slower                                                                                                                                    | Reject                              |
| Combine three storage scratch allocations               | Approximately 0.15 ms / 1.18% difference, unresolved against noise                                                                                                 | Reject as unproven                  |
| Remove global key-plan copies                           | Global plans remain needed for storage splitting, mixed fallback, and materialization                                                                              | Defer without an ownership redesign |
| Cheap-field-first exact content comparison              | About 249 KB of glossary comparisons avoided at the cost of 81 KB of extra tag work                                                                                | Reject low opportunity              |
| Specialized glossary normalization                      | Every JMdict row already had normalization hints zero                                                                                                              | No opportunity on this fixture      |
| CDict/compression changes                               | Dictionary use depends on block size; sticky dictionary mode changes frames/output                                                                                 | Hold outside this source-only round |
| Share recent-content cache views                        | Parser and compressor arenas are mutable and reused after completion; retaining leases can stall later groups                                                      | Reject ownership violation          |
| Pack holes out of recent-content snapshots              | At most 916,307 bytes saved out of 100,795,188 copied (0.91%), adding gather/remap work and changing allocation accounting                                         | Reject                              |

The production cache already makes one owned contiguous interval copy per admitted group, not one allocation per unique entry. The worker returns a borrowed shared WASM content view; publication precedes storage completion; completion releases the worker lease; the next job resets and reuses that arena. Compressor input is also reusable native context memory. A cache optimization must retain the existing owned snapshot, exact admission/eviction, and charged allocation size.

In the first separate browser trace, all twelve groups used the fused parser with zero fallback. Recent-source caching copied 100,724,405 bytes and accounted for 151.9 ms inside 225.6 ms of metadata publication. There were 4,010 cross-group exact hits. Compression's 409.9 ms is nested inside concurrent content-store work, and worker parsing/inflation overlap importer storage. These diagnostic intervals locate work; do not add nested/parallel phase sums or treat them as projected import savings.

Later screens and audits reached these additional decisions:

| Direction                                                                 | Observation                                                                                                                                               | Decision                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Replace shared-source cache `.slice()` with allocation plus byte `.set()` | Fixed copy-only screen: +5.67% median CPU / +6.60% median wall against geometric controls; shared and ordinary equal-work totals also regressed           | Reject                            |
| Aligned word-copy cache snapshot                                          | Shared-source median -2.54% CPU / +1.42% wall, much smaller than identical-code scatter                                                                   | Reject as unsupported             |
| Suffix-first previous-key equality                                        | Saves 216,006 modeled source-load bytes on JMdict (1.48% of this comparison work), with added ordering/address/branch costs unmeasured                    | Defer; frozen candidate unchanged |
| Remove record-finalization barriers                                       | No duplicate physical write, flush, close, snapshot or reserialization found; independent sealing already overlaps and failure settlement precedes COMMIT | Reject                            |

The copy screen retained all 144 measured and 36 warmup observations across four cells (two methods, shared and ordinary source buffers), plus 512 alignment/bounds/ownership cases. It used the exact twenty admitted cache intervals and 100,795,188 payload bytes per pass, included exact-size destination allocation, and compared every output byte outside timing. Source-identical paired CPU ranges reached -39% to +42% for shared byte-set and -34% to +20% for shared word-set. No additional variants or timing reruns followed. These local Node data neither establish browser performance nor isolate the entire cache method's scan/mapping cost.

The 104.6 ms record close/finalization trace interval includes descriptor and lookup-container sealing plus bookkeeping. It does not isolate one syscall. The report records one 45-byte descriptor write, five lookup batches totaling 23,693,336 bytes, and 0.1 ms lookup-queue wait. The final forty-byte header is the incomplete-to-complete format boundary. The writer caches its close promise, flushes/closes once, and retains sticky failures. Store sealing already uses concurrent settlement before publication; successful cleanup skips already-sealed stores. Removing these operations has no source-level safety proof.

### Validation status

The first candidate passed 381 focused tests. The independent Linux full suite passed all 616 test files: 13,720 tests passed and 47 were skipped. The local full suite initially passed 13,700 tests with two native test files blocked by task-private linker discovery; after correcting `PATH`, all twenty tests in those files passed. No test assertion was weakened. All build targets pass. Main, dev, test, and bench TypeScript checks pass after adding a test-only `string[]` annotation to break an inference cycle; that annotation does not affect the measured runtime.

The key candidate passed 386 focused tests, the test TypeScript project, changed-file lint, pinned artifact checks, and untimed full-output parity against the combined baseline for both complete JMdict and the unique-key control. Its ordinary JMdict output fingerprint is `b8fb2ede709f7e5e0ae603304a10d9a8c190c755c48547df38287ae2660447ea`; the unique-key fingerprint is `098c43594368e4355336e6c9e543928e98fb125e760d7e1b65bbafd245bd2a65`. Fingerprints from different oracle layouts/grouping are not interchangeable.

Local browser launch was unavailable in this environment. Browser behavior and timing are qualified by the independent Linux CI runs above. Whole-process memory, complete persisted database equality, and all-browser performance are separate gates; component parity and readability probes do not establish them.

The combined key candidate's full Linux suite also passed all 616 files: **13,725 tests passed, 47 skipped**. Its corrected release lifecycle passed 91 phases with verified package identity and OPFS storage, including imports, updates, restart persistence, concurrent lookup, hover/Reader usage, and deletion. The separate concurrency-pressure test produced 99 intentional busy rejections in 180 attempts; retained error samples were `DICTIONARY_IMPORT_IN_PROGRESS`, with no `SQLITE_CANTOPEN` or suspension errors. These expected rejections are not counted as successful imports.

The primary draft PR head is `b9c9850a25eff3bb0684b8283cbb9b3c7ef49042`. Its only change after measured product `45cc145` is the test-only type annotation. Runtime source and WASM are identical. [Core PR CI](https://github.com/ManabiIO/manabitan/actions/runs/44606333570), [static web acceptance](https://github.com/ManabiIO/manabitan/actions/runs/44606333606), CodeQL, actionlint, dependency review, and the Chromium restart-interruption workflow passed. Core CI covers lint, four TypeScript projects, unit/options tests, package builds, Chromium extension E2E and the Anki matrix. Its Firefox job permits existing unsupported-runtime skips, so that job's success is not asserted as complete Firefox functional qualification. No merge, release, or change to production defaults was performed.

### Durable evidence and reproduction

The evidence branch `evidence/jmdict-import-20261119-3d067` contains this report and two machine-readable artifacts:

- `builds/perf/20261119-jmdict/observations.index.json`: archive SHA-256, file inventory, sizes, hashes, observation counts, and explicit exclusions.
- `builds/perf/20261119-jmdict/observations.json.gz`: deterministic compressed evidence containing the exact original report/log bytes, cohort plans, identities, all retained observations including failed controls, bootstrap analyses, native phase audits, source-copy screens, rejected prototype patches, runner source, and toolchain provenance.

The archive deliberately excludes dictionary payloads, dependency trees, duplicate downloaded ZIPs, generated HTML/screenshots, and repeated generated admission modules. It contains neither authentication credentials nor live signed download URLs. Downloaded artifact ZIP hashes and extracted-file hashes are retained. The exact release extension ZIP is identified and verified by CI but is not duplicated in this offline bundle. Raw phase reports and full-row oracles remain available without the binary dictionary payloads.

For a new qualification, start from the exact product/research commits above, use the checked-in `test/perf/dictionaries.lock.json`, reproduce Clang/LLD 21.1.8 and Node/Chrome identities, and follow the corresponding workflow's build and runner arguments. The final workflow is the complete source of the 36-triplet plan; the corrected negative workflow supplies the unique-key control. Verify pinned artifacts and source/package identity before timing. Use fresh profiles and keep tracing/sampling off for the primary endpoint. Run diagnostics separately. Reuse neither an old output directory nor a prior measurement as a replacement for an unsuccessful observation. The archived `analyze-import-cohort.py` computes the displayed estimates from each retained `cohort.json` independently.

The next useful qualification is a fixed comparison on representative user hardware with whole-process memory and persisted-size measurements, especially for unique-key dictionaries. Further changes to cache ownership, worker concurrency, compression, or publication barriers need their own design and controls; none is justified by treating overlapping trace intervals as removable time.

## Goal, baseline and rules

Qualify the implemented default-off experiments in `ManabiIO/manabitan`. Optimize full dictionary import completion time first and lookup latency second. Memory, extension package size and stored dictionary size are non-regression gates, not resources to spend freely for throughput. Do not tune worker counts, batch sizes, cache capacities, compression levels or dictionary-specific thresholds.

This lookup-construction round starts from `385857d029cb32160f05f4923e08712e34cc327b` (tree `29d3f1eb4649fa96cfab6751d327f7ae34bd906b`). That revision contains the six preceding parser flags and the supervised import-response reliability fixes. Record the exact new source commit, tree, toolchain, fixture hashes and browser version before running. If `develop` advances, reconcile the changes and repeat source-overhead controls; never combine measurements from different candidates.

Keep this document as the single handoff. Commands, implementation constraints, results and outstanding qualification belong here; do not require an accompanying archive to execute the work. Store machine-readable observations under `builds/perf/` or the CI run's evidence directory, not as extra handoff documents. Do not enable defaults or alter `main`, release branches, Manabi Reader's native importer or vendor pins.

## Implemented flags

All ten fields belong to `ImportDetails`. They are ephemeral per-import options, not persisted settings or UI preferences. Only boolean `true` enables one. `snapshotTermBankExperiments` creates a fresh immutable snapshot for the import and worker request. Native parser options are per-call bits, not mutable globals; lookup flags select JavaScript orchestration paths.

| Flag                                     | Work eliminated or replaced                                                                                                                 | Eligibility and costs to measure                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `experimentalTermBankSpans`              | Keeps CRC-verified inflated banks intact instead of copying their interiors into joined JSON.                                               | Compressed-source route; eight bytes of span metadata per bank. Does not force that route or widen admission budgets.                                                                                                |
| `experimentalNativeEscapedKeys`          | Decodes exceptional escaped expression/reading keys into the unused interner tail, avoiding a full-group retry.                             | Fused groups with escaped keys. Preserve resource/unsupported fallback and ordinary-key fast paths.                                                                                                                  |
| `experimentalValidatedGlossaryReuse`     | Reuses earlier glossary validation after complete byte equality, and passes that exact witness into content deduplication.                  | Existing four-row window; unique and common-prefix misses have previously regressed. Keep on hold until negative controls pass.                                                                                      |
| `experimentalFusedSingleBank`            | Enables existing fused parse/intern/encode/dedup for eligible single-bank groups.                                                           | Can increase native reservations despite avoiding JavaScript work. Qualify whole-process memory.                                                                                                                     |
| `experimentalGlobalExactContentReuse`    | Detects distant raw glossary/rules/tag duplicates before canonical encoding.                                                                | Fused group-wide native table; full equality remains mandatory. Unique content pays pre-hash and table costs.                                                                                                        |
| `experimentalFastGlossaryNormalization`  | Specializes scalar/string and exact text-object glossary arrays; unsupported shapes roll back into the general normalizer.                  | Nested structured content may pay probe overhead. Preserve exact normalization and media semantics.                                                                                                                  |
| `experimentalNativeSegmentedLookup`      | Constructs large groups' compact lookup segments in WASM rather than falling back to JavaScript.                                            | Complete fused groups crossing the 16-bit row/key limit. Uses the existing 30,000-row segmentation, one reusable native workspace and the unchanged v7 encoder. Without scratch reuse it can grow the WASM heap.     |
| `experimentalLookupScratchReuse`         | Reuses retired parser metadata and hash tables for lookup construction instead of allocating another native workspace.                      | One complete fused chunk only. Works independently for small native groups and with native segmentation for large groups. Insufficient retired space falls back to JavaScript without allocating new native scratch. |
| `experimentalDirectLookupArena`          | Writes base and derived lookup sections directly into one final v7 allocation, avoiding intermediate buffers and the final assembly copies. | JavaScript lookup preparation only; inactive when a prepared native index already exists. Treat an allocation reduction separately from a demonstrated speed gain.                                                   |
| `experimentalSinglePassLookupCompaction` | Validates the whole source key table once before synchronously compacting all lookup segments.                                              | JavaScript lookup preparation only. Every row/key reference still receives range checks. No validation cache survives the synchronous call.                                                                          |

Do not treat a requested flag as an executed optimization. For example, Jitendex groups commonly fit the existing small native path, so native segmentation may have no opportunity there. Native preparation makes the two JavaScript flags inactive. A dictionary with no escaped keys cannot establish an escaped-key gain.

## Why this round targets lookup construction

Use the captured baseline Chromium phase report only to locate work, not to estimate a release speedup. It showed large JMdict/JMnedict parser groups falling back to JavaScript lookup preparation, with repeated whole-key-table validation, compaction and final-buffer copying. The Jitendex fixture usually stayed on the small native path. Concurrent worker phase sums overlap and are not additive end-to-end CPU or elapsed time.

The native-segmentation idea also appeared in an earlier September 9 prototype. This is a current-baseline flagged implementation and re-evaluation, not a claim that segmentation has never been tried. Do not transfer old favorable percentages into this candidate. The additional retired-workspace experiment specifically tests avoiding the new native memory reservation.

## Implementation map and invariants

Read these source files before changing an experiment:

- `ext/js/dictionary/term-bank-experiments.js` and `types/ext/dictionary-importer.d.ts`: flags and immutable snapshots.
- `ext/js/dictionary/term-bank-wasm-parser.js`, `term-bank-wasm-parser-worker.js`, and `dictionary-importer.js`: admission, ownership, worker propagation and diagnostics.
- `ext/js/dictionary/wasm/term-bank-parser.c`: fused parsing, exceptional keys, exact reuse, normalization and `compact_term_lookup_keys`.
- `ext/js/dictionary/term-lookup-scratch.js`: bounds-checked retired-region address planner.
- `ext/js/dictionary/term-lookup-index-preparation.js`, `term-lookup-index.js`, and `term-record-preinterned-plan.js`: JavaScript preparation, compact plans and v7 encoding.
- `dev/build-libs.js`: native export list. Rebuild libraries after modifying C. Do not commit generated WASM or dependencies.

### Native segmented lookup

Preserve the existing row segment boundaries and uint16 sentinel rules. Compact each segment's keys in first-use order, then use the established v7 encoder. Reuse one native workspace across segments. Copy finished indexes and metadata into owned arrays before the next segment reuses that workspace.

The segment key byte view aliases the key section of its owned v7 index, not the WASM heap. The segment's compact IDs must travel with that segment's own plan. During worker ownership conversion, replace only a prepared index's reference to the global borrowed plan; do not replace already-owned compact segment plans with the global plan.

Capture source-layout offsets and counts before an allocation that can grow WASM memory. Recreate all views from the new memory buffer after growth. A view detached by growth must not supply a later allocation size or become a returned result. Preserve global group plans needed for subsequent storage splitting.

The native compactor validates contiguous key spans, row references, equality flags and output capacities. Complete equality and existing normalization semantics remain authoritative. Failed native preparation falls back through the established JavaScript preparation path, and its spent time remains in diagnostics.

### Retired parser scratch

Only the row metadata arena and completed string/content hash-slot tables are eligible. Source bytes, canonical content, content metadata, interned keys, row IDs, reading flags, scores and sequences are still live and must not be reused.

Address planning is read-only. Actual lookup writes happen after all row and media decoding has finished, and only when the whole fused group is emitted as one chunk. Validate region bounds, alignment and non-overlap. Do not allow a region to outlive its current parse/heap generation.

An insufficient region plan must discard planned addresses and use the JavaScript fallback. Planning failure must not partially overwrite data or silently allocate another native arena. Test cases where several allocations fit but a later one does not. A reused worker must not retain a flag, address plan or successful-validation witness from an earlier request.

### JavaScript construction

Direct-arena encoding changes allocation placement only. Require byte-identical base, derived, header, checksum, offset and sequence sections. Typed-array alignment and padding must match the original representation.

Single-pass compaction validates the source once within one synchronous operation, then retains every segment's row/key checks. Reset touched remap entries in `finally`, including malformed late rows. Do not introduce a WeakMap validation cache, time-based cache or asynchronous trusted-plan token.

### Existing parser flags

Each bank remains an independent bounded JSON document; a truncated token must never consume the next bank. Fallback owns preloaded bytes before heap reset and retains bank boundaries. CRCs cover the original bank bytes, with exact compressed consumption and decoded-size checks unchanged.

Escaped keys must match `TextEncoder(JSON.parse(token))`, including surrogate pairs and replacement behavior. Preserve the raw-reading equality representation: literal and escaped tokens can decode to the same key but still carry different explicit-reading metadata. Compare persisted lookup bytes, not just displayed strings.

Glossary equality is not equality of rules, tags or whole term content. Samples or hashes can reject a candidate but cannot authorize reuse without complete equality. Fast normalization must roll back its output cursor and preserve general fallback on unsupported shapes.

## Activation and accounting

Inspect effective snapshots plus disjoint per-group `term-file-fast-path:*` reports. Relevant profile fields include:

```text
fusedParseAttempts / fusedParseFallbacks
discardedFusedParseMs / discardedFusedRows
bankSpanCount / escapedKeyDecodeCount / fusedSingleBankGroups
validatedGlossaryReuseCount / globalExactContentReuseCount
fastGlossaryNormalizationCount / fastGlossaryNormalizationFallbackCount
nativeSegmentedLookupSegments / nativeSegmentedLookupFallbacks
nativeLookupScratchReusedBytes / nativeLookupScratchReuseGroups
nativeLookupScratchReuseMisses
directLookupArenaSegments / directLookupArenaCopiedBytesAvoided
lookupCompactionSourceValidationPasses
lookupIndexPrepareMs / lookupIndexCompactMs / lookupIndexEncodeMs
maxWasmHeapBytes
```

Importer diagnostics prefix these with `parser` and summary fields with `fastPathParser`. The overall summary can refer to the last fast-path profile, not all groups. Aggregate disjoint group reports exactly once, never both a report and its aggregate.

`nativeLookupScratchReusedBytes` counts planned native scratch allocations avoided. Summing it across groups is not peak memory saved. The maximum individual worker heap is not total concurrent worker memory. Native segmented lookup timing includes compaction and encoding together; do not label it encoding-only CPU time. Failed native work and later JavaScript fallback time both count.

Confirm activation separately from authoritative timing. Diagnostic logging, tracing, screenshots and process sampling must be disabled in timing runs. Do not enlarge logging limits or change admission to manufacture an opportunity in a claimed production-like result.

## Build and functional qualification

Use repository-pinned versions, not upgraded tools or dictionaries:

```sh
git fetch origin
git switch develop
git status --short
git rev-parse HEAD HEAD^{tree}
mise install
npm ci
npm run build:libs
node dev/perf/prepare-dictionaries.js
```

`test/perf/dictionaries.lock.json` is authoritative: JMdict has 526,942 term rows, JMnedict 667,942, and Jitendex 435,448. Verify archive hashes and record the lock hash. Do not silently replace these fixtures with newer dictionaries.

Run the focused suites after each source change:

```sh
node node_modules/vitest/vitest.mjs run \
  test/lookup-construction-experiments.test.js \
  test/term-bank-experiments.test.js \
  test/term-bank-wasm-parser.test.js \
  test/term-bank-composite-state.test.js \
  test/term-bank-parser-string-scan.test.js
```

The new lookup suite covers all 16 combinations of the four new flags with the preceding six enabled, plus individual paths and failures. The preceding parser suite separately covers its 64 combinations. This is not exhaustive coverage of all 1,024 ten-flag combinations.

Require owned output to remain unchanged after another parse, memory growth, worker reuse and transfer. Cover 65,534/65,535/65,536-row boundaries, multiple segments, compressed banks, small native groups, fallback groups, malformed unused key metadata, late invalid row IDs, equality flags, output exhaustion and insufficient retired workspace. Reconstruct omitted optional offset/hash metadata in the oracle only when it is genuinely absent; never normalize incorrect supplied metadata away.

Run all remaining validation lanes and record each independently:

```sh
npm test
npm run test:unit:options
npm run test:playwright:integration
npm run test:e2e:chromium-extension
npm run test:e2e:firefox-extension
node node_modules/vitest/vitest.mjs bench --run
```

Run strict browser functionality with defaults and the experimental combinations. Chromium accepts `MANABITAN_E2E_IMPORT_FLAGS_JSON`; verify Firefox override plumbing before relying on the same environment variable. The native and JavaScript preparation flags need separate executions because they can bypass each other. Include the retired-workspace flag with both small native groups and native-segmented groups.

A green unit suite is not full browser/OPFS qualification. A green E2E with all flags requested is not proof every path executed. Preserve actual execution counters and do not weaken assertions or suppress failures. Reproduce unrelated failures on the exact parent rather than inheriting an old baseline-failure exception.

## Reproducible component screening

The committed `dev/perf/import-lookup-screen.js` runs every lexical row in each pinned dictionary through parsing and completed lookup preparation. It checks archive hashes, validates ZIP entries and compares every prepared index byte, compact key plan, row flags/scores/sequences and canonical content digest outside the timed region.

The boundary is resident decoded term banks through parser and lookup completion. It excludes fixture I/O/inflation, worker IPC, global persisted deduplication, Zstd, OPFS and UI. Fixed component grouping is seven JMdict banks, nine JMnedict banks or ten Jitendex banks per group; it is not an assertion that production planners make those exact partitions.

Each child has two excluded complete warmups and GC before measurement. Each pair uses fresh child processes and alternating AB/BA. A is all flags false; B is exactly the requested object. The runner rejects changed source identities, byte mismatches and incomplete observations. After-verification RSS and lifetime maxRSS include other work and are not whole-import peak-memory measurements.

```sh
node dev/perf/import-lookup-screen.js jmnedict --pairs 8 \
  --flags '{}' --out builds/perf/lookup-aa.json
node dev/perf/import-lookup-screen.js jmnedict --pairs 8 \
  --flags '{"experimentalNativeSegmentedLookup":true}' \
  --out builds/perf/lookup-native.json
node dev/perf/import-lookup-screen.js jmnedict --pairs 8 \
  --flags '{"experimentalNativeSegmentedLookup":true,"experimentalLookupScratchReuse":true}' \
  --out builds/perf/lookup-native-reused.json
node dev/perf/import-lookup-screen.js jitendex --pairs 8 \
  --flags '{"experimentalLookupScratchReuse":true}' \
  --out builds/perf/lookup-small-native-reused.json
node dev/perf/import-lookup-screen.js jmnedict --pairs 8 \
  --flags '{"experimentalDirectLookupArena":true}' \
  --out builds/perf/lookup-direct.json
node dev/perf/import-lookup-screen.js jmnedict --pairs 8 \
  --flags '{"experimentalSinglePassLookupCompaction":true}' \
  --out builds/perf/lookup-compaction.json
```

Repeat on JMdict and Jitendex where the path executes. Use `--initial-order BA` in an independent replication. For the all-off source comparison, prepare a separate clean parent worktree, install the identical dependencies and rebuild its own WASM, then pass `--baseline-root /absolute/path/to/parent` with `--flags '{}'`. Never point both source arms at the same generated WASM by accident. `--cache-dir` can select an existing locked dictionary cache.

Run timing sequentially on a quiet host. Do not run builds, tests, other benchmark cells or profilers concurrently on that host. Freeze sources and generated binaries for the complete cohort. If a source changes or a competing process contaminates it, retain the observations as invalid exploratory data and rerun the entire predetermined cohort. Do not salvage selected favorable pairs.

## Full browser benchmark protocol

Pre-register at least 12 adjacent alternating AB/BA pairs per dictionary/runtime cell, excluded warmups, interleaved A/A controls and an independent replication with reversed initial order. Treat cold-start and warm-start as separate conditions. Use fresh profiles and identical persistence mode, source route, concurrency, compression and feature options.

Run three distinct comparisons: original parent versus candidate with all flags false; same candidate binary all false versus one flag; and same-binary A/A. Source-overhead controls are mandatory even if the enabled variant wins. The existing runtime A/B entrypoint does not compare source revisions; orchestrate separately built worktrees for that gate.

Clear inherited flag overrides before using the A/B wrapper. A baseline with an inherited all-enabled environment variable is not a control:

```sh
unset MANABITAN_E2E_IMPORT_FLAGS_JSON
for dictionary in jmdict jmnedict jitendex; do
  node dev/perf/import-ab.js "$dictionary" --pairs 12 \
    --flags '{}' --label lookup-aa
  for flag in experimentalNativeSegmentedLookup experimentalLookupScratchReuse \
    experimentalDirectLookupArena experimentalSinglePassLookupCompaction; do
    node dev/perf/import-ab.js "$dictionary" --pairs 12 \
      --flags "{\"$flag\":true}" --label "$flag"
  done
  node dev/perf/import-ab.js "$dictionary" --pairs 12 \
    --flags '{"experimentalNativeSegmentedLookup":true,"experimentalLookupScratchReuse":true}' \
    --label native-with-retired-scratch
done
```

Also requalify the preceding six flags individually with the same entrypoint. Only then test justified interactions: native segmentation plus retired scratch; either with bank spans or single-bank fusion; direct arena plus single-pass compaction; and selected parser combinations. Native preparation can mask both JavaScript flags, so an all-enabled speedup cannot qualify those independently.

Time the actual file-input change through completion of the current operation's post-UI work. Do not end at worker completion or defer required persistence/index work into the first lookup. Disable phase profiling, screenshots, process sampling and verbose byte diagnostics. Profile and sample memory in separate runs.

Report per-pair ratios, median paired change, equal-work total change, uncertainty intervals, worst pair, all failed runs and control variation. Do not pool unrelated hosts, discard slow tails, stop at a favorable result or report a point estimate from an incomplete plan. An A/A variation comparable to the proposed gain means the result is inconclusive.

## Memory, storage, lookup and reliability gates

Measure total browser/process-tree peak and settled memory, JavaScript heap, WASM high-water pages across concurrent workers, retained buffers after successive imports, GC and canceled-import cleanup. Native segmentation alone can increase heap reservations; compare it explicitly with retired scratch reuse. Verify fallback does not grow a new native workspace when reuse admission fails. Keep real constrained hosts distinct from device-memory emulation.

Compare actual OPFS file sizes and compressed content totals, as well as all row counts, canonical unique-content counts, definitions, reading representations, indexes and lookup ordering. Deterministic v7 index bytes must match. Content compression settings and formats must not change. Hashes and small readability probes alone do not prove full persisted database equality.

Exercise cancellation and worker failure before/after lookup preparation, staged updates, reimport, rollback, browser restart and recovery. Repeated worker requests must reset flags and scratch lifetimes. An index key view sharing its owned output array must not be detached before term-record encoding consumes it.

After reopening, measure cold/warm exact, deinflected and prefix lookups, first popup content, repeated hover at varying speeds, media, dictionary switching and updates. Check lookup continuity during another import. Import gains must not move latency or memory into normal reading.

## Evidence interpretation and decisions

Treat preceding synthetic parser percentages as historical component evidence only. The four-row glossary reuse experiment previously slowed unique/common-prefix input, and global exact reuse has unique-input pre-hash costs. Preserve those negative controls, along with nested structured-content normalization fallback, early/late escaped keys and single-bank memory checks.

Do not revive rejected SIMD hashing/scanning, inline canonical hashing, sampled-only fingerprints, aligned-copy/gather, ZIP splitting or old-stack packing variants based on earlier favorable runs. PR #19's withdrawn UI percentages remain withdrawn. CDict and shared parser/compressor memory remain separate unqualified ideas; no new scheduler or persistence format is introduced here.

For every flag, return an accept/hold/reject decision based on its actual executed path, end-to-end effect and memory/storage/lookup gates. Correct implementation is enough to retain a default-off experiment for qualification, not enough to enable it. Keep an allocation-only flag on hold when its speed effect is inconclusive. A material complete-import benefit, or removal of a reproduced severe exception-path cliff with negligible normal-path cost, is required for promotion.

Update this same Markdown with exact source/build identities, completed commands, immutable evidence locations, quantitative results with boundaries, and remaining lanes. Leave all defaults false until those gates pass.

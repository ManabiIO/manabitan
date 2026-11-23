# Codex instructions: import optimization experiments

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

The committed [import-lookup-screen.js](import-lookup-screen.js) runs every lexical row in each pinned dictionary through parsing and completed lookup preparation. It checks archive hashes, validates ZIP entries and compares every prepared index byte, compact key plan, row flags/scores/sequences and canonical content digest outside the timed region.

The screen enables `validateGlossaryTypes`, matching the production importer's supported-type and required-field checks, and records that option in each observation. Older screen results that omit it measured a different parser workload and should not be compared directly.

The boundary is resident decoded term banks through parser and lookup completion. It excludes fixture I/O/inflation, worker IPC, global persisted deduplication, Zstd, OPFS and UI. Fixed component grouping is seven JMdict banks, nine JMnedict banks or ten Jitendex banks per group; it is not an assertion that production planners make those exact partitions.

Each child has two excluded complete warmups and GC before measurement. Each pair uses fresh child processes and alternating AB/BA. A uses its source revision's default flags; B overlays the requested object on its source revision's defaults. The runner rejects changed source identities, byte mismatches and incomplete observations. After-verification RSS and lifetime maxRSS include other work and are not whole-import peak-memory measurements.

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

Repeat on JMdict and Jitendex where the path executes. Use `--initial-order BA` in an independent replication. For a source comparison with default flags, prepare separate parent and candidate worktrees, install identical dependencies and rebuild each revision's own WASM, then pass `--baseline-root /absolute/path/to/parent --source-root /absolute/path/to/candidate --flags '{}'`. Both source roots default to the runner's checkout. The parent checks every child's reported source root, WASM hash and validation mode against its requested arm and the binaries read before the cohort. Check those recorded identities before interpreting a comparison. Before the November 19, 2026 correction, the parent runner ignored `--source-root` and always used its own checkout for B. `--cache-dir` can select an existing locked dictionary cache.

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

## November 22, 2026: VNDB duplicate media projection screen

[PR #799](https://github.com/ManabiIO/manabitan/pull/799) moves the existing canonical media deduplication check before duplicate source-row key projection when fused columns, an emitted content slab, and omitted term byte lists already provide the complete output. The runtime diff is nine lines. Its status is **hold: complete component parity passed, timing inconclusive**. The independent eager metadata correctness fix is [PR #798](https://github.com/ManabiIO/manabitan/pull/798).

The committed [evidence package](../../builds/perf/20261122-vndb-projection/README.md) includes the exact runnable component harness, a portable four-triple scheduler and summarizer, the complete oracle, every raw timing observation and log, source-equivalence receipts, and validation history. The fixture is the explicitly selected VNDB Characters by Bee release, SHA-256 `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`, with 6,648,310 terms in 665 banks. It is not added to unconditional fixture downloads.

Baseline was `5e1f8c12f7ff798ba407323aff675cb23b22af02`. Isolated timing candidate `6e6b8180265682a9c6af92219f82d08e56ae78f2` has the same tree as published candidate `0541343dfb9426317763185db03153bdafc96228`. Node 22.22.0, the dependency lock, and WASM were fixed. The earlier complete oracle candidate `dbb19c26b9359f5abc237e5bb14ffd1c3f90d3f7` includes the independent importer fix; its recorded component sources are byte-identical to the isolated candidate and its only other tree differences are outside the component import graph.

The oracle compares every deterministic row/content/deduplication/key-plan field, each complete prepared lookup map including segment plans, and projected media records across all 170 production-shaped groups. All 170 group digests match. The 146,725 per-group media representatives are not a count of the archive's 146,570 distinct WebP files. Archive and source hashes are verified outside timing. This proves component-output parity, not persisted browser database or media payload equality.

Each timer covers native compressed source inflation, fused parsing, owned result/image projection copying, and completed lookup preparation. Source ZIP reads, hashing, module loading/compilation, browser workers, worker overlap, global persistence, OPFS, and UI are excluded. There are no excluded warmups; each arm starts a fresh process. The fixed schedule contains four A/B/C triples with identical baseline code in A and C. All 12 arms completed every source row with zero fused fallbacks and no source changes.

Candidate measured-time changes relative to the mean enclosing baselines were **+2.99%, −24.83%, −10.60%, and +8.57%**; negative means less time. Unchanged baseline C/A drift was **−10.82%, +35.85%, +26.89%, and +15.30%**. The −3.81% median and −5.94% aggregate changes are descriptive only because control variation exceeds the apparent effect. No component or full import speedup is claimed. Preserve this entire cohort; do not retain only favorable triples.

Focused sequential unit validation passed 365/365 tests, changed-file ESLint and seven build dry runs passed, and main TypeScript passed. The original contended unit failures and local full-test TypeScript OOM remain recorded. A CI-discovered test-helper type omission was fixed separately and passed focused type validation. Full CI and browser timing results are recorded below; peak memory, exhaustive persisted-output equality, and reopened lookup performance remain separate gates.

## November 22, 2026: consecutive container closes

Candidate `1dbc40224` against `develop` `5e1f8c12f` validates adjacent nested
`]`/`}` tokens in one loop, retaining every container-state, depth, and glossary
required-field check. This is distinct from the earlier close/comma experiment:
commas still take their existing path. The pinned Clang/LLD 21.1.8 build adds
100 WASM bytes (54,596 → 54,696); it adds no parser allocation or retained state.

Initial Jitendex screen: Node 22.22.0, the locked 2026.08.11.0 archive, four
alternating AB/BA pairs, two excluded complete warmups per child, default flags,
and `validateGlossaryTypes: true`. The measured boundary is decoded term banks
through parser and completed lookup construction, excluding inflation,
compression, persistence, workers, and UI.

| Pair | Order | Baseline (ms) | Candidate (ms) |  Change |
| ---- | ----- | ------------: | -------------: | ------: |
| 1    | AB    |      1,752.82 |       1,945.28 | +10.98% |
| 2    | BA    |      1,733.71 |       1,624.06 |  −6.32% |
| 3    | AB    |      1,767.80 |       1,579.38 | −10.66% |
| 4    | BA    |      1,166.97 |       1,036.20 | −11.21% |

Median paired change: −8.49%; equal-work total: −3.68%; 3/4 pairs faster.
All observations preserve the 435,448 rows, complete output digest,
20,031,116 index bytes, and 89,128,960-byte maximum parser WASM heap.
The large baseline drift and one slower pair require independent reversed-order
replication and same-code controls. **This is component screening, not evidence
of a complete-import speedup or browser peak-memory equivalence.**

Raw observations, source/tool hashes, and the exact selected roots are retained
in `builds/perf/jitendex-close-chain-screen.json`. Reproduce with
`node dev/perf/import-lookup-screen.js jitendex --pairs 4 --baseline-root <parent> --source-root <candidate> --cache-dir <locked-fixtures> --flags '{}' --out <report>`.
The 1,410 focused parser/import tests, scoped ESLint, and all seven dry-build
targets pass. Full PR #797 CI subsequently passed at the published runtime
commit. Three incomplete local full-unit attempts contain failed-test entries
or worker-termination timeouts; the local type run ends with `Killed`. None
counts as a pass. Their original logs are retained with the hosted evidence.
JMdict/VNDB controls and complete-import browser results are recorded below.

## November 22, 2026: complete-import browser qualification

The frozen [configuration](import-qualification-20261122.json), [driver](import-qualification-20261122.py), and [workflow](../../.github/workflows/import-qualification-20261122.yml) qualify the two proposed runtime changes against `5e1f8c12f7ff798ba407323aff675cb23b22af02`. [Run 45102947664](https://github.com/ManabiIO/manabitan/actions/runs/45102947664) uses research commit `b6a3e6567b78a1ced6fb005ec868537542ac2f87`; all source, runtime, package, and fixture identities are recorded before imports.

| Case            | Dictionary             | Candidate                                  |
| --------------- | ---------------------- | ------------------------------------------ |
| parser-jmdict   | JMdict                 | `2663832da942d3ce0ccefb5609ef17b7d0ae9371` |
| parser-jitendex | Jitendex               | Same shared parser candidate               |
| parser-vndb     | VNDB Characters by Bee | Same shared parser candidate               |
| media-vndb      | VNDB Characters by Bee | `0541343dfb9426317763185db03153bdafc96228` |

Each case has separate forward/reverse jobs: eight jobs, 336 planned imports. Each job has six excluded warmup imports and twelve measured A/B/C triplets. A/C use the identical baseline package; B uses the candidate. The six permutations of A/B/C repeat twice; the reverse job reverses the complete measured stream. Every import has a fresh profile. No measurement retries, discarded tails, or pooling across jobs.

The existing release harness measures the page file-input change through post-UI import completion with production defaults, without profiling/screenshots/process sampling. Its persistence probes and full browser restart run after timing. Exact package-entry allowlists and identical temporary harness overlays bind both source arms. Only VNDB cells add the extra fixture to the temporary lock. Twelve persisted-content probes are sampled validation, not exhaustive storage equality.

Analysis requires all 42 imports in a cell plus a completion receipt containing the observation and source hashes, written after final source/package checks. It reports candidate B/A and B/C separately from unchanged-code C/A controls; it does not declare a winner. Failed setup or an incomplete cohort cannot emit performance aggregates. Linux Chromium timing does not establish Firefox, ARM, or peak-memory performance.

Reproduce on an extension-capable host with Node 22.22.0 and the pinned Playwright Chromium. First run `python3 test/import-qualification-20261122.test.py` (eight contracts). Then run the driver phases below using a new output/source directory; retain the entire output directory even on failure.

```sh
python3 dev/perf/import-qualification-20261122.py prepare --case parser-jitendex --direction forward --output /tmp/manabitan-study-results --sources /tmp/manabitan-study-sources
python3 dev/perf/import-qualification-20261122.py run --case parser-jitendex --direction forward --output /tmp/manabitan-study-results
python3 dev/perf/import-qualification-20261122.py analyze --case parser-jitendex --direction forward --output /tmp/manabitan-study-results
```

The workflow is scoped to the research branch and relevant tooling paths; evidence/report-only commits do not restart the frozen cohort. All eight jobs preserve artifacts on success or failure. The completed results follow.

### Completed browser results: hold both performance candidates

All eight frozen cells completed, comprising **336 successful imports: 48 excluded warmups and 288 measured imports**. Runtime was Node 22.22.0, Playwright 1.63.0, and Chromium 153.0.8010.12 on Linux x64. Every import passed the exact dictionary title, revision, row-count, sampled-content, and full-browser-restart checks. Every cell's receipt, source/package identity, schedule, per-observation report, and timing arithmetic was independently reviewed.

The [preserved hosted evidence](../../builds/perf/20261122-hosted-qualification/README.md) includes all nine provider artifacts: the eight successful cohorts and the original zero-observation setup failure. It retains the captured study sources, package-entry hashes, every raw observation, warmups, host snapshots, validation history, and per-file checksums. The [machine-readable summary](../../builds/perf/20261122-hosted-qualification/summary.json) includes every paired delta, descriptive bootstrap interval, faster-pair count, worst pair, and unchanged-code comparison.

Negative percentages below mean less elapsed import time. Each row is one complete independent hosted cohort; no results are pooled across hosts. B is the candidate, while A and C use the identical baseline package with fresh profiles. Each value shows the paired median followed by the equal-work total change.

| Candidate / dictionary | Stream  | B/A median / equal work | B/C median / equal work | C/A median / equal work |
| ---------------------- | ------- | ----------------------: | ----------------------: | ----------------------: |
| parser-jmdict          | forward |       -0.188% / +0.285% |       -0.872% / -0.609% |       +0.633% / +0.899% |
| parser-jmdict          | reverse |       +1.190% / +0.965% |       +0.607% / +1.008% |       +0.330% / -0.043% |
| parser-jitendex        | forward |       -0.611% / -0.327% |       +1.239% / +0.773% |       -1.494% / -1.092% |
| parser-jitendex        | reverse |       +0.821% / +0.514% |       -0.203% / -0.180% |       +0.919% / +0.695% |
| parser-vndb            | forward |       -1.939% / -1.242% |       -2.544% / -1.727% |       +1.290% / +0.493% |
| parser-vndb            | reverse |       +0.225% / -0.202% |       +0.034% / -0.272% |       +0.137% / +0.071% |
| media-vndb             | forward |       -0.426% / -0.550% |       -0.740% / -0.653% |       +0.039% / +0.104% |
| media-vndb             | reverse |       -0.720% / -0.592% |       +0.127% / +0.011% |       -0.753% / -0.604% |

**Shared parser, PR #797: hold.** JMdict and Jitendex do not show consistent improvement across independent cohorts or both baseline comparisons. The initially favorable VNDB result has intervals spanning zero and substantial unchanged-code variation; its recovered reversed-stream cohort is effectively flat. The local Jitendex component screen does not establish a full-import benefit. The C/WASM candidate remains a draft and is not recommended for performance promotion.

**Media projection, PR #799: hold.** Both forward candidate intervals include zero. In the reversed stream, the B/A improvement (-0.592% equal work) is reproduced by unchanged C/A (-0.604%); B/C is +0.011%. The component oracle and browser checks pass, but complete-import timing does not establish a repeatable benefit. This candidate also remains a draft.

Across the completed VNDB imports, diagnostics confirm 170 fused-parser attempts over 665 bank spans, zero fused fallbacks or discarded rows, three parser workers, and 170 groups. The importer reports 146,570 media records and 91,670,244 owned parser-content bytes. These observations establish the native route; there is no dedicated counter for the individual close-chain or duplicate-projection skip. Media counters do not prove persisted image-payload equality.

The actual schedule consists of twelve counterbalanced A/B/C triplets per cell. Both measured streams begin `ABC`; reverse means reversal of the complete stream. The older literal adjacent AB/BA and opposite-initial-order lanes above were not executed by this study. These results provide controlled timing evidence, with no promotion recommendation. Exhaustive persisted database/index/image equality, whole-browser peak and settled memory, reopened lookup latency, ARM, and browser-specific performance remain outside this timing study. No additional qualification lanes were run after the complete-import benefit failed to distinguish itself from controls.

### Setup recovery and validation record

Initial job `137457712078` (`parser-vndb/reverse`) timed out during locked-fixture provisioning, before preparation completed or any import began. Its artifact records **0/42 observations**. The log does not identify which archive timed out. After all seven other cohorts completed and all eight original artifacts were downloaded and verified, only that job was rerun at the original research SHA. Recovery job `137465254519` completed the unchanged 42-import schedule. This is setup recovery, not replacement of failed or unfavorable measurements. The original failure artifact and log remain in the evidence archive alongside the successful recovered cohort.

All runtime implementation heads pass complete unit, type, build, Chromium/Firefox extension, and restart/interruption CI:

- Parser `2663832da942d3ce0ccefb5609ef17b7d0ae9371`: [CI 45101578986](https://github.com/ManabiIO/manabitan/actions/runs/45101578986).
- Media projection `0541343dfb9426317763185db03153bdafc96228`: [CI 45102104773](https://github.com/ManabiIO/manabitan/actions/runs/45102104773).
- Image-persistence fix `c1c4ad76cf298ef99a5aa747fe6641e5bdd112db`: [CI 45102616028](https://github.com/ManabiIO/manabitan/actions/runs/45102616028).
- Research implementation `f335d1070b4cb7f208903293469ca8c060f7a8c6`: [CI 45104691201](https://github.com/ManabiIO/manabitan/actions/runs/45104691201). The one-line JSON inventory registration fixes its initial CI omission without changing frozen measurement inputs. Its eight Python contracts and all 150 JSON type tests pass.

Earlier local failed or incomplete test attempts, the missing generated-library prerequisite, the initial image-test-helper type error, and the research JSON inventory failure are retained as separate validation history. Later passing CI does not turn those attempts into passes.

The independent image-persistence correction in [PR #798](https://github.com/ManabiIO/manabitan/pull/798) is ready for review as a correctness fix. Its regression reproduces missing shared-image data on the parent when metadata resolution is enabled and passes after first references are resolved before duplicates. It has no performance claim and is outside the frozen timing candidate matrix.

## November 23, 2026: six additional import candidates and complete qualification

All six new performance proposals remain **HOLD / draft**. The [complete round report](../../builds/perf/20261123-r2-qualification/README.md) preserves exact source identities, phase boundaries, correctness oracles, all ratios/controls/tails, memory coverage failures, and reproduction instructions. Its [machine-readable results](../../builds/perf/20261123-r2-qualification/summary.json) contain all 36 independently audited timing cells. This extends the preceding report without replacing its earlier failures or conclusions.

Baseline is `5e1f8c12f7ff798ba407323aff675cb23b22af02`; Node 22.22.0, Playwright 1.63.0, Chromium 153.0.8010.12 and Clang/LLD 21.1.8 are pinned. The six runtime candidates are separately based on that baseline, with no unmeasured combined stack. Local/publication mappings and complete tree hashes are in the retained source ledger.

| Candidate                                                                         | Published runtime commit                   | Purpose                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| [#812 — SIMD inflate copy](https://github.com/ManabiIO/manabitan/pull/812)        | `5555f3efd3e0c8baa99e93b4c14e7f1889c30383` | Ordered SIMD match copying                                   |
| [#816 — Lookup initialization](https://github.com/ManabiIO/manabitan/pull/816)    | `3a4ef7ed11dd6b0509c12ad495ab8f591b68872b` | Avoid overwritten initialization                             |
| [#817 — CRC word halves](https://github.com/ManabiIO/manabitan/pull/817)          | `4884b4bd93d45f152ec828bcca44990f18976a05` | Replace 64-bit CRC shifts with word halves                   |
| [#818 — Leading glossary strings](https://github.com/ManabiIO/manabitan/pull/818) | `524b41a112a1ba0b1ac31723da274c97d5525653` | Consume leading strings before generic parsing               |
| [#820 — Owned key buffers](https://github.com/ManabiIO/manabitan/pull/820)        | `8fe5926cec1396a05ed4ea52be751e48784329b7` | Reuse owned key buffers with cache-retention safeguards      |
| [#822 — Record validation](https://github.com/ManabiIO/manabitan/pull/822)        | `cf1e18d59d08da729d4b2fe45c7a07021f42360a` | Hoist reference dispatch within a synchronous validation run |

### Completed browser timing

The frozen literal adjacent AB/BA protocol and independent reversed-order jobs completed **1,512 imports: 216 excluded warmups plus 1,296 measured imports**, containing 432 candidate pairs and 216 identical-code control pairs. Each of the 36 cells has six warmups, twelve candidate pairs and six interleaved controls, with a fresh process/profile for every import. No timing observations were rerun, replaced or removed. Every source/package/native-work receipt, browser file-input clock, stored probe digest, publication and restart check passes independent audit. The twelve browser content probes remain sampled readback, not exhaustive persistence equality.

Negative percentages mean faster. The compact table shows candidate/parent equal-work changes **forward / independent reverse**. Full paired medians, descriptive intervals, same-code controls and worst pairs remain in the linked report, with no host pooling or control subtraction.

| Candidate                                                                         |          JMdict |        Jitendex |            VNDB |
| --------------------------------------------------------------------------------- | --------------: | --------------: | --------------: |
| [#812 — SIMD inflate copy](https://github.com/ManabiIO/manabitan/pull/812)        | -3.02% / +0.01% | -0.29% / +0.81% | +1.48% / +0.64% |
| [#816 — Lookup initialization](https://github.com/ManabiIO/manabitan/pull/816)    | +1.27% / -0.10% | +0.56% / -0.49% | -0.34% / +1.12% |
| [#817 — CRC word halves](https://github.com/ManabiIO/manabitan/pull/817)          | -0.67% / -1.21% | +0.56% / -0.78% | -0.79% / -2.96% |
| [#818 — Leading glossary strings](https://github.com/ManabiIO/manabitan/pull/818) | -0.22% / +0.13% | -1.09% / -0.69% | +0.00% / +1.72% |
| [#820 — Owned key buffers](https://github.com/ManabiIO/manabitan/pull/820)        | +0.11% / +0.93% | +0.22% / +1.60% | +0.67% / -1.03% |
| [#822 — Record validation](https://github.com/ManabiIO/manabitan/pull/822)        | -1.09% / +2.22% | -0.30% / -1.01% | +0.38% / -0.92% |

Native lookup preparation, CRC and key-copy phase counters show some reductions, but do not establish the material complete-import gain required above. Worker phase durations overlap and cannot be summed into critical-path savings. The favorable CRC/VNDB reverse cell does not reproduce forward. The owned-buffer VNDB forward median hides +12.05% and +13.07% slower pairs; retaining them produces its +0.67% equal-work result. Record validation has a retained +44.27% JMdict reverse pair and only small, unreplicated whole-import changes.

### Copy volume, memory and correctness

The owned-buffer proposal #820 removes 8,301,780 / 9,706,463 / 202,591,586 bytes of copying across full JMdict / Jitendex / VNDB component imports, with exact committed-source output parity. The retained-cache safeguard avoids keeping the full sidecar alive through row key views. These counts are cumulative copy volume, not simultaneous retained bytes or peak-memory savings.

Its separate frozen ABBA/BAAB memory campaign completes 24 functional imports; 22 memory observations and four complete cells qualify. Per-host median sampled PSS changes are Jitendex −0.54% / −4.79% and VNDB −2.29% / −2.52%. Both JMdict cells remain unqualified because a stable two-thread zombie leader fails the frozen single-thread exemption. Every raw scan/failure is retained, with no retry or observer relaxation. The observer covers the discovered full Chromium descendant tree; these non-atomic sampled maxima include startup, import, readback and restart, and do not establish exact import peaks, settled memory or three-corpus memory nonregression.

The inflate and CRC oracles compare all 5,169,815,579 decoded archive bytes with the parent and independent Node zlib. Lookup/flat/owned-buffer oracles compare full deterministic component outputs across all three corpora. The record-validation oracle compares 23 exact-source serialized sidecar/run/error cases, including malformed/shared/fixed references and mutations across awaits. It is not a full-dictionary persistence oracle. All six exact runtime heads pass complete executed CI, including full types, units, reproducible builds and Chromium/Firefox extension checks; conditional skipped jobs are not passes.

### Retained evidence and commands

The [hosted archive](../../builds/perf/20261123-r2-hosted/README.md), [record-validation hosted archive](../../builds/perf/20261123-r2-record-hosted/README.md), [component archive](../../builds/perf/20261123-r2-components/README.md) and [ownership archive](../../builds/perf/20261123-transfer-ownership/README.md) retain raw bytes, exact sources, complete schedules, provider ZIP inventories and SHA-256 member indexes. The existing fixed lookup/flat screens retain noisy controls. CRC stops at killed `02-C` after three successful arms; no component benefit is claimed. Type exit 137, lint/setup failures, original offline reviewer errors and the memory README link-check failure are preserved alongside later passing checks.

Completed local protocol checks: eight browser driver contracts, eleven memory driver contracts, five compiled process-witness tests and eight new evidence integrity tests. Completed evidence checks recompute all browser results and verify every frozen archive member. Reproduce integrity checks from the repository root:

```sh
python3 test/import-r2-evidence-20261123.test.py
python3 dev/perf/import-r2-evidence-20261123.py verify builds/perf/20261123-r2-hosted
python3 dev/perf/import-r2-evidence-20261123.py verify builds/perf/20261123-r2-record-hosted
python3 dev/perf/import-r2-evidence-20261123.py verify builds/perf/20261123-r2-components
```

The report links immutable workflow sources and all successful runtime CI runs. Evidence/report-only changes do not restart frozen benchmarks. Performance candidates remain draft because complete-import benefit is unqualified; no scheduler, batch, compression, format or default policy was changed in the accepted branch. Exhaustive persisted content/media/index equality, reopened lookup latency, exact/settled memory, constrained hosts and ARM/browser-specific speed remain separate gates. Do not promote reduced write/copy volume or a favorable isolated cell as a whole-import win.

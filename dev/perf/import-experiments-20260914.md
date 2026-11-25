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

## November 25, 2026: compression contexts, record splits, and dense ZIP names

This round starts from `develop` commit `7d1643e6147a10cb2165e9744cf0e63b59e46632`, tree `99d23f16e973c7ae9feba77ca3643d1c27dfb93d`. Three independent draft PRs remove allocation or decoding work from existing paths. Their component results do not establish complete-import latency or browser process-memory improvements. No worker-count policy, cache budget, compression setting, persistent format, or experimental default was changed.

| PR                                                     | Published source commit                    | Validated source tree                      | Scope                                                                                      |
| ------------------------------------------------------ | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [#891](https://github.com/ManabiIO/manabitan/pull/891) | `b9cf94b4cc088cb4e06a4ae5cae6b29a7ae59241` | `b4e35f00c7219a071f8871f1c3e39ebf017831b1` | Avoid an unused decoder context in compression workers, including the Jitendex import path |
| [#897](https://github.com/ManabiIO/manabitan/pull/897) | `475d351ff07c1b5cfc5651d7f59c624629e4fdc5` | `59959442e3d7ec9290d9da5d1177a7df28b58ed1` | Preserve the existing direct record-field encoder through trusted internal splits          |
| [#901](https://github.com/ManabiIO/manabitan/pull/901) | `ea176867e66515d12f7a75c044d1082624ce76cd` | `e6674d7451bfa720f288ce2bec723167e0ec1d1b` | Borrow raw-name views on demand and decode validated ASCII ZIP names once                  |

The source commit for #901 precedes this documentation/evidence-only addition. Local commits have different commit metadata but identical trees; their identities are preserved in the receipts. These PRs were tested separately, not as a combined runtime branch.

### Frozen inputs and retained evidence

The [evidence archive](../../builds/perf/import-20261125-f0f7/) includes original executed runners, raw observations, unsuccessful attempts, source snapshots/patches, portable reproduction wrappers, CI receipts, package comparisons, and an independent arithmetic/source audit. `manifest.json` hashes every archived file except itself. The wrappers were parameterized after the observations and syntax-checked; they were not used to generate the original reports. Historical absolute paths identify the original execution environment, while portable wrappers accept new checkout paths explicitly.

The lock file for this round has SHA256 `60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89`. The following counts describe this locked revision and supersede earlier historical counts for this round only:

| Fixture  | Archive bytes | Term rows | Archive SHA256                                                     |
| -------- | ------------: | --------: | ------------------------------------------------------------------ |
| JMdict   |    15,645,766 |   528,299 | `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f` |
| Jitendex |    38,831,822 |   436,555 | `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356` |
| VNDB     |   291,705,969 | 6,648,310 | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` |

Local component work used Node 24.22.3 on a shared Linux host. Hosted browser CI used the repository-pinned Node 22.22.0. Dependencies, native binaries, and dictionary fixtures were not upgraded. Heavy local work was serialized; interference from other host activity remained visible in timing controls.

### Compression workers: avoid an unused decoder context

PR #891 uses the existing compression-worker realm marker to omit eager native decoder construction in that realm. Normal initialization retains its eager decoder and cleanup behavior. A compression worker that later needs dictionary decompression allocates and reuses its decoder lazily, with retryable initialization failure. Compression bytes and the normal generic decoder path remain unchanged.

The pinned native allocator probe observed **95,816 bytes of additional allocator spacing per decoder context**, after subtracting the 16-byte blank-marker spacing. Four omitted contexts therefore correspond to **383,264 bytes of allocation spacing**. This four-worker value is arithmetic from the single-context probe, not a measured concurrent pool. The initial WASM buffer remained **16,908,288 bytes per module** in every probe case. No RSS/PSS, process peak, or complete-import memory reduction is claimed.

The native WASM SHA256 is `ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc`. The [original receipt](../../builds/perf/import-20261125-f0f7/zstd/allocator-original-receipt.json) records every pointer, module/source hash, and boundary. Thirty focused tests cover the real checked WASM and production worker, owned/shared exact compression bytes, later decoding, and failure/retry behavior.

### Record splits: retain the existing direct encoder

PR #897 carries the factory-origin proof into fresh internal split chunks only after checking the current parent, exact private index subview, and unchanged reference columns. External, proxy, accessor-backed, shared, subclassed, replaced, or unrelated views retain the generic validation path. Existing value checks still run after awaited appends. Segment boundaries and encoded bytes remain unchanged.

The [completed JMdict replay](../../builds/perf/import-20261125-f0f7/jmdict/record-split-jmdict-replay.json) parses **all 528,299 rows for each policy** using the current byte-balanced planner and actual record/envelope encoders. Baseline and candidate complete checksummed envelopes compare byte-for-byte within every group. Deterministic valid source-content spans stand in for resolved content references; compression, global deduplication, browser OPFS, and UI are outside this boundary.

| Existing worker policy | Groups | Split groups | Output segments | Rows benefiting | Offset/length staging allocation and copying avoided |
| ---------------------- | -----: | -----------: | --------------: | --------------: | ---------------------------------------------------: |
| 2                      |      8 |            5 |              18 |         348,299 |                                      2,089,794 bytes |
| 3                      |     12 |            0 |              12 |               0 |                                                    0 |
| 5                      |     20 |            0 |              20 |               0 |                                                    0 |

The reduction is six temporary bytes per affected row, supported by the source allocation path and observed typed-column copy counts. Common score-column copying remains. This is cumulative allocation/copy work, not peak live memory. The three- and five-worker policies show zero benefit and must remain visible in any summary. Seventy-eight focused tests across five files include sixteen new split, fallback, mutation, and asynchronous revalidation cases.

Neither attempted VNDB record replay completed. The eager archive attempt exited 137 with zero observations; the exact signal cause was not independently established. The file-backed follow-up produced an empty log and no report; its session/exit status was lost during context compaction and remains unknown. Both receipts and both distinct runner versions are retained. Neither attempt supports VNDB term counts, parity, memory, or timing results for this encoder change.

### Dense ZIP names: retained memory and complete media preparation

PR #901 keeps the compact filename-byte arena and original per-entry geometry, with borrowed `rawFilename` views created on demand. A logical filename mutation cannot change original raw-name geometry; mutations through the borrowed bytes still share the underlying arena. After complete directory validation, one ASCII decode and exact string slices replace per-entry decoding. The pinned VNDB archive therefore goes from **147,237 decoder calls to one** without changing directory admission, local-header/CRC checks, cancellation, or bounded read budgets.

The chosen candidate's fixed six-block A/B/C study contains **six candidate observations and twelve unchanged-control observations** in eighteen fresh Node processes. Its twelve candidate/control comparisons reuse those six candidate observations. Forced-GC retained `heapUsed + external` changed from **40,750,180 to 29,752,304 bytes**, a median reduction of **10,997,876 bytes (26.99%)**. All paired reductions lie between 10,996,700 and 10,997,876 bytes. The extra decoded-string backing is included; `arrayBuffers` is already part of `external` and is not added again.

This is retained catalog memory in Node, not total browser/process peak memory. Catalog timing is inconclusive: paired candidate/control medians were -13.60% against A and -21.42% against C, while identical-code C/A drift was +25.71%, with individual controls ranging from -48.75% to +95.87%. These observations support no latency percentage. The archive retains the entire earlier lazy-view-only cohort as well: 27,794,092 retained bytes, but noisy/slower construction observations and one unchanged-control drift of +503%. Neither cohort was filtered to favorable samples. A preliminary decode-only idea was rejected because it increased retained memory by about 1.96 MB; the chosen combination includes that cost and still reduces total retained catalog memory.

The complete catalog metadata/raw-name digest covers all 147,237 entries. Production media batching validates **every one of the 146,570 images**, including every-image CRC, with identical full digests for the **195,649,882-byte source span** and **3,912,816-byte generation index**. Both arms use 144 bounded reads and decode 188,131,284 image bytes. This establishes complete source-media preparation parity by full digests and per-image CRC, not exhaustive term encoder or persisted database equality. The [parity receipt](../../builds/perf/import-20261125-f0f7/vndb-combined/parity.json) retains complete byte counts and hashes.

All 140 focused catalog, raw-reader, packing, and alias tests pass. Three unchanged generic media tests initially hit the five-second deadline; those failures remain recorded. Targeted baseline/candidate reruns and the full combined suite passed with an explicit thirty-second cap. The original five-second failure was not reproduced on the baseline and is not labeled an established baseline failure.

### Validation and release-package accounting

Changed-file lint, source review, and diff whitespace checks passed. PR #891's [final-source CI](https://github.com/ManabiIO/manabitan/actions/runs/45640482102) passed all applicable jobs: 647 unit-test files, 14,556 passed tests and 47 skipped tests, all four TypeScript projects, lint, build/native reproduction, actual Chromium E2E, and actual Firefox execution with 62 phases. Its first test-only TypeScript import error was fixed before this final run; the earlier failure is retained in the receipt. PR #897's [source CI](https://github.com/ManabiIO/manabitan/actions/runs/45641123182) also passed all fifteen applicable jobs, with four conditional jobs skipped. Both PRs passed all seven associated workflows, including static web acceptance and restart/interruption recovery.

PR #901's [source CI](https://github.com/ManabiIO/manabitan/actions/runs/45642151404) passed all applicable jobs and all seven associated workflows. Actual Chromium E2E completed 90 logged phases with its final PASS; Firefox completed 62 phases with status success, without an unsupported-runtime skip. Static web acceptance completed 24 browser checks, and the restart/interruption workflow passed its strict report-enforcement gate. The build lane passed all seven targets and reproduced the pinned native binaries. The archived receipt identifies the source head and merge tree; subsequent evidence-only commits retain these runtime files unchanged.

Four sequential `npm run build -- --target chrome` builds succeeded without tracked generated changes. Each package contains 616 entries / 551 files. Complete decompressed-entry SHA256 comparison found exactly the intended runtime JavaScript change in each candidate, no added/removed/unexpected entries, and identical hashes for all five WASM assets. Against the 17,273,796-byte baseline ZIP, #891 adds 176 bytes, #897 adds 467 bytes, and #901 adds 554 bytes; corresponding uncompressed JavaScript increases are 771, 2,012, and 2,392 bytes. These are measured package costs, not zero-size-change claims. The [package audit](../../builds/perf/import-20261125-f0f7/package/package-audit.json) includes all per-entry manifests and build logs. Its first manifest write hit ENOSPC after successful builds; complete hashes/sizes were preserved before removing only the four audit-created ZIPs, and the comparison completed without rebuilding.

Local broad checks that were interrupted or killed under resource pressure are not counted as passes. A stopped baseline full-unit attempt and unsuccessful local browser provisioning are also excluded. Hosted browser execution supplies the functional coverage; it does not replace the controlled complete-import performance protocol above.

### Reproduction and decision

Prepare isolated checkouts at the baseline and published source commits in the table, using the same dependency lock and each checkout's own generated libraries. Fetch the PR heads if the commits are not yet local, then run `npm ci` and `npm run build:libs` in each checkout. Use the archives selected by that baseline's `test/perf/dictionaries.lock.json`; `node dev/perf/prepare-dictionaries.js` prepares the repository's pinned cache. The runners verify the relevant fixture/source identities. Run sequentially on a quiet host, writing new output to a separate directory.

From the archived evidence directory:

```sh
python3 verify-integrity.py
mkdir -p /path/to/new-output

# Original native allocator sequence, with fresh modules per case.
node zstd/reproduce-allocator-spacing.mjs /path/to/baseline \
  > /path/to/new-output/allocator.json

# Complete pinned JMdict encoder replay; default worker policies are 2,3,5.
python3 jmdict/reproduce-jmdict.py \
  --baseline /path/to/baseline \
  --candidate /path/to/pr-897 \
  --cache /path/to/dictionary-cache \
  --output /path/to/new-output/jmdict

# Complete catalog and source-media preparation parity.
node vndb-combined/reproduce-check.mjs \
  --baseline-root=/path/to/baseline \
  --candidate-root=/path/to/pr-901 \
  --fixture=/path/to/dictionary-cache/vndb_characters_by_bee.zip \
  --out-dir=/path/to/new-output/vndb-parity

# Fixed eighteen-process retained-memory/control cohort.
node vndb-combined/reproduce-measure.mjs \
  --baseline-root=/path/to/baseline \
  --candidate-root=/path/to/pr-901 \
  --fixture=/path/to/dictionary-cache/vndb_characters_by_bee.zip \
  --out-dir=/path/to/new-output/vndb-memory
```

The earlier VNDB candidate can be reconstructed by applying `vndb-lazy/source.patch` to the frozen baseline; its corresponding wrappers accept the same explicit path arguments. `jmdict/source-only.patch` preserves the complete JMdict source/test delta. `vndb-combined/source-from-baseline.patch` preserves the final VNDB runtime source delta; its tests remain available in the published source commit.

**Decision: retain all three as draft PRs for qualification.** The measured reductions justify review, but promotion still requires controlled complete-import latency, concurrent browser/process memory, persisted output/storage comparisons, and lookup/recovery nonregression at the complete workload boundary. The VNDB component proof does not substitute for a complete VNDB term import. Do not combine these different allocation/retention measurements into one memory-saving total or present them as an end-to-end speedup.

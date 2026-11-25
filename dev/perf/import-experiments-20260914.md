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

## November 25, 2026: native key placement and metadata-key recognition

This round compares develop `7d1643e6147a10cb2165e9744cf0e63b59e46632` with the combined runtime changes from [PR #894](https://github.com/ManabiIO/manabitan/pull/894) and [PR #895](https://github.com/ManabiIO/manabitan/pull/895). PR #894 stages compacted lookup keys directly in the final native index output, removing a separate key scratch reservation and the encoder's subsequent copy. PR #895 recognizes complete, bounded ASCII metadata-key literals before falling back to general JSON string scanning. Both preserve existing validation and output formats. This round changes no experiment defaults.

The complete bounded replay matched output digests for all **7,613,164 lexical rows**, spanning 937 term banks and 114 groups. The key-placement change eliminates **191,153,998 bytes of encoder key copying across 270 native segments** in this replay. This is deterministic work accounting, derived from the native segments' actual key-buffer lengths and the removed copy; it is not an elapsed-time result or a full-import speed claim. The Jitendex groups use the smaller native index path and contribute no segmented key-copy elimination.

### Frozen evidence and source identities

The [evidence directory](../../builds/perf/import-20261125-7b5a/) contains the complete [corpus report](../../builds/perf/import-20261125-7b5a/combined-corpus-parity.json), [execution log](../../builds/perf/import-20261125-7b5a/combined-corpus-parity.log), original [jitendex-corpus-parity.mjs](../../builds/perf/import-20261125-7b5a/jitendex-corpus-parity.mjs), initial failed test logs, corrected lookup-suite logs, and `SHA256SUMS`. The runner's historical filename is retained even though it covers all three dictionaries. It has not been reformatted or edited after the recorded run.

The JMdict and Jitendex branches are `perf/jmdict-import-20261125-7b5a` and `perf/jitendex-import-20261125-7b5a`. Public and local commit IDs differ because publication recreated commits with identical trees:

| Revision                                   | Commit                                     | Tree                                       |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| Baseline develop                           | `7d1643e6147a10cb2165e9744cf0e63b59e46632` | `99d23f16e973c7ae9feba77ca3643d1c27dfb93d` |
| PR #894, fixture corrected                 | `8a191ce3f6a0b843ff195c086e7b8ff6e59245fd` | `30829deb9035d98f68a53e48cf313f017afb374a` |
| Equivalent local JMdict commit             | `1ee0bf85a369a443056ba2762e97d68c7d8fa38d` | `30829deb9035d98f68a53e48cf313f017afb374a` |
| PR #895                                    | `36fd7a27b7aa631fc8aa20bd70a9f125850499cb` | `f0d5739c8344b4d14d6b51e0e740e0908e444400` |
| Equivalent local Jitendex commit           | `1162ffe4ac9389113a622673e33aa2e5c8a9ae72` | `f0d5739c8344b4d14d6b51e0e740e0908e444400` |
| Combined replay snapshot                   | `ea0f20b5e38d730b6b3cc87431d4f12387f4d153` | `4e3cc40350142d3a62f2922ce005aa29d62c0cc6` |
| Combined snapshot after fixture correction | `d708112ca8a84622f52f4ac0db61c27f4e85a164` | `ee8ab314e4d28a24aa8f0a1d02e17db71b6b09fe` |

The replay predates the fixture-only correction. All nine recorded runtime file hashes match both the committed replay snapshot and the corrected combined checkout. The complete hashes are in the raw report; the primary source and binary identities are:

| SHA-256                 | Baseline                                                           | Combined                                                           |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `term-bank-parser.c`    | `a2ef54fc8f66997097c49f2734e60544890f26f77223bbad0cafa82147e8b67d` | `1cbb935397f851384c09159f3ae699251163b51b7d6f03ea71aa32ee3baa3834` |
| `term-bank-parser.wasm` | `913da48a70eebfe8dfe8d96b60064cf0d472db3eccb2c12771686696cb78005c` | `f3bb4ab538cce77a8f9681b853aba10bcfd62cd0b6ec63cb40429bf05d561d83` |

The frozen runner SHA-256 is `500486caf2d77c9481414df75bd68ebfc11927c373e5d328d8e476512cd808b6`; the fixture-lock SHA-256 is `60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89`. These dictionaries and row counts are the November 25 lock snapshot, distinct from the older qualification round above:

| Dictionary | Archive SHA-256                                                    |      Rows |
| ---------- | ------------------------------------------------------------------ | --------: |
| JMdict     | `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f` |   528,299 |
| Jitendex   | `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356` |   436,555 |
| VNDB       | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` | 6,648,310 |

### Replay configuration and equality boundary

The run used Node 22.22.0 with `--expose-gc --max-old-space-size=512`. Each source root had its own WASM module instance, reused across JMdict, then Jitendex, then VNDB. Each group used already-decoded source banks, with seven banks for JMdict, ten for Jitendex and eight for VNDB. These fixed component partitions do not reproduce the production worker planner.

The exact parser options were:

```json
{
  "singleChunk": true,
  "emitTermByteLists": false,
  "computeContentHashes": true,
  "emitContentSlab": true,
  "emitTokenBinaryContent": true,
  "mediaHintFastScan": true,
  "validateGlossaryTypes": true,
  "prepareLookupIndexes": true,
  "experimentalNativeEscapedKeys": true,
  "experimentalNativeSegmentedLookup": true,
  "compactContentMetadata": true
}
```

`experimentalNativeEscapedKeys: true` is an explicit override of the default-off escaped-key path. Native segmentation is explicitly enabled; retired scratch reuse follows the existing default-on resolution in the compared source revisions. This selected configuration is not evidence for every flag combination or for default-only full imports.

The runner verifies each archive's locked SHA-256, checks each decoded bank's ZIP CRC, processes every lexical term bank, completes any missing lookup indexes, and hashes every returned owned chunk. Its recursive digest includes typed-array types and complete bytes, map entries and order, array items, sorted object keys, and primitive values. Only `preparedLookupIndexEncodeMs` is excluded. The compared payload therefore includes canonical content, metadata, row columns, key plans, complete prepared lookup-index bytes, and parser-produced media projections. It verifies equal row counts and output digests per group, checks each dictionary's locked total, and rechecks runtime source hashes after completion.

This boundary excludes image payload decoding, worker IPC, archive admission, persistence and global deduplication, Zstd, OPFS, post-import UI, browser restart and lookups. It does not qualify the separate VNDB lazy ZIP catalog change. The report's `complete: true` refers to this bounded all-corpus replay.

### Copy and retired-scratch accounting

| Dictionary | Banks / groups | Native segments | Encoder key bytes avoided | Summed retired scratch reservations, baseline → combined | Largest group reservation, baseline → combined |
| ---------- | -------------: | --------------: | ------------------------: | -------------------------------------------------------: | ---------------------------------------------: |
| JMdict     |         53 / 8 |              21 |                 6,561,133 |                                  31,186,704 → 26,019,640 |                          4,465,304 → 3,542,648 |
| Jitendex   |       219 / 22 |               0 |                         0 |                                  29,010,312 → 29,010,312 |                          1,490,104 → 1,490,104 |
| VNDB       |       665 / 84 |             249 |               184,592,865 |                                418,652,560 → 326,932,384 |                          5,258,792 → 4,049,432 |

Both arms recorded zero fused parse fallbacks, zero native segmented fallbacks and zero retired-scratch reuse misses. The sum of retired address reservations decreases by 96,887,240 bytes across groups; these are reusable-address accounting totals, not bytes simultaneously resident or peak process memory saved. The source key-copy elimination and the scratch-reservation reduction have different totals because scratch regions are planned and reused by segment.

There was no extra WASM linear-memory growth in the reused-instance replay. Both arms reached the same sampled capacities: 61,603,840 bytes during JMdict, then 89,063,424 during Jitendex and VNDB. VNDB inherits capacity from the preceding dictionary; these values must not be reported as isolated per-dictionary peaks. They do not measure standalone WASM requirements, total worker memory, JavaScript heap or browser/process-tree memory.

### Test failures, correction and remaining qualification

All attempts remain in the evidence directory:

- `jmdict-focused.log`: 62 passes and eight failures, including seven 5-second timeouts and the previous wide-key fixture now successfully producing two native segments.
- `jitendex-focused.log`: 696 passes and one 5-second timeout in the exhausted native key arena case.
- `combined-focused-native.log`: serialized Node 22 execution with one worker and a 60-second test timeout; 745 passes and one failure. The replacement 100-character key fixture exhausted the fused parser key arena before reaching the intended retired-scratch fallback.
- `jmdict-fallback-fixture.log` and `jmdict-lookup-suite-fixed.log`: the corrected 32-character fixture fits the fused key arena while exceeding the largest retired scratch region. Its assertions still require zero fused fallbacks, one native fallback and one scratch miss, exact output parity and successful recovery. The isolated case passed, followed by all 43 tests in the lookup suite, with `--maxWorkers=1 --testTimeout=60000` and a 768 MiB Node heap limit.
- `jmdict-testtypes.log` is the empty output stream from the initial type-check process that exited 137. The initial lint process also exited 137. Those attempts did not establish successful lint or type validation.

The retained failures are not recast as passing runs. The all-corpus report is runtime evidence for the two native changes; the successful fixture rerun applies to its corrected test revision. Full combined unit, type, browser/OPFS, source-overhead, timing, memory, storage, cancellation and lookup qualification remains to be recorded separately. No default promotion or complete-import performance conclusion follows from this replay.

### Reproducing the frozen replay

Use Node 22.22.0 and pinned Clang/LLD 21.1.8. The build command accepts `MANABITAN_CLANG` and `MANABITAN_WASM_LD` when the pinned tools are not named `clang-21` and `wasm-ld-21` on `PATH`. Preserve the exact runner bytes. Its imports and source roots are relative to its own file, not the current working directory: place it beside sibling `manabitan/` and `combined/` checkouts. Its fixture cache is `manabitan/builds/e2e-dictionary-cache/`; it writes `combined-corpus-parity.json` beside itself.

Set `frozen_evidence` to an absolute path to the committed evidence directory before running the following in a new scratch directory. The original report is copied under a different name so the replay cannot overwrite the expected evidence:

```sh
frozen_evidence=/absolute/path/to/checkout/builds/perf/import-20261125-7b5a
(cd "$frozen_evidence" && sha256sum -c SHA256SUMS)
replay_root=$(mktemp -d)
cp "$frozen_evidence/jitendex-corpus-parity.mjs" "$replay_root/"
cp "$frozen_evidence/combined-corpus-parity.json" "$replay_root/expected-combined-corpus-parity.json"
cd "$replay_root"

baseline=7d1643e6147a10cb2165e9744cf0e63b59e46632
jmdict_head=8a191ce3f6a0b843ff195c086e7b8ff6e59245fd
jitendex_head=36fd7a27b7aa631fc8aa20bd70a9f125850499cb
git clone --no-checkout https://github.com/ManabiIO/manabitan.git manabitan
git -C manabitan checkout --detach "$baseline"
git clone --no-checkout https://github.com/ManabiIO/manabitan.git combined
git -C combined fetch origin "$jmdict_head" "$jitendex_head"
git -C combined checkout --detach "$jmdict_head"
git -C combined diff "$baseline" "$jitendex_head" -- ext/js/dictionary/wasm/term-bank-parser.c test/term-bank-parser-string-scan.test.js > metadata-selector.patch
git -C combined apply ../metadata-selector.patch

npm --prefix manabitan ci
npm --prefix manabitan run build:dictionary-wasm -- --check
npm --prefix manabitan run build:libs
node manabitan/dev/perf/prepare-dictionaries.js jmdict jitendex vndb
npm --prefix combined ci
npm --prefix combined run build:dictionary-wasm -- --write
npm --prefix combined run build:libs
git -C combined add ext/js/dictionary/wasm/term-bank-parser.c test/term-bank-parser-string-scan.test.js dev/data/dictionary-wasm/manifest.json dev/data/dictionary-wasm/term-bank-parser.wasm
git -C combined commit -m "Combine native import changes for frozen replay"
```

The source patch composes the two native changes; the generated WASM and manifest are rebuilt together instead of choosing one PR's binary. The new local commit ID will differ from the recorded snapshot. Its runtime hashes must match all nine expected hashes before execution:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
const expected = JSON.parse(readFileSync('expected-combined-corpus-parity.json'))
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
assert.equal(process.version, expected.node)
assert.equal(sha256('jitendex-corpus-parity.mjs'), expected.runnerSha256)
assert.equal(sha256('manabitan/test/perf/dictionaries.lock.json'), expected.lockSha256)
for (const [arm, root] of ['manabitan', 'combined'].entries()) {
  for (const [file, digest] of Object.entries(expected.sources[arm].hashes)) {
    assert.equal(sha256(root + '/' + file), digest, root + '/' + file)
  }
}
JS
node --expose-gc --max-old-space-size=512 jitendex-corpus-parity.mjs > combined-corpus-parity.log 2>&1
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const expected = JSON.parse(readFileSync('expected-combined-corpus-parity.json'))
const actual = JSON.parse(readFileSync('combined-corpus-parity.json'))
assert.equal(actual.complete, true)
for (const corpus of expected.corpora) {
  const replayed = actual.corpora.find((item) => item.dictionary === corpus.dictionary)
  assert.equal(replayed?.rows, corpus.rows)
  assert.equal(replayed?.digest, corpus.digest)
}
JS
```

This command reproduces the selected bounded correctness and work-accounting experiment. It neither runs the browser importer nor supplies the separate performance and memory qualification gates above.

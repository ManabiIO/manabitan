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

## 2026-11-25: native media projection with compact diagnostics

[PR #908](https://github.com/ManabiIO/manabitan/pull/908) composes the native single-image glossary projection from [PR #875](https://github.com/ManabiIO/manabitan/pull/875), original head `fb71a03f4611bcfa71e135693bebd1fe778153bf`, with compact projected-media transport from [PR #850](https://github.com/ManabiIO/manabitan/pull/850), original head `3597a103b0f35d076587e08196caa9f5d12f53ef`. Neither original branch nor PR is modified. The comparison parent is `7d1643e6147a10cb2165e9744cf0e63b59e46632`. The tested local implementation is `82e75ca22da425d9b61ed8d8811a2b00bce32068`, published as the equivalent product tree in `8994b3ff5be56f1b7d972760c0d9684a262a7296`; the implementation tree is `509a77c356300268d464ecc1fb18d3d0d91a67a5`.

The native helper returns the single image path token without rebuilding the full glossary. Successful projection transfers only the four consumed diagnostic fields; unsupported and unprojected media retain the complete row. The integration preserves current borrowed-content ownership from #881 and exact lookup routing: `prepareLookupRoute` remains argument 4, and the preloaded native source is argument 5. A real worker regression combines native projection, compact diagnostics, borrowed content, lookup-route filters and worker reuse. The native C block exactly matches #875, with SHA-256 `8385342e3fc69f3c97549824999789fd690e860b978aaf3371cddefaadb54bf1`.

Pinned LLVM/LLD 21.1.8 rebuild and `--check` pass. Parser WASM increases from 63,004 to 67,550 bytes (+4,546); its candidate SHA-256 is `b97009b54ae1056efba84964dc6f20e334cd27f47b793a5028e66d9482cb6cfa`. The canonical scanner remains unchanged. The Chrome release package is 17,276,254 bytes with SHA-256 `dfbe31deb6409f02bbea3cf79e5627be3f2489a52a3d9ffd803152753b352d6f`.

### Complete locked term-corpus equivalence

The [bounded replay](../../builds/perf/native-media-composition-20261125/replay.mjs) verifies every locked archive hash, then compares every parser output field and typed byte across all 7,613,164 lexical rows. Each baseline and candidate group runs in a separate fresh process, with one WASM instance and at most two term banks. This is fixed component grouping, not a production planner change. ZIP inflation retains per-bank CRC validation. The replay includes canonical content, dedup metadata, term columns and keys, completed lookup indexes and route filters, media paths and diagnostic keys. Only the lookup-encode duration is omitted; baseline projected media rows normalize to their four consumed diagnostic fields, while fallback rows remain complete. Every normalized output field and complete output has matching SHA-256 digests.

| Dictionary |      Rows | Groups | Projected media rows | Full fallback media rows | Receipt                                                                            |
| ---------- | --------: | -----: | -------------------: | -----------------------: | ---------------------------------------------------------------------------------- |
| JMdict     |   528,299 |     27 |                    0 |                        0 | [jmdict.json](../../builds/perf/native-media-composition-20261125/jmdict.json)     |
| Jitendex   |   436,555 |    110 |                  324 |                       15 | [jitendex.json](../../builds/perf/native-media-composition-20261125/jitendex.json) |
| VNDB       | 6,648,310 |    333 |              146,876 |                        0 | [vndb.json](../../builds/perf/native-media-composition-20261125/vndb.json)         |

Media-row counts reflect deduplication within these two-bank groups, so they are not archive image-file counts: VNDB has 146,876 projected rows here and 146,570 image assets in the locked archive. Effective experimental flags and all source/WASM/fixture/runner identities are recorded in each receipt. Both arms use the current default snapshot, including the existing large projected-import escaped-key admission for Jitendex and VNDB.

| Copy-stage work or representation | Jitendex baseline → candidate | VNDB baseline → candidate |
| --------------------------------- | ----------------------------: | ------------------------: |
| Native single-image spans         |                       0 → 312 |               0 → 146,876 |
| `JSON.parse` calls                |                      339 → 27 |               146,876 → 0 |
| Bytes passed to `TextDecoder`     |              818,519 → 93,898 |    84,486,340 → 2,393,628 |
| V8-serialized media-row bytes     |             211,980 → 134,210 |   56,717,700 → 21,813,052 |

These are untimed component counts. V8 serialization measures a Node representation, not Chrome wire bytes. The replay uses privately copied output for comparison; actual borrowed-content transport is covered by the worker regression and still requires browser qualification. No complete-import speed, peak browser memory, persisted OPFS equality or lookup-latency result is claimed. The historical #875 memory-gate failure is not claimed repaired. Multiple-path, unsupported and deeply nested media can still take a native scan followed by the general collector; their complete-import cost remains part of qualification.

Reproduce with both source roots prepared at the pinned commits, their own generated libraries/WASM, Node 22.22.0, and the shared hash-locked dictionary cache:

```sh
for dictionary in jmdict jitendex vndb; do
  node builds/perf/native-media-composition-20261125/replay.mjs "$dictionary" \
    /absolute/parent-root /absolute/candidate-root /absolute/dictionary-cache
done
```

### Validation and remaining gates

[validation.json](../../builds/perf/native-media-composition-20261125/validation.json) records 409 passing focused tests across five files, main/test TypeScript, changed-JavaScript ESLint, all-target dry build, Chrome release build, and pinned WASM reproducibility. The initial focused run loaded four suites successfully (222 tests) but lacked the generated SQLite library for the parser suite; after restoring generated dependencies and the candidate WASM, that suite passed all 187 tests. The first VNDB replay passed ten groups/200,000 rows before an `ENOSPC` checkpoint-write failure. Its [original failure log](../../builds/perf/native-media-composition-20261125/vndb-first-attempt-enospc.log) is retained; the entire unchanged replay passed after shared scratch-space cleanup.

Decision: **hold for fresh whole-import qualification**. Product source stays frozen for the source CI and separate hosted browser comparisons. Full timing cohorts, browser/process-tree memory, persisted storage, lookup latency, cancellation, restart and recovery remain independent gates. Historical measurements from either original PR do not qualify this composition.

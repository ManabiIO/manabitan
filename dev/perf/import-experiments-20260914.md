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

## 2026-11-24: frozen import source qualification (3aac)

### Scope, source identities and disposition

This round evaluates JMdict, Jitendex and VNDB with production defaults. Worker counts, pipeline depth, chunk limits, cache caps, compression settings, persistence formats and fixture bytes remain unchanged. No source candidate has been promoted.

The frozen baseline is `bbccabd520972cc351a65d9f545bd5369b6e9747`, tree `f81fc2c29b58f1c2329de6b8fa6b2a91015b6b07` (immutable parser-slab cache adoption, #824).

Develop subsequently advanced to `9a677aec40f81256dd84233de84ff6a0c43aed43` through #883, source commit `b39efc79014333c53420885f5bb7702df2daf247`. Its exact delta changes only `ext/js/dictionary/term-record-import-index-writer.js` and its test. The writer now uses a reusable MessageChannel task after the existing 6 ms active-work budget, with timer fallback and cleanup after queued writes settle. None of its changed files overlaps #874, #875 or #880.

That independent scheduling and channel-lifetime change is outside every cohort below. The timing results, including the replicated VNDB benefit, and the memory dispositions apply to the exact frozen baseline/candidate packages. They do not establish timing or memory qualification for the newer develop revision.

| Candidate                                   | PR   | Decision                                                     |
| ------------------------------------------- | ---- | ------------------------------------------------------------ |
| Selected private compression/record overlap | #874 | Hold: independent timing did not replicate                   |
| Native single-image projection              | #875 | Hold: timing benefit replicated; memory qualification failed |
| Synchronous cache-publication proof         | #876 | Closed: no material complete-import gain                     |
| Immutable native canonical inputs           | #880 | Hold: all three complete-import screens are inconclusive     |

| PR   | Published source                           | Tree                                       |
| ---- | ------------------------------------------ | ------------------------------------------ |
| #874 | `ebb1da8d2cc2b28901400968891b632605f1b3f0` | `243ab638da9cb73e08d84609c41dcdfdf08475cd` |
| #875 | `fb71a03f4611bcfa71e135693bebd1fe778153bf` | `0939bd1eec85dc0b3f15ef002a8f0f5111c80103` |
| #876 | `cdb23a11d991a72f860e400d0d81bb0747a5b4f9` | `1edef4035041ef848175e3278169daf2260ac34a` |
| #880 | `2dfa72962c9d9f1976011e41b9bbce2375f4dbb5` | `64345e92fff3800b5035b6aab52dff06e20bc874` |

The prior #848 and #854 drafts were closed after their independent complete-import results failed to justify promotion. Their earlier source/evidence branch remains `perf/import-evidence-20261123-3aac`, commit `d03649834ff5adc4fe484ea66b99cfe61c1eeed5`.

Do not revive their unchanged micro-optimizations or the fresh full-source SAB ownership variant from #810/#839 without a concrete fix for the previously measured memory cost. This round did not benchmark that rejected SAB variant again.

### Implementation and correctness boundaries

**#874: selected private compression/record overlap.** Admission requires a complete, parser-owned private ArrayBuffer after the compression dictionary has passed its measured selection. The change reserves compact-reference space under the existing append owner using a codec upper bound, then overlaps compression with record writes in that same admitted batch.

The original source remains live for collisions, repacking, cache handling and failures; both persistence owners settle before the producer advances. Unproven or high offsets retain the suffix layout. Guarded reservation cannot change index partitioning past `0xfffffffe`; actual compressed size and derived counts/types are checked before mutation. Rollback restores both OPFS checkpoints and clears staged metadata and dedup state.

Reference offsets intentionally differ; compressed frames, canonical content, parser-prepared lookup/index payload bytes and per-file lengths remain equal. Final sidecar offset fields and checksums intentionally differ. The offset-sensitive browser digest includes raw content offsets and therefore legitimately differs for Jitendex; canonical lookup hashes match.

**#875: native single-image projection.** The change projects exactly one image path from native glossary bytes when the existing loaded-source range is proven. The bounded native walker preserves root/structured-content roles, type/tag precedence, nested content and last duplicate keys. Empty, multiple, unsupported, malformed or unproven cases use the existing collector.

The export adds no native arena allocation, memory growth or output column. The new source capability is consumed synchronously and does not escape into output, caches or worker messages. Pinned LLVM 21.1.8 regenerates the checked WASM and source-bound manifest.

The corrected production VNDB oracle covers 665 banks in 170 effective byte-balanced groups: 6,648,310 rows, 146,725 native one-path projections and 146,570 distinct media paths. All output columns, owned content, prepared indexes and media rows match the legacy path; results remain stable across the next native parse. Full-glossary JSON parses fall from 146,725 to zero, and decoder input falls from 84,398,732 to 2,391,178 path-token bytes.

These are mechanical work-removal and component-correctness results, not whole-import timing. The earlier oracle with escaped-key handling disabled had 429 guarded fallbacks; it is retained separately from the production-route oracle.

**#876: synchronous cache-publication proof.** A successful contiguous publication proof passes directly into the cache in the same synchronous call. The change retains span bounds, byte totals, admission limits, complete backing-buffer accounting, eviction and alias fallback. Its executed route was proven, but its total-import benefit was not.

**#880: immutable native canonical inputs.** The change snapshots validated immutable configuration and each row's length/hash words across the existing canonical rollback barrier. All volatile progress writes, journal words, barriers, trap points, validation and ABI remain unchanged. Authoritative pointers cannot overlap the fixed inputs; the module requires non-shared memory and imports no callbacks. Continuations take fresh snapshots.

Pinned compiler assembly removes 11 repeated config-load sites inside the row/probe loops, but this does not establish a material total-import gain. The change is distinct from #864's counter writes and #856's journal compaction.

All four source heads passed full CI, including unit tests, build, native artifact reproduction where applicable, types, Chromium/Firefox E2E and restart/interruption coverage.

| Candidate        | Focused tests | Main coverage                     | Local Chrome ZIP size change |
| ---------------- | ------------: | --------------------------------- | ---------------------------: |
| Prefix (#874)    |           521 | Ownership, failures and bounds    |                 +1,589 bytes |
| Media (#875)     |           222 | Semantics, fallback and ownership |                 +2,785 bytes |
| Cache (#876)     |           184 | Cache publication                 |                   +225 bytes |
| Canonical (#880) |           130 | Native state and continuation     |                   +235 bytes |

These ZIP deltas come from the local Chrome package guards and depend on build context; they do not describe every CI ZIP. For example, the media memory artifacts contain a 16,783,669-byte A ZIP and a 16,786,526-byte B ZIP, a +2,857-byte difference. The local media guard used a 17,265,196-byte baseline and reported +2,785 bytes. Native WASM byte deltas remain separate from ZIP-container measurements.

Canonical coverage includes 79 exact-baseline native-state cases, invalid prefix aliases, allowed authoritative aliases, first/middle/late traps and changed-input continuation. Its 1,624-byte baseline test module is pinned to the baseline's SHA-256. The candidate module grows by 43 bytes.

### Protocol and observed route

The environment uses Node 22.22.0 and Chromium 153.0.8010.12 (Playwright revision 1243). The fixture-lock SHA-256 is `60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89`. Every archive is checked against its locked size/hash before acquisition.

| Dictionary | Archive bytes | Term rows |
| ---------- | ------------: | --------: |
| JMdict     |    15,645,766 |   528,299 |
| Jitendex   |    38,831,822 |   436,555 |
| VNDB       |   291,705,969 | 6,648,310 |

The native setup also prepares its locked JMnedict cache. Every source arm uses real dependency directories from the same lock/setup. Clean source, harness and package identity checks must pass before timing.

Six-block screens use `ABC, CBA, BAC, CAB, BCA, ACB`. Qualification adds `ACB, BCA, CAB, BAC, CBA, ABC` after those six blocks. The independent replication reverses both the whole schedule and each block. A and C use the exact same worktree, archive and entry bytes.

Each cell excludes one fixed warmup per arm, retains every timed observation, then runs separate exhaustive-media diagnostics on A/B. Each timed import uses the unchanged native release harness, production defaults, a fresh profile, restart, 72 canonical lookup receipts and a deterministic media sample. Timing brackets file-input dispatch through the current operation's post-UI completion. These timing cells contain no profiling, process sampling, screenshot capture or harness overlay.

The browser checks cover 12 deterministic terms across six passes, not every stored term. Exhaustive media covers all 236 Jitendex files / 4,992,155 bytes and all 146,570 VNDB files / 188,131,284 bytes. Component oracles provide additional full-row coverage; browser probes alone do not establish exhaustive database byte equality.

All descriptive intervals use 10,000 block-paired bootstrap samples with seed 20261124. Do not pool hosts/stages, drop slow tails, replace failed observations or reinterpret an incomplete cohort as a complete comparison.

The first activation diagnostic attached counters to the fallback handler, so three completed imports lacked its phase. The Jitendex attempt timed out before the browser. All failures remain in run 45468163108.

Corrected tooling `200b8680bad62e9f40b015ceebebc7382b54dd4b` observes the production offscreen owner and prepares the exact setup fixture set. Run 45470204352 passes all four cells:

| Cell             | Observed route                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prefix, Jitendex | One unchanged unforced private selection, followed by 21 private prefix admissions; 372,728,692 selected bytes / 351,495 unique entries             |
| Prefix, JMdict   | 12 existing shared admissions and zero private admissions                                                                                           |
| Prefix, VNDB     | 170 private-source attempts, no selected compression dictionary and zero new private reservation admissions; ordinary generic compression continues |
| Cache, JMdict    | 12 immediate proof reuses                                                                                                                           |

Real fixtures did not exercise the high-offset suffix fallback; synthetic source tests do. Instrumented durations are non-authoritative even if the unmodified harness's raw flag says otherwise.

### Completed timing results and limits

Negative percentages mean faster. All percentages below retain their original comparison direction.

**Original screen:** run 45465463257, tooling `7147cf5a1d1d68a38105c407c4ad5ca92f56e056`. All six JMdict/Jitendex cells completed. Its three VNDB cells stopped at a storage-total gate and remain incomplete.

Cache JMdict paired medians were B/A −0.4756%, B/C +1.3890%, and identical-product C/A +0.9441%. This does not justify promotion.

**Prefix qualification:** run 45468314006, tooling `eeec4c2055ed911de92ba98fdc815c8ff0444edb`. All four 12-block cells completed.

| Jitendex cell | B/A paired median and descriptive 95% interval | B/C paired median and descriptive 95% interval | Equal-work B/A / B/C |
| ------------- | ---------------------------------------------- | ---------------------------------------------- | -------------------- |
| Forward       | −0.8208% [−2.4723%, +3.3402%]                  | −0.2010% [−3.6589%, +4.6285%]                  | +0.9831% / +0.3549%  |
| Reverse       | −1.6260% [−2.2756%, −0.5527%]                  | −1.4761% [−2.5394%, −0.0685%]                  | −2.6941% / −1.5285%  |

JMdict is an unchanged-route control, and its independent results are inconclusive. The smaller reverse-host gain does not establish replicated benefit.

**Corrected VNDB screens:** run 45469432793, tooling `f44fbe93a4cb2da44cf94cc2a03236acde8755a8`. Both cells complete, retaining all 46 observations.

| Candidate | B/A paired median | B/C paired median | Identical-product C/A median | Equal-work B/A / B/C |
| --------- | ----------------: | ----------------: | ---------------------------: | -------------------- |
| Media     |          −4.0211% |          −4.3249% |                     −0.5984% | −4.0737% / −3.6376%  |
| Prefix    |          +0.1498% |          +0.7809% |                     −1.3669% | —                    |

Media's B/C screen interval crosses zero: [−6.7483%, +0.2274%]. The separate qualification below supplies the independent confirmation. Prefix VNDB is neutral.

**Canonical screens:** run 45472377306, tooling `8774a1cebe9974e5353af48453159413350d9a6a`. All three cells now complete: 69 observations, comprising 54 timed imports, nine fixed warmups and six exhaustive-media diagnostics. All source/package/fixture identities, observed timings and correctness receipts independently reconcile.

| Dictionary | B/A paired median | B/C paired median | Identical-product C/A median |
| ---------- | ----------------: | ----------------: | ---------------------------: |
| JMdict     |          −2.3588% |          −0.1053% |                     −0.8721% |
| Jitendex   |          −2.1959% |          −0.6593% |                     −1.2521% |
| VNDB       |          −0.7313% |          −0.4309% |                     −0.3003% |

Every descriptive interval crosses zero. JMdict's B/A result is not corroborated by B/C. Its retained 1,495.7 ms A tail makes equal-work B/A −11.0953%, mirrored by identical-product C/A −10.9669%; this does not establish an 11% candidate gain.

VNDB's descriptive 95% intervals are B/A [−1.7330%, +0.7107%] and B/C [−6.1557%, +2.8291%]. Its equal-work results are B/A −0.5788% and B/C −1.3866%. Both exhaustive diagnostics match 146,570 media files / 188,131,284 bytes. Every observation has 609,553,611 storage bytes and a 528,384-byte active SAH file, within the unchanged prospective allocation bound. None of the three canonical screens demonstrates a material complete-import gain.

**Media VNDB independent qualification:** run 45475087387, tooling `2fb6c247852c64be1b836aff60b3eba5eb1acc7e`. Both independent 12-block cells complete with the same frozen product sources and prospective storage protocol. All 82 observations are retained: 72 timed imports, six fixed warmups and four separate exhaustive-media diagnostics.

| VNDB cell | B/A paired median and descriptive 95% interval | B/C paired median and descriptive 95% interval | Identical-product C/A median | Equal-work B/A / B/C |
| --------- | ---------------------------------------------- | ---------------------------------------------- | ---------------------------: | -------------------- |
| Forward   | −5.2703% [−6.1074%, −3.7283%]                  | −5.0548% [−6.3501%, −4.1903%]                  |                     +0.1091% | −5.0998% / −5.2490%  |
| Reverse   | −4.6686% [−6.2451%, −3.2300%]                  | −5.0954% [−5.8739%, −3.4104%]                  |                     −0.1816% | −4.8897% / −4.7269%  |

The timing benefit replicates against both identical-product controls on both hosts. Every B/A pair is faster; B/C is faster in all 12 forward pairs and 11 of 12 reverse pairs. The slower reverse B/C observation remains included. The four candidate intervals exclude zero; both identical-product intervals cross zero. Hosts and stages remain separate.

All inventory, restart, canonical lookup, sampled media, exhaustive media and bounded per-file storage checks pass. These results establish a complete-import improvement for the pinned VNDB workload on these CI hosts, not a speedup for JMdict/Jitendex or every device. The memory hold below remains in force.

### Storage and memory decisions

The original VNDB failures occur on baseline as well as candidate observations. All 24 retained native imports succeed; only the active SQLite SAH file varies from 528,384 to 536,576 bytes. All content, record, index and media-pack paths/sizes, lookup hashes and media digests match.

Source inspection shows that the initial 256 image BLOBs enter SQLite in asynchronous read-completion order. This supports a layout-variance explanation, but does not establish which database contents account for the 8,192-byte difference.

The prospective `pinned-import-storage-20261124-v1` policy validates:

- Every known non-SAH path and its exact size.
- Eight SAH files, including seven empty 4,096-byte files.
- Exact active-file allocation for JMdict/Jitendex.
- For VNDB only, one active file limited to 129–131 aligned 4,096-byte **full-file allocation units**.

Those units measure the entire file; they do not assert SQLite page counts or page-level equality. Every actual total/path/size remains retained. Unknown or missing files, changed non-SAH sizes, unaligned allocation and allocation above the bound all fail. This is neither SQLite byte equality nor a general growth waiver. The original failed cohorts retain their status; new complete cohorts remain separate.

Memory acquisition is separate and non-authoritative for timing. The frozen observer takes process-tree `/proc/smaps_rollup` samples with 25 ms waits and a test-only import-boundary marker overlay. It verifies PID/start identities, parentage, browser and renderer coverage, and readable address spaces. Incomplete reads do not become zero.

Qualification requires at least five fully covered in-window scans, maximum 250 ms covered/bracket gaps, no invalid observations, and two independent ABBA/BAAB replications. PSS/private bounds are +5% for the paired median and +10% for each pair. These are sampled maxima; they do not establish exact peaks, settled-memory/GC attribution or constrained-device qualification.

**Prefix memory:** run 45468614083, tooling `a96671c223ed1e7ed49f0c96427b2ef09229f4cc`. Both replications pass, and all eight imports / 808 raw scans independently reconcile.

| Replication | Median PSS change | Median private-memory change |
| ----------- | ----------------: | ---------------------------: |
| ABBA        |          +0.6794% |                     +0.8814% |
| BAAB        |          +3.6625% |                     +4.2566% |

The largest private-memory pair is +5.5697%. This is a passed bound, not a reduction.

**Media memory:** run 45471351138, tooling `df1e9f4ac1e4c4e2e02b96de90bfe63d3ff359dc`. Both dictionaries remain unqualified, although all 16 correctness checks pass and all 1,684 raw scans reconcile.

| Cell          | Result                                                                    | Qualified median PSS / private change |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| Jitendex ABBA | Pass                                                                      | +0.1742% / +0.1210%                   |
| Jitendex BAAB | Coverage failure and a separate valid private-memory pair above the bound | Aggregate metrics remain null         |
| VNDB ABBA     | Both baseline observations fail coverage; no qualified pairs              | Aggregate metrics remain null         |
| VNDB BAAB     | Pass                                                                      | +0.3489% / +0.4274%                   |

Jitendex BAAB has an invalid baseline A2 covered gap of 253.166629 ms. Separately, its valid first pair increases private memory by +11.5409%, exceeding the 10% bound; PSS increases by +9.2188%. VNDB ABBA has baseline gaps of 353.233063 ms and 275.115924 ms.

The narrow zombie exception correctly does not admit a process reaped between inventory and its ENOENT read. No observations were replaced and no thresholds changed.

The valid Jitendex excess is concentrated in a transient extension-renderer increase: private memory is 991,180 versus 879,308 KiB at the respective maxima. A bounded source audit finds no new escaping input owner, native arena or output ownership edge. The source and process-only samples do not establish the cause or repeatability. Do not dismiss the breach as noise or make a speculative source fix.

### Reproduction, evidence and remaining work

All source heads remain independently reviewable in their PRs. Use the exact tooling commits above for reproduction; their workflows contain complete source/package allowlists, fixture preparation and fixed schedules.

| Tooling                     | Branch                                   |
| --------------------------- | ---------------------------------------- |
| Timing workflows and runner | `perf/import-studies-20261124-3aac`      |
| Prefix memory               | `perf/import-memory-20261124-3aac`       |
| Media memory                | `perf/import-media-memory-20261124-3aac` |
| Activation                  | `codex/import-activation-20261124-3aac`  |

For an isolated whole-import study, check out the required exact tooling commit and use Node 22.22.0. Install dependencies and the lockfile-pinned Chromium, then inspect the committed runner's interface:

```sh
npm ci
npx playwright install --with-deps chromium
python3 dev/perf/import-runtime-20261124-3aac.py --help
```

Supply exact source SHAs, a dictionary, the prespecified stage, the expected packaged-difference JSON and a fresh output directory. Do not reuse a failed output directory or automatically restart an unchanged candidate. The runner builds both release packages before timing and asserts all native harness, fixture and dependency identities. All-target/native source validation remains the source PR CI's separate gate.

Local persistent Chromium in this chat workspace is blocked by `process_singleton_posix.cc:297 socket() failed: Operation not permitted (1)`. No local browser timing was represented as evidence. Linux CI performs all actual browser qualifications; static correctness and assembly work use the pinned Node/LLVM toolchain.

The earlier single baseline profiling run 45458569610 used source `698d685c21618a8e8dbdab7a49a8dcf0d30680eb`. It is attribution-only, not a comparison against the newer baseline.

Durable machine-readable evidence is under `builds/perf/import-20261124-3aac` on branch `perf/import-evidence-20261124-3aac`. Its index separates each failed and completed stage, retaining every native report, raw memory scan/marker, log, source/fixture/package hash and independent audit. Versioned archives preserve earlier snapshots, including their then-pending stages.

When downloaded artifacts contain product ZIPs, the evidence packager excludes their bytes only after full archive/entry verification; source revisions, build commands and original CI artifacts remain recorded. Timing artifacts retain package archive hashes and entry inventories, but not the raw product ZIPs, so those ZIP bytes cannot be independently rehashed from the retained timing artifacts.

The packager verifies every retained archive member and readable receipt and performs deterministic regeneration. Its README documents exact verification/refresh commands; this section records the interpretation and remaining decisions.

All prespecified acquisitions in this round are complete or explicitly retained as failed. VNDB media timing replicates, but its memory qualification fails. Prefix timing does not replicate, the three canonical screens do not justify performance promotion, and the cache candidate is closed. None of this round's four source candidates has been merged or promoted.

No further memory acquisition is scheduled for these unchanged candidates. Any new study should preserve the existing failed cohorts and specify its distinct hypothesis and protocol before acquisition.

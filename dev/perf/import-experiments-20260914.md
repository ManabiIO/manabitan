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

## November 23, 2026: frozen three-dictionary source study

This round evaluated independent source candidates against `3d65e403c644b9a5a6be3128d72f9d30050b70e0`. The candidates were never combined. PR #854 reduces repeated VNDB field-encoding work, but its complete-import screen remains inconclusive. PR #848 did not establish an import gain in its screen or either independent confirmation. Three JMdict parser candidates did not justify publication. Both published source candidates remain drafts; no material total-import speedup or process-memory saving is claimed.

The [immutable evidence index](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/evidence-index.json) records hashes and scope for the [retained evidence tree](https://github.com/ManabiIO/manabitan/tree/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac). It contains complete aggregate observations, paired analyses, package manifests, source/fixture identities, verification receipts, executed helpers, diagnostic summaries and retained failed/incomplete local runs. Full per-observation browser reports and original downloaded archives remain in the linked Actions artifacts; original scratch paths in historical command descriptions identify where the work ran. They are not the durable evidence location.

| Evidence                                                                              | Retained location                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Three unpublished JMdict sources, exact binary patches and all component observations | [JMdict parser evidence](https://github.com/ManabiIO/manabitan/tree/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/jmdict-parser)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Structured-parser component and complete native-byte oracle                           | [Component report](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/jitendex-component.json), [native parity](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/native-parity.json), [executed helper](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/verify-native-import-parity.mjs)                                                                                                                                                                                                                                                                      |
| Structured-parser screens and independent confirmations                               | [JMdict](https://github.com/ManabiIO/manabitan/tree/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/structured-jmdict), [Jitendex](https://github.com/ManabiIO/manabitan/tree/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/structured-jitendex), [VNDB](https://github.com/ManabiIO/manabitan/tree/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/structured-vndb), [host 1](https://github.com/ManabiIO/manabitan/tree/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/structured-confirmation-1), [host 2](https://github.com/ManabiIO/manabitan/tree/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/structured-confirmation-2) |
| Record-field method observations, including rejected first variant                    | [Final component](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/record-fields-component.json), [executed helper](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/record-fields-executed-harness.mjs), [initial variant](https://github.com/ManabiIO/manabitan/tree/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/record-fields-initial)                                                                                                                                                                                                                                                          |
| Record-field complete-import screens and independent audits                           | [JMdict](https://github.com/ManabiIO/manabitan/tree/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/fields-jmdict), [Jitendex](https://github.com/ManabiIO/manabitan/tree/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/fields-jitendex), [VNDB](https://github.com/ManabiIO/manabitan/tree/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/fields-vndb)                                                                                                                                                                                                                                                                                                                                 |
| Passing source CI and uncontended full local gate                                     | [PR #848 CI](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/pr848-source-ci.json), [PR #854 CI](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/pr854-source-ci.json), [local unit receipt](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/vndb-source-unit-gate-20261123.json), [complete local log](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/vndb-source-unit-gate-20261123.log)                                                                                          |

### Reproducing the browser protocol

The [retained runner](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/dev/perf/import-runtime-20261123-3aac.py) and its workflow are on `perf/import-evidence-20261123-3aac`, at immutable commit `d03649834ff5adc4fe484ea66b99cfe61c1eeed5`. Use Node 22.22.0, install the locked dependencies and the matching Playwright Chromium, and run from a clean checkout of that tooling commit. The runner prepares both product checkouts, pinned fixtures, release packages, warmups, fixed triplets and separate exhaustive media diagnostics; it rejects unexpected package differences. Output directories must be unique per cohort.

```sh
npm ci
npx playwright install --with-deps chromium
python3 dev/perf/import-runtime-20261123-3aac.py \
  --baseline 3d65e403c644b9a5a6be3128d72f9d30050b70e0 \
  --candidate d2ab3344a483af52ac6d0765f3fbeaf8d1e2a0ca \
  --dictionary vndb --stage screen \
  --expected-differences '["js/dictionary/term-record-opfs-store.js"]' \
  --output /absolute/path/to/new-evidence
```

Select `jmdict` or `jitendex` for the other record-field cells. For the structured-parser source, use candidate `09dfb90d926758205ff52d127ef3d950f0b15a65` and expected differences `["js/dictionary/wasm/term-bank-parser.c","lib/term-bank-parser.wasm"]`. The independent 12-block protocol uses `--stage qualification`, with `--reverse` on the second independent host. These commands reproduce defined cohorts; they do not authorize retiming an unchanged candidate until a favorable result appears.

The component helpers below are the exact executed files. Some retain original absolute checkout/cache paths; preserve their algorithms, fixed schedules, fixture/source hashes and measurement boundaries when adapting only those paths. The existing `dev/perf/import-lookup-screen.js` remains the reusable JMdict parser harness. The documentation-only follow-up containing this handoff does not alter either measured runtime tree.

## November 23, 2026: compact-content record-field runs (PR #854)

**Status: HOLD; keep PR #854 as a draft.** The frozen candidate reduces repeated scalar work in record-field encoding, with exact field-byte parity on all three pinned corpora and successful source CI. The complete three-dictionary browser screen does not establish a material import improvement: the candidate's changes are within identical-product control drift. Preserve all observations and do not promote or claim a release speedup or peak-memory reduction. No additional timing or selective rerun is planned.

### Source and implementation

- Parent: `3d65e403c644b9a5a6be3128d72f9d30050b70e0`.
- Local candidate: `e949286b9e5f37f98c2a400ee067928382c7b1f9`; published [PR #854](https://github.com/ManabiIO/manabitan/pull/854) source: `d2ab3344a483af52ac6d0765f3fbeaf8d1e2a0ca`.
- Identical candidate tree: `24e3e31fb86f8c2587f1753f940da359162427cf`. Runtime blob: `bb257d21b789e50aa975dc049b1a576d834f0030`; test blob: `b18f59f1e53821844d6cb1ae79a0fda63ec6ecf1`.
- Runtime file SHA-256, parent/candidate: `f1cdc2f7d471d805d8cfe35d0cd8bcdbeb339dc97268f9772f545f9779028cd9` / `fa29e41b5ddd7bf99bc0aa2de1bf76c972baad795b67d4ce4215fa244bafd087`.
- Unchanged parser WASM SHA-256: `25149bac5db0dda3bba85fe8e133fb06d51881a822f27565e4587ba223dde41c`. Lock SHA-256: `60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89`.

The existing compact-content metadata signal selects possible repeated runs. Private factory origin, unchanged ordinary reference columns and a private ordinary `Int32Array` score column establish stable indexed reads for this synchronous encode. Each run requires both identical content ID and identical score. The encoder resolves the span and interns the score at the first row, then fills the unchanged temporary output columns. The scalar loop remains separate for fixed spans, floating scores and external/accessor/proxy/shared/replaced columns. Existing current-value validation, first-use score-table order, field bytes and legacy fallback are preserved. No storage format, allocation layout, compression, worker count, admission budget or generated artifact changes.

### Final fixed component cohort

Node `22.22.0`, V8 `12.4.254.21-node.33`; pinned Clang/LLD `21.1.8` for the unchanged native parser. The cohort ran after other agents released the shared CPU slot. Product source and generated binary identities remained frozen. The final harness and report are `/workspace/scratch/3aacd533c01f/vndb-field-study/harness.mjs` and `report.json`, SHA-256 `a21365698930abf6fbdea3a7a93ab862b156af945aab3c2dda04336b6461ea20` and `650b9430c47b63a295266e8b672a3a3d6a374f13076263bd15599ec25f66eb4e` respectively. All per-pair observations are retained in the [component report](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/record-fields-component.json).

The untimed capture uses the real native parser and production source-partition function with an explicitly selected five-worker partition, actual scores, unique-content IDs, content lengths, compact-metadata marker and prepared-index chunk boundaries. The later authoritative browser screen uses the current three-worker default: JMdict has 12 browser groups versus 20 in this component capture; Jitendex has 22 in both. These boundaries are retained as different workloads. The capture hashes each archive against the pinned lock. Offset values preserve source-derived placement but are shifted above 4 GiB; they are component fixtures, not actual compressed OPFS placement. The factory is retained only for complete native chunks. The activation regression separately exercises the real native parser, production owned-copy helper, `structuredClone`, database factory and public store append; only the OPFS open/write boundary is mocked.

Every encoded field byte is compared with the parent before timing. Each arm receives two full warmup passes in ABBA order. The fixed schedule contains four adjacent balanced AB/BA pairs per corpus, all in one process; **each timed observation is four complete corpus passes**. There is no forced GC or fresh process per pair. Actual fill counters are collected only after every timing observation, so the temporary typed-array prototype spy cannot affect timed code. The boundary is `_encodeArtifactRecordFields`; capture, parsing, worker transport, compression, OPFS writes, UI completion and peak memory are excluded.

```sh
source /workspace/scratch/3aacd533c01f/toolchains/env.sh
node /workspace/scratch/3aacd533c01f/vndb-field-study.mjs --capture-only
node /workspace/scratch/3aacd533c01f/vndb-field-study.mjs
```

| Corpus   |    Rows / banks | Source groups / field chunks | Admitted chunks / rows | Repeated scalar rows bypassed | Field bytes |
| -------- | --------------: | ---------------------------: | ---------------------: | ----------------------------: | ----------: |
| JMdict   |    528,299 / 53 |                      20 / 20 |                  0 / 0 |                             0 |   4,244,804 |
| Jitendex |   436,555 / 219 |                      22 / 22 |                  0 / 0 |                             0 |   3,497,796 |
| VNDB     | 6,648,310 / 665 |                    170 / 170 |        144 / 5,648,310 |                     5,514,978 |  53,191,240 |

The VNDB post-timing witness counted 133,328 bulk-fill runs covering 5,648,306 rows. Four admitted singleton rows used scalar assignment. Subtracting run count from filled rows gives the 5,514,978 repeated scalar resolutions avoided. JMdict and Jitendex counted zero fills. These are component work counts, not allocation or memory savings. The partition and synthetic offset placement limit transfer to the browser: its own receipts must establish actual grouping and compact metadata, and this unchanged browser harness does not instrument row-run admission. Do not label the component's bypass count as observed browser work or transfer its percentage to whole-import latency. The frozen full-browser harness is authoritative for import timing.

| Corpus   | Pair / order | Parent ms, four passes | Candidate ms, four passes | Paired change |
| -------- | ------------ | ---------------------: | ------------------------: | ------------: |
| JMdict   | 1 / AB       |                 53.659 |                    54.801 |        +2.13% |
| JMdict   | 2 / BA       |                 55.825 |                    45.465 |       -18.56% |
| JMdict   | 3 / AB       |                 49.040 |                    45.180 |        -7.87% |
| JMdict   | 4 / BA       |                 45.706 |                    45.133 |        -1.25% |
| Jitendex | 1 / AB       |                 60.177 |                    49.532 |       -17.69% |
| Jitendex | 2 / BA       |                 27.358 |                    48.729 |       +78.12% |
| Jitendex | 3 / AB       |                 29.457 |                    29.616 |        +0.54% |
| Jitendex | 4 / BA       |                 29.282 |                    27.279 |        -6.84% |
| VNDB     | 1 / AB       |                638.768 |                   408.367 |       -36.07% |
| VNDB     | 2 / BA       |                825.928 |                   299.315 |       -63.76% |
| VNDB     | 3 / AB       |                865.135 |                   398.529 |       -53.93% |
| VNDB     | 4 / BA       |                699.918 |                   285.650 |       -59.19% |

VNDB is faster in all four method-only pairs: median paired change -56.56%, equal-work total change -54.06%, average full-corpus method pass 189.359 ms parent / 86.991 ms candidate. The generic controls are noisy: JMdict equal-work change -6.68%, Jitendex +6.07%, including the retained Jitendex +78.12% pair. They do not establish negligible source overhead. The four-pair component cohort is not a substitute for the larger browser protocol or independent replication.

The complete 7,613,164-row / 937-bank byte oracle passed. Concatenated field SHA-256 values:

- JMdict: `0ddf1032a0582004fc4945ade9148ccc06fa384fa43ad79a46373f1e634c431f`.
- Jitendex: `35539428ecce574bb7f651f59227c85f044dc2dca302e0abcb342161d6aa8e2b`.
- VNDB: `7cf0e6a5e89252eb2790920ab008cdea101c190e5cc59c9d1250117cebf85087`.

An earlier broader-admission candidate is retained in `/workspace/scratch/3aacd533c01f/vndb-field-study-initial/`, including exact source, harness and all raw observations. It placed an extra branch in the scalar loop and admitted ordinary metadata; generic-path regressions caused its rejection. Its VNDB candidate tail of 191.586 ms versus 130.527 ms parent remains in the record. It also collected fill counters before timing, unlike the final cohort. Do not pool either source or its measurements with the final candidate.

### Completed correctness gates and remaining qualification

The final local focused run passed **246 tests in four suites**: `term-record-field-runs`, `term-record-reference-origin`, `term-record-opfs-store` and `term-record-authoritative-encoder`. Coverage includes 63/64/65-row admission boundaries, the native-to-database activation witness, exact bytes and independent decoding, mixed scores, nonconsecutive aliases, row limits, mutated rereads, malformed references, length/legacy boundaries, float/-0/fixed spans and all unusual-column fallbacks. Main/test TypeScript, scoped ESLint and `git diff --check` passed. Both peer agents reviewed the frozen source without correctness findings.

```sh
node node_modules/vitest/vitest.mjs run --maxWorkers=2 \
  test/term-record-field-runs.test.js \
  test/term-record-reference-origin.test.js \
  test/term-record-opfs-store.test.js \
  test/term-record-authoritative-encoder.test.js
npm run test:ts:main
npm run test:ts:test
node node_modules/eslint/bin/eslint.js \
  ext/js/dictionary/term-record-opfs-store.js \
  test/term-record-field-runs.test.js
git diff --check
```

Retained setup failures: the first focused attempt lacked generated `resvg-wasm.js` and could load only two suites; copying the baseline's already-built library output resolved it. Four test-file lint formatting issues were corrected before the final freeze. Neither is omitted from the raw local logs.

The first local `npm run test:unit -- --maxWorkers=2 && npm run test:build` chain was interrupted: its session disappeared, the unit log ended without a pass/fail summary and the chained dry-build never started. **That original local run is incomplete, not passed.** Its log remains retained. The separate exact published tree's [source CI run 45263947741](https://github.com/ManabiIO/manabitan/actions/runs/45263947741) subsequently completed successfully: all 15 normal jobs passed and four conditional jobs were skipped, with no failed or remaining job. This includes the pinned WASM rebuild, all-target build and manifest validation, all TypeScript lanes, JavaScript/CSS/HTML/JSON/Markdown checks, full unit/options tests, Chromium and Firefox extension E2E, and the Anki matrix. The remote full unit log independently confirms 642 suites / 14,429 passed and 47 skipped. The [source CI receipt](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/pr854-source-ci.json) preserves the final job conclusions. The [remote full-unit job](https://github.com/ManabiIO/manabitan/actions/runs/45263947741/job/138005765081) provides its original log; the independent complete local log is also retained in the evidence tree.

A separate, uncontended exact-tree full unit/options gate subsequently passed on Node 22.22.0 at 21:17:31 UTC. `npm run test:unit -- --maxWorkers=2` passed **642 suites / 14,429 tests, with 47 skipped**; `npm run test:unit:options -- --maxWorkers=2` passed **one suite / 32 tests**. Each command had one attempt and no retry or abort. The source stayed clean at local `e949286b9e5f37f98c2a400ee067928382c7b1f9`, tree `24e3e31fb86f8c2587f1753f940da359162427cf`, before and after. The complete retained log is `/workspace/scratch/3aacd533c01f/vndb-source-unit-gate-20261123.log`, SHA-256 `4c6dc54128eac02e3afcef20e1e60058cf3da99b2a1ed7a89f13bd708992a4ca`, with the same-basename JSON receipt. This completes the local unit requirement; the original incomplete run remains retained. The exact-tree remote build supplies the build gate.

The separate full-import study is [run 45264553669](https://github.com/ManabiIO/manabitan/actions/runs/45264553669), workflow source `a784ff1706c57189f36eca5cbff832f82be7c822` on `perf/record-field-study-20261123-3aac`. All three dictionary jobs completed successfully. The complete browser observations, source-overhead controls, persistence/lookup checks and HOLD decision are recorded below. No local browser qualification is claimed; the pinned browser download was unavailable locally.

### Interaction with PR #849

[PR #849](https://github.com/ManabiIO/manabitan/pull/849), head `10a8f09e96ff943ec1351b1391cb56fa7e20feed`, removes temporary offset/length allocation and copying. That goal is compatible with run-based scalar-work reduction, but both patches edit the same encoder. Its direct-column path makes temporary `offsets` and `lengths` null; this candidate's run path calls their `fill` methods. A mechanical conflict resolution could null-dereference or discard one optimization.

A future combination needs deliberate generic, stable direct-column and compact-metadata run handling; preserve first-use score order, current per-invocation origin checks and all fixed/float/shared/accessor fallbacks. PR #849's early Float64 allocation avoidance can compose separately. Consolidating duplicate private-column eligibility checks is possible, but must not extend a validation witness across asynchronous work. Re-run combined byte oracles, regression tests and complete browser qualification. Do not add PR #849's allocation totals to this candidate's component percentage and label that a combined import benefit.

### Remote browser screen: qualification evidence

The frozen browser study uses Node 22.22.0 and Chromium 153.0.8010.12. Each dictionary has six predeclared blocks in the order `ABC`, `CBA`, `BAC`, `CAB`, `BCA`, `ACB`, one excluded warmup per arm, and two excluded exhaustive-media diagnostics. A is the parent, B the frozen candidate, and C reuses the identical A release archive and package entries. Every observation uses a fresh browser profile, production defaults and the unchanged native harness, timing file-input change through post-UI import completion. Tracing, screenshots, extra phase profiling and process sampling are disabled. No retries, discarded tails or adaptive stopping are allowed. These six-block screens remain exploratory and do not replace independent qualification; each dictionary is interpreted separately.

The read-only artifact audit rechecks the archive against GitHub's SHA-256, all source/tree identities, the frozen harness/lock hashes against the local parent, the runner hash, package-entry differences, every observation's clean-source and package digest, the complete schedule, all raw comparisons, restart/inventory receipts, media digests and all 72 lookup receipts per observation. Release archives themselves are not included in the evidence ZIP; package identity is verified through the recorded 550-entry manifests and each observation's package hash. Browser lookup receipts cover 12 sampled terms over six passes, not exhaustive persisted-row equality. Full field-byte equality is the separate component oracle above.

#### Jitendex: complete, inconclusive source-overhead control

Artifact `14863495846` (`import-3aac-fields-jitendex-45264553669-1`) is retained in `/workspace/scratch/3aacd533c01f/evidence/fields-jitendex/`, including the original archive and `independent-verification.json`. Archive SHA-256: `337920e527b0815f0263d344f082c7aecfc64c744e7cf8c1afc0a2a90ad121f1`. All **23 attempted observations succeeded**: three warmups, 18 timed observations and two exhaustive diagnostics; no observed failure or retry.

The parent/control package digest is `5a4504c9423b55d6174d92e9b802e48f6b93111e8867a099690aaa54720d7d76`; candidate `6420a95aef5f9d4d1bfad65ff86a0f26b0565be62aedbaebd36d56c811fe5621`. Exactly one of 550 package entries differs, `js/dictionary/term-record-opfs-store.js`, with the frozen source hashes recorded above; parser WASM is unchanged. All observations retain 436,555 rows after restart, identical lookup results, readable content and 67,466,332 logical OPFS bytes. Both exhaustive diagnostic arms verify all 236 source media files / 4,992,155 bytes with digest `74aeb87663f4b89600affca40005fab432058227cd3fcb31c9f74d19a72a0402`. The built-in phase receipts show 22 source groups and zero compact-metadata groups in every timed arm, confirming a generic-path control.

| Block / order |   A ms |   B ms |   C ms | B/A change | B/C change | C/A control |
| ------------- | -----: | -----: | -----: | ---------: | ---------: | ----------: |
| 1 / ABC       | 1843.4 | 1810.9 | 1786.2 |     -1.76% |     +1.38% |      -3.10% |
| 2 / CBA       | 1807.4 | 1829.2 | 1799.7 |     +1.21% |     +1.64% |      -0.43% |
| 3 / BAC       | 1831.3 | 1787.2 | 1817.2 |     -2.41% |     -1.65% |      -0.77% |
| 4 / CAB       | 1848.7 | 1837.3 | 1864.7 |     -0.62% |     -1.47% |      +0.87% |
| 5 / BCA       | 1908.5 | 1806.5 | 1811.6 |     -5.34% |     -0.28% |      -5.08% |
| 6 / ACB       | 1816.2 | 1821.0 | 1798.3 |     +0.26% |     +1.26% |      -0.99% |

Candidate B/A median paired change is -1.19%, equal-work change -1.48%, four of six pairs faster, with a descriptive bootstrap 95% interval of -3.88% to +0.74%. B/C median is +0.49%, equal-work +0.13%, three of six faster, interval -1.56% to +1.51%. Identical-product C/A median drift is -0.88%, equal-work -1.61%, interval -4.09% to +0.22%. The candidate's apparent B/A advantage is comparable to control drift and reverses against C; **no Jitendex import improvement is demonstrated**.

The saved receipt audit also retains post-restart lookup timings. For the 12-probe first-pass total, A/B/C medians are 94.10 / 114.00 / 101.55 ms; for the mean 12-probe warm pass, 21.30 / 22.27 / 22.65 ms. These sampled settings-page RPC timings are secondary observations, not a qualified reader-latency result; they exclude result hashing and do not exercise the full popup flow.

The Jitendex artifact received a second independent read-only peer review. It found no arithmetic, source/package, schedule or receipt-integrity issue and agreed that the controls do not prove negligible overhead or equivalence. Equal logical OPFS totals are a size check, not persisted file-byte equality.

#### JMdict: complete, noisy source-overhead control

Artifact `14864340210` (`import-3aac-fields-jmdict-45264553669-1`) is retained in `/workspace/scratch/3aacd533c01f/evidence/fields-jmdict/`. Archive SHA-256: `b2cc5e89fe2f7d17e1e367e39352ffc31d73b47deffeecd443e5a9b8336d0695`. The independent audit passed all 23 observations and found no failed attempt or retry. A/C package digest: `70d1275ed0b63c0a9042fa272a7704312f0564b456fb467853d15a25431449e9`; B: `4b58f4e4c72f160dfb6167ffd7f3850e5adc360c9eb169500e2981d8827fb49f`. All 550 entry hashes match the frozen expected identities, with only the intended runtime file differing between A and B. Archives are built separately for each dictionary job; their archive hashes need not equal another dictionary job's package hashes.

Every observation verifies 528,299 rows after restart, identical sampled content and 72 lookup receipts, readable content and 43,520,477 logical OPFS bytes. JMdict has no media. Every timed arm uses three parser workers, 12 source groups and zero compact-metadata groups. The unchanged generic path is therefore the relevant control.

| Block / order |   A ms |   B ms |   C ms | B/A change | B/C change | C/A control |
| ------------- | -----: | -----: | -----: | ---------: | ---------: | ----------: |
| 1 / ABC       | 1012.4 | 1009.0 | 1418.4 |     -0.34% |    -28.86% |     +40.10% |
| 2 / CBA       | 1008.2 | 1070.1 | 1042.2 |     +6.14% |     +2.68% |      +3.37% |
| 3 / BAC       | 1350.7 |  999.2 |  981.6 |    -26.02% |     +1.79% |     -27.33% |
| 4 / CAB       | 1023.7 | 1046.3 |  989.5 |     +2.21% |     +5.74% |      -3.34% |
| 5 / BCA       |  979.8 | 1050.2 | 1002.8 |     +7.19% |     +4.73% |      +2.35% |
| 6 / ACB       |  987.4 | 1001.4 | 1031.7 |     +1.42% |     -2.94% |      +4.49% |

B/A median paired change is +1.81%, equal-work -2.92%, two of six pairs faster, descriptive 95% interval -13.18% to +6.66%. B/C median is +2.24%, equal-work -4.48%, two of six faster, interval -15.90% to +5.23%. Identical-product C/A drift is +2.86% median, +1.63% equal-work, interval -15.33% to +22.29%; the raw control ranges from -27.33% to +40.10%. Long parent/control tails reverse the sign of totals relative to medians. All are retained. **This cell is inconclusive for an import improvement and for negligible overhead.**

The secondary 12-probe first-pass lookup totals have A/B/C medians 128.45 / 82.85 / 129.20 ms; mean warm-pass totals are 17.39 / 17.13 / 18.45 ms. These remain sampled settings-page RPC observations with the same limits as Jitendex.

A second independent read-only peer audit reconciled all 23 JMdict observations, the complete prescribed schedule, source/package/fixture/browser identities, archive digest and every paired point estimate. It found no integrity issue and agreed with the inconclusive interpretation and limited correctness scope.

#### VNDB: complete, no demonstrated total-import benefit

Artifact `14863148612` (`import-3aac-fields-vndb-45264553669-1`) is retained in `/workspace/scratch/3aacd533c01f/evidence/fields-vndb/`. Archive SHA-256: `094258ea5b443ee75b06a682c3fa1037ccc7a50572d4f7d11fd3be51a2b3b8af`. The independent audit passed all 23 observations; there was no failed attempt or retry. A/C package digest: `d48a2b5a0ce7a1aef1f9cf3103c78e50b5a828d571de644d0562545f214efa69`; B: `fffdbadf22aee8b5890b39ad591fb1312667a00bbe0ffd8aa5d2b2283067c95a`. All 550 packaged entry digests match the corresponding JMdict/Jitendex arms, with the one intended runtime-file difference between parent and candidate.

Every observation verifies 6,648,310 rows after restart, readable sampled content, the same 72 lookup receipts and 609,553,611 logical OPFS bytes. Both separate exhaustive-media diagnostics verify all 146,570 source media files / 188,131,284 bytes, digest `ea94d392bc833baf0bee7b3d6becc3d3517eee84ee314a44986438ac6d5217cb`. Timed observations verify the fixed 64-file sample; the full-media diagnostics are excluded from timing. The receipt and size checks retain the same limits as the other dictionaries.

| Block / order |   A ms |   B ms |   C ms | B/A change | B/C change | C/A control |
| ------------- | -----: | -----: | -----: | ---------: | ---------: | ----------: |
| 1 / ABC       | 4800.4 | 4375.4 | 4429.2 |     -8.85% |     -1.21% |      -7.73% |
| 2 / CBA       | 4307.0 | 4462.6 | 4549.0 |     +3.61% |     -1.90% |      +5.62% |
| 3 / BAC       | 4425.2 | 4479.5 | 4456.8 |     +1.23% |     +0.51% |      +0.71% |
| 4 / CAB       | 4630.7 | 4510.0 | 4323.1 |     -2.61% |     +4.32% |      -6.64% |
| 5 / BCA       | 4473.0 | 4556.1 | 4668.2 |     +1.86% |     -2.40% |      +4.36% |
| 6 / ACB       | 4738.6 | 4542.6 | 4380.6 |     -4.14% |     +3.70% |      -7.55% |

B/A median paired change is -0.69%, equal-work -1.64%, three of six pairs faster, descriptive 95% interval -6.49% to +2.74%. B/C median is -0.35%, equal-work +0.45%, three of six faster, interval -2.15% to +4.01%. Identical-product C/A median drift is -2.96%, equal-work -2.07%, interval -7.64% to +4.99%. Control drift is larger than the proposed benefit, and all intervals cross zero. **The component improvement did not establish a material complete-import benefit in this screen.**

The secondary 12-probe first-pass lookup totals have A/B/C medians 28.80 / 28.85 / 29.05 ms; mean warm-pass totals are 10.09 / 10.28 / 10.18 ms. Preserve the candidate first-pass tail of 122.5 ms as well; these sampled RPC observations do not establish reader-latency equivalence.

##### Actual browser eligibility evidence and its limits

All 23 browser observations report **three workers, 170 source groups, 170 parser chunks and 170 compact-metadata groups**. The 4,267,992,967 uncompressed term-bank bytes force `ceil(bytes / 24 MiB) = 170` groups above either worker minimum, so the component's five-worker choice does not create a VNDB group-count discrepancy. It does create the documented JMdict discrepancy. Neither equality of group counts nor compact metadata proves an exact number of row-run admissions.

The VNDB receipts also show 170 successful native scratch-backed lookup preparations, zero native segmented-lookup segments and zero native segmented fallbacks in every observation. In the frozen parser, that successful unsegmented path creates a whole-range `0:count` prepared index. The owned-copy path preserves the map; the database reuses complete prepared maps; the record store's `_encodeAndAppendArtifactChunkForState` uses the whole count rather than the 30,000-row cap when that whole-range prepared index is present. This source trace and the receipts support the inference that prepared-index segmentation did not exclude the run path under this browser partition.

Other exclusions remain explicit. Mixed content-shard names and offset-span splits create slice objects without the private factory witness/compact marker. VNDB's storage receipt contains both `raw-block-v2` and `raw-v6` record shards, and it does not identify final per-chunk slices, score-array types or actual run-admission counts. Ordinary Int32 scores, stable private references and an unsliced factory object are still required. Thus **170 compact groups must not be reported as 170 optimized chunks**, nor may the component's 5,514,978 bypassed rows be presented as a browser counter. The native-to-database integration test proves an eligible real handoff can execute the path, not a full-corpus activation total.

Separate A/B diagnostic observations report 287.5 / 145.5 ms scoped record-field encoding, consistent with the targeted work reduction. These diagnostics are explanatory, excluded from the cohort, and do not replace complete-import timings or remove the HOLD decision. Worker/phase sums are not added to a wall-time budget.

A second independent read-only peer audit verified VNDB's entire cohort, identities, artifact digest, every paired point estimate, exact observed grouping and correctness receipts. It found no integrity issue and independently recommended HOLD. Across the three browser cells, **all 69 attempted observations succeeded**; all 54 timed observations, nine warmups and six separate diagnostics remain retained. No cohort is pooled, no slow observation is excluded, and no additional timing is requested. Source CI is fully green, but performance promotion remains on hold.

## November 23, 2026: adjacent quoted structured values (#848)

**Decision: reject promotion as an import optimization; retain the draft and evidence. No material complete-import benefit is established for JMdict, Jitendex or VNDB.** Two independent 12-block Jitendex confirmations completed without a material gain. Do not promote the component result into an import claim.

### Frozen source and tools

- Parent: `3d65e403c644b9a5a6be3128d72f9d30050b70e0`.
- Published candidate: `09dfb90d926758205ff52d127ef3d950f0b15a65`, [PR #848](https://github.com/ManabiIO/manabitan/pull/848). Its tree `1f9015b2176056ce75c26b5e02054fcd1fd673be` exactly matches the reviewed local commit `38e5d6dbda2bf1e2a809f32cc382ab16bac9ad47`.
- Node 22.22.0; Clang/LLD 21.1.8. Rebuild with the pinned compiler, `node dev/bin/build-dictionary-wasm.js --write`, and `npm run build:libs` completed.
- Term parser WASM: parent SHA-256 `25149bac5db0dda3bba85fe8e133fb06d51881a822f27565e4587ba223dde41c`; candidate `2951cc0320f7ad7ff4c5a64487db8075fcf8b3c6f1283b649a1b050a3b829281`. Raw size grows 37 bytes, from 62,783 to 62,820. Canonical-scan WASM is unchanged.

The C change in `parse_composite_span_impl` sends a bounded, adjacent quoted object value directly through the existing string-validation path after validating its key and colon. It recomputes string-token locals and retains required-field, duplicate-key, hint, nesting and malformed-input behavior. No tuning, allocation policy, storage format or worker count changes. New tests cover escaped/compact/spaced values, required-field and duplicate-last-key semantics, and 1,024 mixed nested objects. An independent control-flow/bounds review found no defect.

### Functional qualification

Seven focused suites passed **1,365 tests**: adjacent delimiters, common colon, composite state, WASM parser, glossary types, format-3 row and parser experiments. Test TypeScript, scoped ESLint and diff checks passed.

The local full-unit command `npm run test:unit -- --maxWorkers=2` **did not complete cleanly**: 640 suites passed and 1 failed; 14,400 tests passed, 2 failed and 47 skipped. Both failures were 5,000 ms timeouts in unchanged `test/term-entry-content-hash.test.js`, under `term content XXH32 pair`:

- `respects a byte offset of 15 and leaves the backing buffer unchanged`
- `reads a stable shared subrange without changing its owner`

No assertion mismatch was reported. The observed failure reason is timeout; no baseline reproduction or causal claim is made. This command finished with failure rather than being aborted. Its chained local all-target dry build and pinned `--check` did not run. Preserve `jitendex-unit.log` with this result.

Exact-tree [source CI run 45261383648](https://github.com/ManabiIO/manabitan/actions/runs/45261383648) passed all jobs, including full unit/options, all TypeScript/lint lanes, build, Chromium/Firefox E2E and Anki. Those are the passing full-unit/build gates; they do not erase the local timeout result. No duplicate local rerun was performed after CI passed.

### Complete corpus native parity

The separate baseline/candidate WASM-instance replay compared every canonical byte, row metadata/hash/score/sequence/reading flag, unique ID, complete dedup plan including three-word native signatures, content-layout flag, compact/original key plan, prepared index byte and projected media row before either instance was reused. Archive SHA-256/size, bank ZIP CRC, tracked-clean source guards and source/WASM identities were checked.

| Corpus   |      Rows | Banks | Canonical bytes | Prepared index bytes |
| -------- | --------: | ----: | --------------: | -------------------: |
| JMdict   |   528,299 |    53 |     101,089,395 |           19,491,860 |
| Jitendex |   436,555 |   219 |     389,702,339 |           20,078,148 |
| VNDB     | 6,648,310 |   665 |      91,711,144 |          352,970,156 |

All **7,613,164 rows / 937 banks** matched. Receipt: `native-parity.json`; helper: `verify-native-import-parity.mjs`. This establishes native output parity, **not exhaustive persisted-database equality**. The first helper attempt rejected a Node Buffer subclass in the ZIP reader before parsing any bank; its log/receipt are retained. The helper then used `new Uint8Array(archive)` and completed without candidate changes.

Pinned archive SHA-256 values:

- JMdict: `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`
- Jitendex: `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356`
- VNDB: `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`

### Component and complete-import results

The fixed four-pair Jitendex component screen reported a -40.61% paired median and -44.47% equal-work change, with all output digests identical and the same maximum per-instance WASM heap of 89,063,424 bytes. Large drift makes this exploratory; it excludes worker IPC, global persisted deduplication, compression, OPFS and UI. Retain `jitendex-component.json` and its log without claiming a full-import gain.

[Complete-import screen 45261611887](https://github.com/ManabiIO/manabitan/actions/runs/45261611887) used Chrome 153.0.8010.12, production defaults, six counterbalanced three-arm blocks per corpus, excluded warmups and separate exhaustive diagnostics. A and C are identical baseline product bytes; B is the frozen candidate. Source/package receipts confirm only intended runtime code/WASM differences. Positive percentages mean slower.

| Corpus   | B/A paired median (descriptive 95% interval) | B/C paired median (descriptive 95% interval) | Identical C/A paired median | B/A equal-work change |
| -------- | -------------------------------------------: | -------------------------------------------: | --------------------------: | --------------------: |
| JMdict   |                      +0.17% (-3.26%, +1.65%) |                      +0.69% (-1.85%, +2.06%) |                      -0.68% |                -0.52% |
| Jitendex |                      +2.55% (-0.76%, +4.47%) |                      +2.97% (-7.03%, +6.74%) |                      +1.07% |                +2.04% |
| VNDB     |                      +0.36% (-1.19%, +3.07%) |                      -3.07% (-4.39%, +0.84%) |                      +3.06% |                +0.74% |

These are exploratory six-block screens, not independent qualification. Bootstrap intervals are descriptive, with no multiple-comparison correction. Jitendex identical-control pairs range from -9.34% to +20.71%; VNDB's apparent benefit versus C is comparable to its +3.06% identical-code drift. None establishes a material complete-import win. VNDB's 23 observations passed their validation; exhaustive diagnostics matched all 146,570 images / 188,131,284 media bytes and 609,553,611 storage bytes.

Evidence directories: `evidence/structured-jmdict`, `evidence/structured-jitendex`, `evidence/structured-vndb`, including every timing observation, `analysis.json`, source/package receipts and diagnostics. VNDB artifact ID `14861594885`, archive SHA-256 `009737518bb3cff3086ff28f9d3205739d949bbb79574ee7e05f27b2f1db570f`.

### Independent Jitendex confirmation completed

[Run 45263702223](https://github.com/ManabiIO/manabitan/actions/runs/45263702223), workflow revision `3a7ef48cf76e4f5ff52d41aefc41909018ee9fbd`, completed the fixed 12-block plan on each of two separate four-CPU hosts. Host 1 used AMD EPYC 7763; host 2 used Intel Xeon Platinum 8573C with the reversed schedule. Source, fixture, runtime defaults and browser version remained frozen. Each host retained all 41 successful observations: 36 timed imports, 3 excluded warmups and 2 exhaustive diagnostics. No retry, exclusion or extra timing cohort was used.

The hosts are reported independently. Positive changes mean slower; intervals are descriptive 95% block-paired bootstrap intervals. The analysis was recomputed from the retained observations, including every tail.

| Host               | Comparison          | Paired median (95% interval) | Equal-work change | Faster pairs | Worst pair |
| ------------------ | ------------------- | ---------------------------: | ----------------: | -----------: | ---------: |
| 1: AMD             | B/A                 |      +0.25% (-0.68%, +0.95%) |            +0.51% |         5/12 |     +3.89% |
| 1: AMD             | B/C                 |      -0.07% (-2.61%, +1.23%) |            -1.77% |         6/12 |     +2.81% |
| 1: AMD             | C/A, identical code |      +0.65% (-0.84%, +2.16%) |            +2.32% |         5/12 |    +23.98% |
| 2: Intel, reversed | B/A                 |      +0.23% (-0.50%, +1.41%) |            +0.46% |         6/12 |     +3.03% |
| 2: Intel, reversed | B/C                 |      +0.14% (-1.42%, +0.39%) |            -0.92% |         5/12 |     +1.09% |
| 2: Intel, reversed | C/A, identical code |      +1.47% (-0.34%, +1.86%) |            +1.39% |         4/12 |     +7.78% |

The original +2.55% Jitendex screen estimate did not recur at that magnitude. Neither independent host establishes a material benefit: B/A paired medians are slightly slower, and B/C differences are small relative to unchanged-code drift. The intervals do not establish exact equivalence or rule out small regressions. Reject promotion on the current evidence; no further retry was made to seek a favorable outcome.

Independent receipt verification passed for all 82 observations. Source/harness hashes matched the frozen local baseline, candidate C/WASM hashes matched the tested tree, and each 550-entry package inventory differed only in the two intended runtime files. A and C used identical archive hashes and entry bytes within each host. Every report used a clean frozen source, Node 22.22.0, Chrome 153.0.8010.12, production defaults and OPFS without fallback, tracing, screenshots or process sampling. Recorded browser-monotonic import durations exactly matched the observation/analysis arrays.

Every observation passed restart/inventory checks for 436,555 terms and 72 lookup-result receipts. Exhaustive diagnostics matched all 236 media files / 4,992,155 bytes; their media digest is `74aeb87663f4b89600affca40005fab432058227cd3fcb31c9f74d19a72a0402`. OPFS logical storage totals were consistently 67,466,332 bytes. These checks plus the separate native replay do not constitute exhaustive persisted definition/index byte equality, and no process-memory improvement is claimed.

Retained archives were hash-checked against GitHub artifact digests and extracted only after rejecting absolute/traversing paths and symlinks; ZIP CRC was checked during extraction:

- Host 1: artifact `14863445580`, 1,737,281 bytes, archive SHA-256 `dd1b01ea10b22b1a699b1ab7ed365ae0a316bf6c09cac8b4496b60c17c67fefc`; evidence `evidence/structured-confirmation-1`.
- Host 2: artifact `14863326265`, 1,738,392 bytes, archive SHA-256 `b3fc6b9b7b86abb143e499365218a399408cd272142db4450bb4789ecbd19927`; evidence `evidence/structured-confirmation-2`.

Verification helper: `verify-pr848-confirmation.py`; separate receipts: `evidence/structured-confirmation-1-verification.json` and `evidence/structured-confirmation-2-verification.json`. Each receipt preserves exact per-pair changes, descriptive intervals, package archive hashes, correctness scope and its own recommendation. No host or stage was pooled.

### Rejected follow-up: transfer parser-owned content blocks directly

A read-only audit considered partitioning the parser's private output into existing compression blocks and transferring surviving whole blocks without the main-thread packing copy. **Rejected before implementation or additional replay:** current ownership/recovery contracts require stable original bytes after dispatch.

- `copyWasmBackedColumnChunk` in `term-bank-wasm-parser.js` publishes one compact owned slab. Global dedup later removes spans; `planContentSpansIntoSlabs` in `term-content-block-store.js` computes the actual greedy plan from that selected sequence. A low duplicate count does not prove unchanged block boundaries. Existing `packPlannedContentSpansIntoSlabs` already coalesces contiguous spans.
- `TermContentBlockStore._tryAppendPacked` repacks from the original stable source after any worker/transfer failure. `TermContentCompressionPool._compress` transfers complete private input buffers; transferring the producer's only copy would detach the recovery source.
- Even successful compression may fail the unchanged savings test in `_appendCompressedBlocks`. `DictionaryDatabase._persistArtifactTermContent` then needs the original spans for raw storage. `_publishArtifactTermContentMetadata` also retains source-dependent collision handling, and `_cacheRecentPublishedTermContentSources` may adopt/copy source bytes under the existing bounded policy. An ownership witness for cache adoption is not proof those obligations have ended.
- The baseline Jitendex diagnostic shows 389,707,807 owned parser bytes, 363,277 scanned canonical rows, 363,243 newly persisted contents and 34 persisted hits, with no recent-source adoption. It does not prove transferable whole-block coverage or remove generic failure/cache obligations. Overlapping phase sums are not critical-path wall time.
- A backup restores the copy being removed; retaining parser memory or introducing recoverable worker-return ownership changes lifetime/protocol obligations. No new memory allowance, fallback weakening, block-plan change or representation prototype was introduced.

Live #847 and #851 were inspected as separate packing/compression scheduling alternatives. Both retain stable source bytes for repacking and preserve the actual block plan; neither supplies the missing ownership proof for this proposed copy removal. Do not duplicate those proposals or revive the rejected shared-source memory tradeoff from #810/#839.

## November 23, 2026: three JMdict parser screens retained without promotion

None of these three independent source candidates established a useful speedup. Reject the generic empty-string and empty-metadata candidates; hold the compact-separator candidate as a no-gain result. Do not publish any of them as an optimization PR, combine their timings, or retime an unchanged candidate to select a favorable outcome. No fourth hypothesis or full-browser qualification followed.

### Frozen source and build identities

All three start independently from `3d65e403c644b9a5a6be3128d72f9d30050b70e0`, tree `c540375466fc921ab05a5526a6130bc2d48010d5`. They change only the C parser, focused format-3 tests, and the pinned generated parser WASM/manifest. Defaults, planners, grouping policy, concurrency, compression and storage formats are unchanged.

| Candidate                     | Commit                                     | Tree                                       |
| ----------------------------- | ------------------------------------------ | ------------------------------------------ |
| Generic empty string          | `29fec53c8884b3ba9a4ada51dbb669878659d33e` | `32c04eaf4fe94c0d1bbbab58c21095757718b096` |
| Empty rules and term tags     | `b02d58e92e497a8d5389ac0256ca5fce34a366dd` | `2cc01acf6eb8c4f5d7684922823ffcae63ea0092` |
| Compact strict row separators | `a9d71878728a634672ae0c01e0951f7981fcf36d` | `6ea81b118adc999f1d44a542fe8b46135e350b04` |

The generic candidate bypasses string scanning for bounded `""` tokens. The metadata candidate applies the shortcut only to the strict row's rules and term-tags fields. The separator candidate bypasses both whitespace scans only for a bounded comma followed by a byte above ASCII space; the existing whitespace fallback and field validators remain authoritative.

Node was 22.22.0 and compiler/linker were the repository-pinned LLVM/LLD 21.1.8. Baseline parser WASM is 62,783 bytes, SHA-256 `25149bac5db0dda3bba85fe8e133fb06d51881a822f27565e4587ba223dde41c`.

| Candidate                     | Parser WASM bytes | Growth | Parser WASM SHA-256                                                |
| ----------------------------- | ----------------: | -----: | ------------------------------------------------------------------ |
| Generic empty string          |            63,484 |   +701 | `ffd26a4fc3abd02b69fb7bfc975d214ac2b004edb85df56a182a7dcfcbc628f2` |
| Empty rules and term tags     |            62,883 |   +100 | `2c131887846ef0d8083eb7d04b78bc2b9c511862ab8e4056af43a590f263c141` |
| Compact strict row separators |            62,969 |   +186 | `4647c8c23feb30034e64696234db1d0995cc87fd9bc5b1d88366f8ad87b0f53b` |

The canonical-content scanner is unchanged: SHA-256 `40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af`. [sources.json](https://github.com/ManabiIO/manabitan/blob/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/jmdict-parser/sources.json) records every source/test/artifact hash, full manifests, report hashes and exact reconstruction checks. The three `git diff --binary` patches beside it include the tested generated artifacts. Applying each patch to a temporary index based on the common baseline produced exactly its recorded candidate tree.

### Fixture, timing boundary and complete outcomes

These cohorts use the fixture locked at this baseline: JMdict SHA-256 `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`, 15,645,766 archive bytes, 53 term banks and **528,299 rows**. The lock SHA-256 is `60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89`; earlier historical row counts in this handoff do not describe this lock.

Each distinct frozen candidate received one predeclared four-pair AB/BA/AB/BA cohort on the same quiet local host, with two excluded complete warmups per fresh child and default flags `{}`. The existing runner enables `validateGlossaryTypes`. It measures resident decoded banks, grouped seven at a time, through parsing and completed lookup preparation. Fixture I/O and inflation, IPC, Zstd, OPFS and UI completion are outside that boundary. Warmup durations are not recorded by this component runner. No observation was discarded or replaced.

Positive percentages mean slower candidate time. These are exploratory component results, not browser import estimates.

| Candidate                     | UTC interval on November 23 | Median paired change | Equal-work total change | Faster pairs | Decision |
| ----------------------------- | --------------------------- | -------------------: | ----------------------: | -----------: | -------- |
| Generic empty string          | 20:32:05–20:33:06           |             +7.5966% |               +13.4613% |          2/4 | reject   |
| Empty rules and term tags     | 20:40:53–20:41:55           |            +60.4362% |               +49.5969% |          0/4 | reject   |
| Compact strict row separators | 21:05:19–21:05:59           |             +4.7445% |                +3.4762% |          2/4 | hold     |

Every timed observation is listed below. The original reports retain full precision, lookup timings, source identities and process-memory fields.

| Candidate                     | Pair | Executed order | Baseline A, ms | Candidate B, ms |
| ----------------------------- | ---: | -------------- | -------------: | --------------: |
| Generic empty string          |    1 | A then B       |     860.552292 |      777.870301 |
| Generic empty string          |    2 | B then A       |     514.033431 |      972.863213 |
| Generic empty string          |    3 | A then B       |     813.646116 |      678.131946 |
| Generic empty string          |    4 | B then A       |     475.586002 |      593.537035 |
| Empty rules and term tags     |    1 | A then B       |     782.175498 |     1248.398214 |
| Empty rules and term tags     |    2 | B then A       |     489.250885 |      828.633586 |
| Empty rules and term tags     |    3 | A then B       |     660.741064 |     1065.554634 |
| Empty rules and term tags     |    4 | B then A       |     652.734589 |      724.347549 |
| Compact strict row separators |    1 | A then B       |     471.025411 |      426.001776 |
| Compact strict row separators |    2 | B then A       |     450.647028 |      530.945429 |
| Compact strict row separators |    3 | A then B       |     577.926462 |      534.259450 |
| Compact strict row separators |    4 | B then A       |     446.032064 |      522.057628 |

Across all 24 observations, the complete component oracle covered all 528,299 rows and all 19,491,860 prepared index bytes, compact key plans, reading-equality flags, scores, sequences and canonical row-content bytes/metadata. The resulting content/key/index SHA-256 was always `824881eada22d2d2f9ac8feddb66322e2bab124fe6af634ef5ded7c303c40b9b`. Each observation reported 21 native segments, 31,186,704 retired scratch bytes reused and maximum observed parser WASM allocation of 61,603,840 bytes. Scratch reuse is an operation count, and the per-parser allocation is not total concurrent browser memory. Post-verification RSS and lifetime maxRSS are retained without treating them as import peak memory. This oracle does not establish equality of a fully persisted database.

Activation was audited separately from timing: JMdict has 955,459 empty strings in its string row fields, including 913,581 empty rules/term-tags fields; all 3,698,093 row separators met the compact-separator condition. The small activation reports record the archive hashes and methodology. Operation counts do not establish a latency benefit.

### Correctness and reproducibility

The generic and metadata candidates each passed six focused suites with 531 tests. The separator candidate passed six focused suites with 541 tests, including all 36 combinations of JSON whitespace around separators, invalid controls/non-JSON whitespace and missing fields. Scoped ESLint and diff checks passed. The generic candidate's initial run had one incorrect test expectation for a raw glossary object; the expectation was corrected without changing runtime code. Both the failed run and subsequent passing output are retained. Independent source reviews found no bounds, parser-state or malformed-input acceptance issue. No full-unit or browser qualification is claimed for these rejected/held sources.

The benchmark harness was unchanged at `dev/perf/import-lookup-screen.js`, SHA-256 `3d1a1fabd0b7827f279ec7d39d88c96ab830bc214a40cdbdee35773892a4119a`. Reconstruct each candidate independently from its patch on the common baseline, install the locked dependencies, use pinned LLVM/LLD 21.1.8, run `npm run build:dictionary-wasm` and `npm run build:libs` in each checkout, then verify generated manifest/WASM hashes against `sources.json`. The measured invocation, with absolute checkout/cache paths substituted, was:

```sh
node dev/perf/import-lookup-screen.js jmdict --pairs 4 --flags '{}' \
  --baseline-root /absolute/path/to/baseline \
  --source-root /absolute/path/to/one-candidate \
  --cache-dir /absolute/path/to/locked-dictionary-cache \
  --out builds/perf/unique-candidate-component.json
```

Retain the unchanged existing harness. New evidence lives in [evidence/20261123-jmdict-parser](https://github.com/ManabiIO/manabitan/tree/d03649834ff5adc4fe484ea66b99cfe61c1eeed5/builds/perf/import-20261123-3aac/jmdict-parser): the three original complete cohort reports, their exact binary source patches, `sources.json`, the aggregate `jmdict-attempts-summary.json`, two activation reports and small validation logs. No corpus captures, dependencies, product branches or redundant harness copy are needed. The aggregate is an index of separate experiments and does not pool their results.

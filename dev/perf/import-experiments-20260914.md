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

## 2026-11-19: JMdict source-candidate screening

**Decision: retain four reproducible experiments; promote no runtime change.** This roughly two-hour round completed 28 fixed eight-pair cohorts (448 successful child observations), plus an interrupted two-observation A/A attempt retained separately. Neither whole-import speed nor a reliable component improvement was established. The deliverable strengthens the screening tools and preserves the exact candidate patches and evidence.

This section describes the November source comparison. Earlier instructions about historical experimental defaults apply to their original round; this work preserves the current source defaults. It does not alter worker counts, cache capacities, compression settings, scheduling, storage formats or production flags.

### Exact sources, fixtures and delivery

All four independent runtime candidates start from `develop` commit `d829f5b6e6a75ee8859d38d537d224ec33c4930e`:

| Candidate                     | Tested local commit                        | Expected reconstructed tree                | Work removed                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Numeric token ends            | `dfabe18acf18b36aef4d84a652fde29cfc6ea734` | `c8e7c830f00b2dc72a9a302cf5349c71fa3c73b3` | Carries validated score/sequence token ends into fused conversion, avoiding a repeated boundary scan while preserving numeric fallback.                                                     |
| Previous same-field key reuse | `604c3050130d28b3fdabbd822b2adfac02423a8b` | `49ef9adaa33f6e0ba68def569064dd0530fcfd82` | Reuses an immediately preceding expression/reading ID only after complete raw-token equality; misses retain the existing decode/hash/probe path.                                            |
| Escape witness                | `eb751ca9ef13dc2a17b46343ab70d436fd40b330` | `02d7b2128a1ca1d9a28788800a1b774672f05160` | Carries the grammar scanner's escape observation into fused key interning; the generic parser ABI remains unchanged.                                                                        |
| Recent-source preflight       | `5bdaf01c47fdddf27211a461afb9e67df17dacbf` | `74f1a63e80c49b306262958fb46987db44cd134c` | Checks the primary eligible owned recent source before allocating candidate-wave bookkeeping; signatures and full bytes remain required, with collision order and storage errors preserved. |

The standalone binary patches and per-file identities are in [candidates/source-manifest.json](../../builds/perf/20261119/candidates/source-manifest.json). Each patch was applied to a fresh temporary index at the recorded base; all four resulting Git trees exactly matched the tested trees. Patches include changed tests and source-bound native artifacts. None is applied to this tooling branch's runtime.

The tooling follow-up is based on [PR #757](https://github.com/ManabiIO/manabitan/pull/757), head `323e3f1369e5dce86fe8cd86e44c2a739f67a2ff`. It preserves that PR's production glossary validation, arm-root handling and predeclared binary-hash checks. The final merged lookup runner has SHA-256 `0f29a684249e012292f7e4a75966141a5393e97ad649f175a0bc6eb7785697ba`. It is functionally checked separately; historical timing does not silently inherit this later runner identity.

Measurements used Node `v24.22.3` / V8 `13.6.233.17-node.63`. Native artifacts were regenerated with manifest-pinned Clang and LLD **21.1.8**, extracted from verified LLVM Debian packages. Normal reproduction can use the checked-in, source-verified WASM without installing a compiler; intentional regeneration follows `dev/data/dictionary-wasm/README.md`.

| Locked dictionary | Revision              | Term rows | Archive SHA-256                                                    |
| ----------------- | --------------------- | --------: | ------------------------------------------------------------------ |
| JMdict            | `JMdict.2026-09-06`   |   526,942 | `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a` |
| JMnedict          | `JMnedict.2026-09-06` |   667,942 | `d3afb02f2dbe4837ce1799c4a9fd9917bca6749c77a440ca87bc9f0890b3cd12` |
| Jitendex          | `2026.08.11.0`        |   435,448 | `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc` |

`test/perf/dictionaries.lock.json` remains authoritative. The lookup runner checks locked archive hashes, ZIP CRCs and complete term counts. The dedup runner additionally checks archive size, title and revision. Reports record fixture, runner, source, manifest and built-WASM identities. Source or identity drift fails a cohort.

### Scope and oracle corrections

Chromium startup in this workspace failed with socket `EPERM`; automatic approval review rejected the unsandboxed retry. That local block is retained in the evidence. It is not a claim that browser qualification is unavailable elsewhere. All measurements here are **Node component screens**, excluding ZIP inflation, worker transport/scheduling, compression, actual OPFS/disk latency and UI completion.

The lookup oracle now checks original and compacted key plans, scores, sequences, reading flags, media references, every canonical row mapping, representative, signature and metadata field, all canonical content bytes and every prepared lookup byte. It verifies bounds, callback counts and ownership spans before borrowed memory can be reused. Fused attempts, fallbacks and other executed-path counts are retained. Earlier observations retain their earlier guarantees.

The first complete oracle created one temporary content view/hash update per JMdict row between timed groups. Excluding verification's duration does not prevent its allocations from affecting later groups. The revised oracle proves first-use order and contiguous canonical coverage, then hashes one used slab per group while retaining all row checks. This removes 526,934 temporary content views per eight-group JMdict pass. It is a benchmark allocation correction, not an import optimization.

A separate diagnostic recorded 201 versus 56 GC events, but total observed pauses increased from 354.45 to 447.42 ms. Those single processes include startup, warmups, explicit GC and verification; they establish neither lower pause time nor the cause of all timing variation.

The new dedup screen executes the production parser, `DictionaryDatabase` resolver, `NativeCanonicalScanner` and publication path against exact-byte virtual storage. It checks all row references, content bytes and counters, including publication-return mappings. Review removed a mapping overwrite that could have hidden errors and added the production `dictionaryTotalRows` capacity hint; retained final observations use one native arena instance. Virtual writes do not supply production's `metadataValidated` witness, so publication still includes generic validation. The nested exact timer overlaps the resolver timer; **do not add them**. Ownership copies are preserved because borrowed parser buffers can be reused. Parsing and group assembly are outside the dedup timers. The harness retains parsed fixture and verification data, so its memory footprint is not production-import memory. Its fixed 7/9/10-bank grouping determines the reported cross-group checks and cache-hit counts.

The synthetic key screen checks 20,000 rows in two banks across repeated runs, unique keys, common prefixes and escaped runs. Its untimed oracle includes key/content/dedup/lookup output. These controls explicitly enable fused-single-bank and escaped-key paths; they do not establish browser performance.

### Protocols and all retained attempts

[summary.json](../../builds/perf/20261119/summary.json) and [summary.csv](../../builds/perf/20261119/summary.csv) retain separate results for every cohort. Each A/B pair is one comparison; measured passes within a child are averaged, never treated as independent pairs. All slow tails remain. Descriptive 95% intervals use 10,000 paired bootstrap resamples with seed `20261119`; eight pairs on a shared host do not establish independent samples or qualification.

| Stage                             | Frozen protocol                                                                                          | Evidence paths within the campaign                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Initial parser screen             | Unrestricted CPU, two warmups, one measured pass; earlier oracle (`ad1140fe…`)                           | `numeric-screen-jmdict.json`, `parser-aa-jmdict.json`                             |
| Complete parser oracle            | Unrestricted CPU, two warmups, three measured passes (`c37cfd1c…`)                                       | `parser-aa3-jmdict.json`, `keys-screen-jmdict.json`, `escapes-screen-jmdict.json` |
| First affinity protocol           | Logical CPU 0, same three-pass oracle, reversed candidate initial orders                                 | `parser-aa3-affinity0-jmdict.json`, `affinity0/`                                  |
| First key controls                | CPU 0, two warmups, three measured passes                                                                | Four `affinity0/keys-control-*.json` files                                        |
| Final bulk-oracle parser protocol | CPU 0, two warmups, three measured passes; measured runner from `8744fd6`, SHA `57d4064a…`               | Four parser reports in `bulk-affinity0/`                                          |
| Final synthetic controls          | CPU 0, ten warmups, ten measured passes, fixed before execution                                          | Six key reports in `bulk-affinity0/`                                              |
| Dedup retry                       | CPU 0, two warmups, one measured pass, unchanged runner `f0e7bed4…`, eight pairs in each of five cohorts | `dedup-retry-affinity0/`                                                          |

Do not pool these protocols or subtract A/A variation as a correction. Immutable runner snapshots, plans, commands, child profiles and logs are preserved. Conditional additional-corpus parser screens were not started after the JMdict signals failed qualification; they are not missing successful results.

The initial `bulk-affinity0/dedup-aa-jmdict.json` stopped with two observations when its execution session became unavailable. Its exit code and cause are unknown; OOM was not established. Original bytes remain untouched with a hash-bearing interruption sidecar. The complete retry uses a new output directory and does not salvage or append those samples. Single-child smokes and final delivery checks are functional evidence, outside the 28 timing cohorts.

### Final parser results

Negative changes are faster. All rows below use the final bulk-oracle protocol, eight pairs each, on JMdict. “Total” compares the sums of equal-work child times; it is distinct from the median paired percentage.

| Comparison                    | Paired median wall | Equal-work wall total | Faster pairs | Paired median CPU | Descriptive wall 95% interval |
| ----------------------------- | -----------------: | --------------------: | -----------: | ----------------: | ----------------------------- |
| Identical-source A/A          |             −2.83% |                +2.71% |          5/8 |            −1.99% | −21.73% to +23.86%            |
| Previous same-field key reuse |             +2.08% |                +2.31% |          4/8 |            +2.27% | −11.79% to +17.40%            |
| Escape witness                |             +0.74% |                −3.00% |          4/8 |            +1.66% | −28.96% to +13.82%            |
| Numeric token ends            |             +1.90% |                −2.81% |          3/8 |            −0.31% | −25.11% to +21.12%            |

All final bulk-oracle JMdict parser comparisons passed the full output oracle. Every arm had the same maximum individual WASM heap, **61,603,840 bytes**. The final path records contain eight fused groups, zero fallbacks/discarded rows, zero escaped decodes, 54,877 validated glossary reuses and 21 native lookup segments. These are component counters, not process-tree memory or production grouping claims. **Hold all three candidates.**

Final synthetic controls also failed to provide reliable attribution:

| Lane                     | Paired median wall | Equal-work total |
| ------------------------ | -----------------: | ---------------: |
| Repeated-key A/A         |             −7.91% |           −1.61% |
| Unique-key A/A           |            −20.25% |          −15.91% |
| Key reuse: repeated runs |             −9.77% |          +41.45% |
| Key reuse: unique        |             +6.72% |          +16.60% |
| Key reuse: shared prefix |            +26.19% |          +22.04% |
| Key reuse: escaped runs  |            −30.21% |          −16.81% |

The common-prefix slowdown is an adverse lead to retain, not a qualified estimate independent of the failed controls. Favorable escaped-run timings do not override the real JMdict result or same-code variation.

### Final dedup results

Each cell below shows **paired median / equal-work total** wall-time change. All five cohorts have eight complete pairs. All 80 observations passed; output digests and work counters matched between arms within each cohort, verified separately in `dedup-retry-affinity0/verification.json`.

| Comparison                 |           Resolver | Nested exact equality |       Publication |
| -------------------------- | -----------------: | --------------------: | ----------------: |
| JMdict 48 MiB A/A          |    +6.09% / +9.56% |      +2.12% / +23.68% | −14.33% / −28.03% |
| Preflight, JMdict 48 MiB   |   −9.95% / −33.33% |      −8.88% / −57.66% |  −9.80% / +17.21% |
| Preflight, JMdict 96 MiB   |   −8.57% / −28.04% |     −33.36% / −38.69% |  −6.60% / −18.53% |
| Preflight, JMnedict 48 MiB |    −2.04% / +9.84% |      +2.32% / −12.86% | +17.59% / +46.07% |
| Preflight, Jitendex 48 MiB | −14.63% / +135.32% |     −1.78% / +149.93% | +27.63% / +43.96% |

The strongest lead is JMdict's fully cached exact phase: six of eight pairs faster, paired median −33.36%, descriptive interval **−72.02% to +11.42%**. It still includes slower outcomes. Resolver intervals for 48/96 MiB are −46.90% to +17.73% and −38.64% to +15.42%. Unchanged-code controls are noisy; Jitendex has a large retained candidate tail. **Hold the preflight candidate. No dedup or complete-import speedup is qualified.**

JMdict performs 3,750 exact descriptor checks: at the unchanged 48 MiB policy, 2,915 hit the recent-source cache and 835 read virtual storage; at the existing 96 MiB policy all 3,750 hit. JMnedict has 75,804 cached exact checks; Jitendex has 32 exact checks and no cache hits. `--device-memory-gib 8` selects the runtime's existing 100,663,296-byte policy, separately from the default 50,331,648-byte policy. It does not simulate a constrained physical machine or authorize a cache-size change.

### Reproduction and evidence verification

The historical checkout was `/workspace/scratch/f34c9c9fae89/manabitan`, with sibling worktrees named `manabitan-baseline`, `manabitan-parser`, `manabitan-keys`, `manabitan-escapes` and `manabitan-storage`. Those absolute paths in reports are provenance; adapt local paths when reproducing. The delivered checkout is `manabitan-tooling`.

From a clean checkout of this tooling follow-up, reconstruct one candidate without requiring the original local commit to be present on the remote:

```sh
git worktree add --detach ../jmdict-baseline d829f5b6e6a75ee8859d38d537d224ec33c4930e
git worktree add --detach ../jmdict-keys d829f5b6e6a75ee8859d38d537d224ec33c4930e
git -C ../jmdict-keys apply --index --binary \
  "$(pwd)/builds/perf/20261119/candidates/keys.patch"
git -C ../jmdict-keys write-tree
```

The last command must print `49ef9adaa33f6e0ba68def569064dd0530fcfd82`. Use the corresponding patch and expected tree above for each independent candidate. Inspect the staged diff, then make a local commit if a clean commit identity is desired; the reconstructed tree is the byte-level identity. In each worktree run `npm ci` and `npm run build:libs` so it uses its own source-verified WASM. Prepare the locked archives with `node dev/perf/prepare-dictionaries.js` in the tooling checkout, or pass an already verified cache.

Run new cohorts sequentially with no concurrent builds, tests or profilers:

```sh
taskset -c 0 node dev/perf/import-lookup-screen.js jmdict \
  --baseline-root ../jmdict-baseline --source-root ../jmdict-keys \
  --cache-dir ./builds/e2e-dictionary-cache \
  --flags '{}' --pairs 8 --initial-order BA --passes 3 \
  --out builds/perf/review-keys-jmdict.json
taskset -c 0 node dev/perf/term-key-reuse-screen.js runs \
  --baseline-root ../jmdict-baseline --source-root ../jmdict-keys \
  --pairs 8 --initial-order BA --warmups 10 --passes 10 \
  --out builds/perf/review-keys-runs.json
taskset -c 0 node dev/perf/import-dedup-screen.js jmdict \
  --baseline-root ../jmdict-baseline --source-root ../jmdict-storage \
  --cache-dir ./builds/e2e-dictionary-cache \
  --pairs 8 --initial-order BA --device-memory-gib 8 \
  --out builds/perf/review-dedup-high-memory.json
```

Create `../jmdict-storage` with `recent-source-preflight.patch` before the last command. For A/A, use the baseline root for both arms. CPU 0 must be allowed on the host; a different affinity is a separately declared protocol. Freeze all sources and generated artifacts throughout a cohort.

Those commands use the delivered tools. To reproduce an earlier runner exactly, copy its SHA-named snapshot from `builds/perf/20261119/runners/` to its original `dev/perf/` filename in a separate tooling checkout before running; snapshots cannot run directly from the evidence directory because their relative imports expect `dev/perf/`. Do not overwrite the runner during a cohort.

The candidate patches, summaries and runner snapshots are individually committed. `evidence.tar.gz` contains raw observations, command receipts, diagnostic logs and plans. Final validation receipts are committed separately under `validation/`. `evidence-manifest.json` records every archive member's byte length and SHA-256 and the archive hash. Extract the archive at the repository root to restore its `builds/perf/20261119/` paths; then run `python builds/perf/20261119/summarize-results.py` to regenerate the campaign summary. Final delivery functional checks under `validation/` are excluded from campaign aggregation. An archive is not required to construct the candidate source or run a fresh screen.

### Validation and next decision

Focused source validation passed: numeric bounds **469 tests** (17 new), previous-key reuse **218 tests** (19 new), escape witnesses **470 tests**, and recent-source preflight **137 tests** (8 new). These suite counts overlap and must not be added as distinct tests. Pinned native rebuild checks and relevant scoped lint passed for the native candidates. The storage candidate passed main TypeScript checking. The merged three tooling files passed scoped ESLint and the full dev TypeScript project.

The final tooling commit is `18c990a857a589d0e3c7ae3f2d1b5040189286ae`, directly atop PR #757. All seven dry-build targets passed. A separate two-pair AB/BA JMdict smoke passed in all four observations: requested baseline/key roots and pinned WASM, production glossary validation, 526,942 rows, 19,446,728 lookup-index bytes, eight fused attempts and zero fallbacks/discarded rows. The complete digest was identical throughout. These smoke timings are excluded from the campaign. Exact commands, source hashes and outcomes are in [tooling-validation.json](../../builds/perf/20261119/validation/tooling-validation.json).

The storage candidate also passed all seven dry-build targets. Its first full-unit attempt passed 614 test files and 13,654 tests, but two suites failed setup because this invocation omitted the pinned compiler environment. A first focused retry still could not find the versioned `wasm-ld-21` executable. Adding the extracted compiler's `usr/bin` and LLVM bin directories to `PATH` fixed resolution; both suites then passed all 20 tests without a repository change. Every failed attempt is retained. A final full-suite retry with that proven environment is running; it is not yet counted as passed. Its eventual receipt will be added to this same evidence directory.

These checks qualify only their named source checkout; they do not retroactively establish browser, persistence or performance behavior for every candidate.

Concurrent [PR #758](https://github.com/ManabiIO/manabitan/pull/758), [PR #759](https://github.com/ManabiIO/manabitan/pull/759) and [PR #760](https://github.com/ManabiIO/manabitan/pull/760) cover related but different cache-copy, publication and escape-witness implementations. Their source trees, binaries and protocols differ. This round neither modifies those branches nor borrows their measurements or tests to qualify these patches.

A next performance decision requires a quiet supported browser host, same-source controls, reversed-order replication, complete file-input-to-UI import timing and exact persistence/reopen equality. Keep cancellation/recovery, process-tree memory, stored size and subsequent lookup latency as separate gates. Full Chromium/Firefox import, OPFS persistence, recovery and lookup qualification were not completed here. The current evidence supports retaining the experiments and the improved screening tools, with no runtime promotion.

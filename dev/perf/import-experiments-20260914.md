# Codex instructions: import optimization experiments

## Latest continuation: November 20, 2026

**No new runtime candidate is qualified for promotion.** This continuation completed two separate current-baseline browser studies: 832 imports in total, comprising 768 measured observations and 64 warmups. Counts are combined only for coverage; timings and controls remain separate. Resolved-reference validation and paired XXH32 checksums reduce isolated component costs but establish no repeatable complete-import gain. The native configuration snapshot likewise remains unqualified after its full four-cell diagnostic. The one favorable Firefox reverse comparison is retained together with its similarly negative same-source control.

The current baseline is `bde55dfbee1451edc32051f8bf51e8a870d5c72c`, including the already merged PRs #759, #766, #768 and #769. This continuation does not claim those upstream changes. Results, source reconstruction, controls, limitations and exact evidence are in the [validation/checksum section](#november-20-continuation-current-develop-validation-and-checksum-costs) and [native v2 results](#native-whole-browser-results-and-decision). The [compression source audit](#compression-follow-up-prepared-dictionary-reuse) separately rules out the proposed ordinary prepared-dictionary mechanism for its 28-block component corpus; it measures no speedup.

The earlier sections below preserve their historical source baselines, constraints and findings. Their timings are not a baseline for the November studies.

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

The standalone binary patches and per-file identities are in [candidates/source-manifest.json](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119/candidates/source-manifest.json). Each patch was applied to a fresh temporary index at the recorded base; all four resulting Git trees exactly matched the tested trees. Patches include changed tests and source-bound native artifacts. None is applied to this tooling branch's runtime.

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

[summary.json](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119/summary.json) and [summary.csv](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119/summary.csv) retain separate results for every cohort. Each A/B pair is one comparison; measured passes within a child are averaged, never treated as independent pairs. All slow tails remain. Descriptive 95% intervals use 10,000 paired bootstrap resamples with seed `20261119`; eight pairs on a shared host do not establish independent samples or qualification.

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

The final tooling commit is `18c990a857a589d0e3c7ae3f2d1b5040189286ae`, directly atop PR #757. All seven dry-build targets passed. A separate two-pair AB/BA JMdict smoke passed in all four observations: requested baseline/key roots and pinned WASM, production glossary validation, 526,942 rows, 19,446,728 lookup-index bytes, eight fused attempts and zero fallbacks/discarded rows. The complete digest was identical throughout. These smoke timings are excluded from the campaign. Exact commands, source hashes and outcomes are in [tooling-validation.json](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119/validation/tooling-validation.json).

The storage candidate also passed all seven dry-build targets. Its first full-unit attempt passed 614 test files and 13,654 tests, but two suites failed setup because this invocation omitted the pinned compiler environment. A first focused retry still could not find the versioned `wasm-ld-21` executable. Adding the extracted compiler's `usr/bin` and LLVM bin directories to `PATH` fixed resolution; both suites then passed all 20 tests without a repository change. Every failed attempt is retained. The final full-suite retry passed **616/616 test files: 13,674 tests passed and 47 skipped (13,721 total)**, exit 0, in 515.57 seconds, completed at 20:39:29 UTC. The measured source hashes remained unchanged. All commands, environment corrections, failures and final outcomes are in [validation-summary.json](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119/validation/validation-summary.json).

The published tooling code revision `18372138792a47b0839815cad9086af497d2410a` also passed [CI](https://github.com/ManabiIO/manabitan/actions/runs/44610162381), including JavaScript, all four TypeScript projects, unit/options tests, all-target build, the Chromium Anki matrix and full Chromium/Firefox extension tests. The exact check snapshot is [tooling-ci-1837213.json](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119/validation/tooling-ci-1837213.json). Subsequent receipt-only updates preserve the three validated tool hashes; their own CI status is separate. Those browser checks exercise the unchanged runtime in this tooling branch, not the unapplied candidate patches.

These checks qualify only their named source checkout; they do not retroactively establish browser, persistence or performance behavior for every candidate.

Concurrent [PR #758](https://github.com/ManabiIO/manabitan/pull/758), [PR #759](https://github.com/ManabiIO/manabitan/pull/759) and [PR #760](https://github.com/ManabiIO/manabitan/pull/760) cover related but different cache-copy, publication and escape-witness implementations. Their source trees, binaries and protocols differ. This round neither modifies those branches nor borrows their measurements or tests to qualify these patches.

A next performance decision requires a quiet supported browser host, same-source controls, reversed-order replication, complete file-input-to-UI import timing and exact persistence/reopen equality. Keep cancellation/recovery, process-tree memory, stored size and subsequent lookup latency as separate gates. Full browser performance, OPFS persistence/reopen equivalence, recovery and lookup-latency qualification for the runtime candidates were not completed here. The current evidence supports retaining the experiments and the improved screening tools, with no runtime promotion.

## November 19 continuation: complete browser imports

The follow-up moved qualification to Linux GitHub-hosted Chromium and official Mozilla Firefox. The first completed study is [PR #765](https://github.com/ManabiIO/manabitan/pull/765), [run 44633675935](https://github.com/ManabiIO/manabitan/actions/runs/44633675935), at tooling source `a4a2ee2b29fce97f6e22c65f7e4bb497bec342ee`, tree `046c4c8c9cb595f6e35d64336d2d6ee954b93bd2`. Later documentation/schema changes do not change the identity of these observations.

**Decision: retain both candidates as experiments; promote neither to the runtime.** The owned source-copy replacement has no repeatable whole-import benefit. Initial compressed-source prefetch has one favorable Firefox cell, an unresolved second Firefox cell, and slower complete imports in both Chromium cells. All four cells pass their source, execution and output checks, so these are performance findings rather than discarded correctness failures.

### Frozen sources and protocol

| Arm | Product source                             | Tree                                       | Change                                                                         |
| --- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------ |
| A   | `d829f5b6e6a75ee8859d38d537d224ec33c4930e` | `841406cd33f6871ab24aee771c1a7881d9e465f0` | Baseline                                                                       |
| C   | Same as A                                  | Same as A                                  | Independently packaged same-source control                                     |
| B   | `98b25cbce108b7c63ffe318f06186dadd26d476c` | `a885d2b04792ec33e53b5edfab492ca3128f33fd` | Two owned `Uint8Array.from(subarray)` copies become `new Uint8Array(subarray)` |
| D   | `2ae43ece52ab621fa1af763bf65635f1bedc0fad` | `7f19cf482e7472ae5e06f499b122b222a66bfe9d` | Begin the first admitted compressed-source read during bulk setup              |

B's historical source commit also contains manual-workflow changes; this study does not execute those workflows. Package verification permits only its two-line product change in `term-bank-source-pipeline.js`. D changes the importer and source pipeline, retains the existing byte budget and reads no additional source speculatively. Its archive plus larger compressed/decoded first-file charge is 18,813,552 bytes, within the unchanged minimum 24 MiB source budget. Deferred failures remain owned until consumption, and abort/join completes before archive close.

The committed [protocol](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/dev/perf/jmdict-browser-study/README.md), [manifest](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/dev/perf/jmdict-browser-study/manifest.json), source bundle and zero-context patches reconstruct the candidates. All product and generated package entries are checked; A and C have identical package-entry receipts even when ZIP container metadata gives their archives different hashes. The generated legal page is a shared, hash-checked overlay.

Each of four separate cells fixes two warmups per arm, then 24 four-arm blocks. Forward orders are `ABCD`, `BDAC`, `CADB`, `DCBA`, repeated six times; reverse cells reverse each order. Every observation uses a fresh browser/helper process and profile. Each cell completed **104 observations: 8 warmups plus 96 timed imports**. Across the study there are **416 successful observations, 384 timed**, with no retry, missing observation, dropped tail or post-hoc extension. Browsers, hosts and order replications are not pooled. C/A is a control, not a correction subtracted from candidate results.

The authoritative timer is the browser's monotonic interval from the file-input change to the current import operation's post-UI completion. Source hashing, package builds, fixture probes, process setup, persistence checks and untimed memory snapshots are outside that interval. No trace, profiler, screenshot or process-memory sampler runs within it. All arms retain production worker, cache, compression, batching and experiment defaults.

### Complete-import results

Negative percentages mean faster. Equal-work change compares the sums of the 24 candidate times with the corresponding 24 baseline times. The intervals are descriptive 10,000-resample paired-median bootstrap intervals, seed `20261119`; they do not correct temporal dependence or multiple comparisons. All raw tails remain, including Firefox reverse's largest same-source paired change of +46.97%.

| Browser / order    | Comparison      | Median paired change | Equal-work change | Faster pairs | Descriptive 95% interval |
| ------------------ | --------------- | -------------------: | ----------------: | -----------: | ------------------------ |
| Chromium / forward | C/A control     |               −1.10% |            −0.50% |        14/24 | −2.10% to +0.48%         |
| Chromium / forward | B/A source copy |               +0.69% |            +0.49% |        11/24 | −0.56% to +2.19%         |
| Chromium / forward | D/A prefetch    |               +1.28% |            +1.24% |         6/24 | +0.40% to +2.25%         |
| Chromium / reverse | C/A control     |               +0.70% |            +0.29% |         8/24 | −0.03% to +1.77%         |
| Chromium / reverse | B/A source copy |               −0.27% |            +0.18% |        14/24 | −1.68% to +1.73%         |
| Chromium / reverse | D/A prefetch    |               +2.26% |            +2.50% |         8/24 | −0.14% to +5.11%         |
| Firefox / forward  | C/A control     |               −0.49% |            +0.05% |        14/24 | −0.86% to +0.73%         |
| Firefox / forward  | B/A source copy |             +0.0004% |            +0.32% |        12/24 | −0.49% to +1.35%         |
| Firefox / forward  | D/A prefetch    |               −1.56% |            −1.67% |        19/24 | −2.41% to −0.86%         |
| Firefox / reverse  | C/A control     |               +1.01% |            +1.71% |        10/24 | −1.50% to +3.47%         |
| Firefox / reverse  | B/A source copy |               +1.57% |            +2.83% |         8/24 | −0.51% to +5.01%         |
| Firefox / reverse  | D/A prefetch    |               −0.21% |            −0.35% |        13/24 | −4.10% to +1.02%         |

Baseline A medians are 739.20 and 735.75 ms for Chromium forward/reverse, and 825.5 and 994.0 ms for Firefox forward/reverse. These are host-specific observations, not a comparison of browser efficiency or a speedup over the older 1,056.75 ms baseline. Chromium cells and Firefox forward used four-logical-CPU Intel Xeon 6975P-C hosts; Firefox reverse used a four-logical-CPU AMD EPYC 9V74 host.

Prefetch lowered Chromium's internal `sourceArchiveReadMs` medians from 50.80 to 40.25 ms and from 52.40 to 41.80 ms while complete imports became slower. Moving work across that phase boundary is not a whole-import saving. The favorable Firefox forward result does not override the reverse result or Chromium regressions.

The [machine-readable analysis](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119-round2/all-browser-analysis.json) retains every paired ratio, arm distribution, worst pair and runtime identity. Independent Chromium and Firefox artifact auditors checked every raw observation and recomputed the statistics. The separate [summary script](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/dev/perf/jmdict-browser-study-analyze.py) also reproduces all twelve comparisons. Its only numeric tolerance is floating-point summation rounding across Python versions.

### Runtime, correctness and memory interpretation

The Chromium runtime was Chrome for Testing `153.0.8010.12`. Both Firefox cells used the same official Mozilla Developer Edition `161.0b5`, build `20261118090429`, and geckodriver `0.37.1`, distributed from one verified bootstrap. Mozilla's official SHA512SUMS verifies the 91,913,948-byte archive; its SHA256 is `12d15a46911c71eccf78dd80a53ea7a8f32fa3c6160090bda0ba6571765f1cab`. Exact executable, `libxul`, geckodriver, host and package hashes are in preparation and command receipts. Node was `v22.22.0`.

Every import used the locked 526,942-row JMdict archive and native OPFS storage. Executed paths retain 53 source banks, 15,574,114 compressed/transferred bytes, 171,092,992 decoded bytes, three workers, twelve parser groups/native fused calls, zero discarded rows or native fallbacks, and successful publication without housekeeping errors. D alone records one initial prefetch with a 3,226,520-byte decoded estimate. Chromium checks twelve archive-derived term probes for bounds, persisted readability and sampled content previews, with matching probe digests across arms and restart. Firefox additionally compares twelve expression, reading and complete-glossary tuples against the source archive, plus storage samples, before and after reload. Neither browser digest is a complete persisted-dictionary byte oracle; the 526,942-row check is a row count.

Chromium repeats persisted probes after a complete browser restart. Firefox repeats them after a privileged extension reload from a neutral page and verifies that the background realm's `performance.timeOrigin` changed. **The Firefox check is an extension reload, not a whole-browser restart.** All 208 Firefox profiles are distinct; no import, cleanup or diagnostic error was suppressed. This official runtime/reload protocol succeeds where earlier patched-runtime attempts failed. Both runtime and reload-context handling changed, so the old failure's cause is not established.

Firefox reports no `navigator.deviceMemory`, selecting the production 48 MiB recent-source cache. Its 3,231 cache hits out of 4,010 exact checks are consistent across all arms. Chromium has 4,010 cache hits. The **96 MiB source-prefetch cap is a separate budget**. Firefox's `dedupRecentSourceCacheBytes = 100,724,405` counts cumulative copied bytes, not retained or peak memory. All arms report the same 38,928,384-byte maximum individual parser WASM heap; this is not simultaneous worker or process-tree memory. Untimed RSS snapshots do not establish import peak memory. Stored-size, process-tree memory and lookup-latency qualification remain separate gates for any eventual runtime promotion.

### Validation, retained failures and reproduction

D passed 155 focused tests, relevant lint and TypeScript projects, all seven dry-build targets and the full unit suite: 617 files, 13,694 passed, 47 skipped. All five WASM files remain byte-identical to baseline. The first study driver passed nine contract tests; the Firefox helper passed twenty focused tests. Main/dev/test/bench types, JS, unit/options tests, all-target build, full Chromium/Firefox extension tests and the Chromium Anki matrix passed at the measured tooling source. Those ordinary CI tests exercise the tooling branch's unchanged runtime, while the separate study exercises the bundled candidate sources.

Initial workflow run `44633439009` was rejected before any job or observation because a job-level environment expression referenced an unavailable `runner` context. The corrected workflow is the single complete study above. The measured tooling revision initially failed JSON registration and README hygiene checks; source `602b138474818a51b20a707a53456a4aff46c143` adds a concrete manifest schema, formatting and reference links. Its [CI run 44638388959](https://github.com/ManabiIO/manabitan/actions/runs/44638388959) passes all fifteen enabled jobs, and action, link, dependency and license checks pass. A report-only marker suppresses optional new performance cohorts while ordinary CI still runs. Historical run identities and failures remain in the evidence.

Local receipts also retain the initial wrong test TypeScript invocation, a nonmatching test-name filter that skipped every test, subsequent correct passing commands, and an ESLint declaration-format correction. The skipped invocation is not counted as a pass. Temporary ENOSPC was resolved by moving only the extracted compiler installation and preserving its path; no source or observations were removed.

[The evidence archive](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119-round2/browser-evidence.tar.xz) preserves every file payload from all four original GitHub artifacts, plus independent auditors, raw job logs, local validation, failure records and publication receipts. [Its receipt](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119-round2/browser-evidence.tar.xz.json) records original ZIP identities and the complete archive hash. An internal index hashes every member. ZIP container metadata is not reconstructed; the original payload bytes are preserved.

The original upload action omitted two hidden tooling copies: `.github/actions/setup/action.yml` and the study workflow under `.github/workflows/`. All 42 other declared tooling inputs are embedded, and top-level `workflow.yml` already contains the exact workflow bytes. [The coverage receipt](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119-round2/artifact-coverage.json) records this for all four ZIPs. [A separate source supplement](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119-round2/tooling-supplement/receipt.json) reconstructs the two omitted copies from the measured immutable Git commit, verifying both Git blob and SHA256 identities. It does not modify or pretend to be part of the original artifacts. Future evidence uploads explicitly include hidden files. The historical sources, observations and original archive hash remain unchanged.

Verify without extraction:

```sh
python3 dev/perf/import-study-evidence.py verify \
  builds/perf/20261119-round2/browser-evidence.tar.xz
```

To regenerate the separate result cells, extract into a new empty directory and point the analyzer at the four artifact roots:

```sh
mkdir -p builds/perf/review-browser-evidence
tar -xJf builds/perf/20261119-round2/browser-evidence.tar.xz \
  -C builds/perf/review-browser-evidence
python3 dev/perf/jmdict-browser-study-analyze.py \
  builds/perf/review-browser-evidence/chromium-forward \
  builds/perf/review-browser-evidence/chromium-reverse \
  builds/perf/review-browser-evidence/firefox-forward \
  builds/perf/review-browser-evidence/firefox-reverse \
  --output builds/perf/review-browser-analysis.json
```

For a fresh study, follow the committed protocol to reconstruct and freeze the exact sources and runtime. Keep the browser/order cells separate and use a new evidence directory; the driver refuses to append or overwrite an attempted cohort. A fresh run is a new replication, not a replacement for these results.

### Task-turn candidate and local validation

[PR #767](https://github.com/ManabiIO/manabitan/pull/767) separately tests cooperative task-turn overlap at product source `52a0108053837ff7a504c256606570e397ab93b0`, tree `92b35a642477e5a8161298e8c2e5d1881430508a`. It contains neither source-copy nor initial-prefetch changes. The first callback keeps its late turn; later callbacks start their owned turn before the unchanged sink and join both. A terminal fence preserves delivered cancellation before publication, including empty trailing groups and trailing parser errors. The witness resets at callback entry so a later failed sink cannot inherit a successful earlier overlap. Original sink/parser errors retain priority over turn failures.

This candidate passed 331 focused tests, seventeen new regression cases, five targeted mutation checks, lint, both required type projects, seven dry builds, unchanged WASM checks, and the full 617-file suite with 13,683 passed and 47 skipped. Its separate frozen browser protocol compares A/C baseline and B/D identical candidate, reporting C/A and D/B controls plus B/A and D/A separately. Whole-import completion, including the terminal fence, is authoritative. The complete browser study below does not qualify this candidate for runtime promotion.

### Task-turn Chromium results

The second study is [run 44640155099](https://github.com/ManabiIO/manabitan/actions/runs/44640155099), measured at tooling commit `999c08aded15c901e6862e04f7bd36922e3fd51f`, tree `5d65b96a2fdbb14023c6596341a7e6ace75f9942`. Its original manifest SHA256 is `cbe2f907c567ff3a44e5fc0c43d95757abcfeeecf3aa46e2a482e9dbb2424743`. A/C independently package the baseline; B/D independently package the same task-turn candidate. C/A and D/B are separate unchanged-source controls, and B/A and D/A share A within their block. No arms or cells are pooled and no control is subtracted.

Both Chromium cells completed all 104 observations, with no observed import, command or path failure. Forward used Intel Xeon 6975P-C; reverse used AMD EPYC 7763, each with four logical CPUs. Their baseline A medians are 764.90 and 1,031.10 ms; these hosts must remain separate. All 119 recorded command receipts per cell and every raw import report were independently audited, including exact source/package/fixture/runtime identities, both package controls, twelve native/borrowed chunks, three workers, zero fallback and sampled restart consistency.

| Chromium cell | Comparison              | Median paired change | Equal-work change | Faster pairs | Descriptive 95% interval |
| ------------- | ----------------------- | -------------------: | ----------------: | -----------: | ------------------------ |
| Forward       | C/A baseline control    |               +0.82% |            +0.81% |         9/24 | −0.38% to +2.60%         |
| Forward       | D/B candidate control   |               +1.72% |            +1.15% |         9/24 | −0.21% to +2.86%         |
| Forward       | B/A task-turn candidate |               +1.04% |            −0.13% |        11/24 | −2.06% to +2.73%         |
| Forward       | D/A task-turn candidate |               +0.77% |            +1.02% |        10/24 | −0.57% to +3.29%         |
| Reverse       | C/A baseline control    |               +0.67% |            +0.72% |         8/24 | −0.58% to +2.36%         |
| Reverse       | D/B candidate control   |               +0.21% |            +0.16% |        11/24 | −1.20% to +1.14%         |
| Reverse       | B/A task-turn candidate |               +0.62% |            −0.24% |        11/24 | −1.79% to +0.80%         |
| Reverse       | D/A task-turn candidate |               −0.18% |            −0.08% |        12/24 | −2.16% to +2.23%         |

**No repeatable Chromium whole-import gain is established.** Candidate-minus-baseline differences between arm medians for `importerChunkSinkMs` are −29.5/−25.5 ms in forward B/D and −26.5/−22.0 ms in reverse B/D. That counter surrounds the entire native `onChunk` callback, including its task-turn wait; the new terminal fence is outside it. The process-only `streamChunkWorkMs` boundary stays unchanged. These nested counter reductions are not equivalent whole-import savings. The separate phase summary retains all 192 measured observation identifiers and raw values; its SHA256 is `a95aa1799b9b3d3d8f40906a415169b491681bff78c10da451397602c6e8d562`.

The upload action omitted two hidden tooling copies from each Chromium artifact. Forty-one other declared harness inputs are embedded; top-level `workflow.yml` verifies the workflow duplicate. The exact two omitted files are separately reconstructed from the actual measured Git commit, with Git blob and SHA256 receipts. The initial audit attempt that discovered this is preserved. Original ZIPs and observations are untouched; future uploads include hidden files. This evidence-packaging correction does not change the comparisons.

### Task-turn Firefox results and final decision

Both Firefox cells also completed all 104 observations and passed independent raw-receipt audits. Both hosts exposed four logical CPUs on Intel Xeon 6975P-C in separate VMs, and all 208 profile paths are distinct. Baseline A medians are 829.0 ms forward and 783.0 ms reverse. The runtime remains the exact official Mozilla archive/executables recorded above. Every source, package, row-count, twelve-probe semantic check, storage sample and realm-changing reload check passed. As with Chromium, only the two hidden tooling paths were omitted from the original snapshots; the same explicitly separate source supplement verifies them. No observation or source artifact was replaced.

| Firefox cell | Comparison              | Median paired change | Equal-work change | Faster pairs | Descriptive 95% interval |
| ------------ | ----------------------- | -------------------: | ----------------: | -----------: | ------------------------ |
| Forward      | C/A baseline control    |               −1.15% |            −1.16% |        19/24 | −2.16% to −0.60%         |
| Forward      | D/B candidate control   |               +0.36% |            +0.07% |        10/24 | −0.60% to +1.12%         |
| Forward      | B/A task-turn candidate |               −1.20% |            −0.96% |        17/24 | −1.66% to −0.12%         |
| Forward      | D/A task-turn candidate |               −0.71% |            −0.89% |        14/24 | −1.71% to +0.24%         |
| Reverse      | C/A baseline control    |               +0.82% |            +1.22% |        10/24 | −0.52% to +2.55%         |
| Reverse      | D/B candidate control   |               −0.06% |            −0.24% |        12/24 | −1.02% to +0.78%         |
| Reverse      | B/A task-turn candidate |               +0.51% |            +0.74% |         9/24 | −0.77% to +1.69%         |
| Reverse      | D/A task-turn candidate |               −0.26% |            +0.50% |        13/24 | −0.75% to +0.77%         |

**Hold the task-turn candidate.** Its favorable Firefox-forward B/A result is accompanied by a similarly favorable unchanged-baseline C/A control. The reverse cell does not reproduce the candidate benefit, and neither Chromium cell establishes a gain. Controls are not subtracted to manufacture a corrected effect. The implementation remains an isolated, reconstructable experiment with its correctness tests; it is not applied to the runtime on either diagnostic branch.

The second study retains **416 successful observations, including 384 measured imports and 32 warmups**. Across both independent studies, **832 complete imports / 768 measured imports** are preserved; this is a count of work, not a pooled performance result. [The task-turn analysis](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119-yield-study/all-browser-analysis.json) retains all sixteen comparisons and can be reproduced with [the separate analyzer](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/dev/perf/jmdict-yield-study-analyze.py). Both browser audits and the independent summary agree with the original driver. These measurements qualify neither peak process memory nor exhaustive persisted-byte equality, and their effects on current `develop` remain untested.

### Task-turn evidence and validation

[The validation summary](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119-yield-study/validation-summary.json) separates the runtime candidate's local gates from the diagnostic branch and browser observations. The candidate's full suite passed 617 files / 13,683 tests, with 47 skipped; its 331 focused tests include seventeen new cases and overlap that full-suite count. Five targeted mutations failed their intended regression assertions, after which the exact source bytes were restored. Lint, main and required-test types, seven dry builds and all five unchanged-WASM checks passed. The study tooling passed ten Python contracts and 155 JSON schema tests. Original failed setup, formatting/link and artifact-coverage attempts remain with their corrected outcomes; none is a discarded import observation.

[The task-turn evidence archive](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119-yield-study/yield-evidence.tar.xz) contains every payload from all four original artifact ZIPs, complete job logs, independent audits, the explicitly separate measured-source supplement, source/fixture/runtime identities, local candidate and tooling validation, and the phase inventory. [Its receipt](https://github.com/ManabiIO/manabitan/blob/cf7efa0229562798f54cb0009a3ba85ee3b16369/builds/perf/20261119-yield-study/yield-evidence.tar.xz.json) and internal per-file index preserve the original ZIP identities and all member hashes. Verify and reproduce the sixteen separate comparisons:

```sh
python3 dev/perf/import-study-evidence.py verify \
  builds/perf/20261119-yield-study/yield-evidence.tar.xz
mkdir -p builds/perf/review-yield-evidence
tar -xJf builds/perf/20261119-yield-study/yield-evidence.tar.xz \
  -C builds/perf/review-yield-evidence
python3 dev/perf/jmdict-yield-study-analyze.py \
  builds/perf/review-yield-evidence/chromium-forward \
  builds/perf/review-yield-evidence/chromium-reverse \
  builds/perf/review-yield-evidence/firefox-forward \
  builds/perf/review-yield-evidence/firefox-reverse \
  --output builds/perf/review-yield-analysis.json
```

The summaries preserve original source identities even though report-only commits add documentation and archive fixes. Optional browser studies are not rerun for those commits; ordinary CI continues. No parser, worker, cache, compression, batching, storage-format or production experiment default is promoted by either diagnostic PR.

### Remaining opportunities on the frozen baseline

The next directions come from the first browser study's 24 measured baseline A observations in each cell, not from the older component screens. The reproducible inventory is retained in the task-turn evidence under `local/phase-inventory/`; it pins every source ZIP identity, selection and host identity. These are nested phase measurements and upper bounds, not predicted speedups.

The offline adapter reproduces the inventory byte-for-byte from the committed first evidence archive, without reopening or downloading any original ZIP. It directly verifies that tar and all 104 required payloads; original ZIP hashes remain historical identities in the verified index, not hashes of reconstructed ZIP containers. After extracting the task-turn evidence as above:

```sh
python3 builds/perf/review-yield-evidence/local/phase-inventory/extract-phase-inventory-offline.py \
  --evidence builds/perf/20261119-round2/browser-evidence.tar.xz \
  --evidence-receipt builds/perf/20261119-round2/browser-evidence.tar.xz.json \
  --output builds/perf/review-phase-inventory.json \
  --verification-output builds/perf/review-phase-inventory-verification.json
```

| Phase median, ms                        | Chromium forward | Chromium reverse | Firefox forward | Firefox reverse |
| --------------------------------------- | ---------------: | ---------------: | --------------: | --------------: |
| Canonical scan excluding exact matching |            54.85 |            53.70 |              51 |              53 |
| Exact content matching                  |            12.00 |            11.75 |           103.5 |             114 |
| Record validation                       |            19.75 |            20.30 |              27 |              31 |

A small implementation candidate is the synchronous run-validation loop in `TermRecordOpfsStore._encodeAndAppendArtifactChunkForState`. It separately resolves the same row's unique content index for offset and length. Selecting the resolved-reference shape once per synchronous run and loading that index once per row could remove repeated dispatch while retaining independent bounds checks, overflow/run splitting, fixed-span/fixed-length precedence and the generic fallback. Re-select after each awaited append; do not carry an unchecked reference snapshot across an await. The exact current [PR #764](https://github.com/ManabiIO/manabitan/pull/764) patch at `2ec02361cadea559648621306e7659b44b5ec2a7` changes the later field encoder, not this validation loop. However, validation already overlaps content compression. Its entire 19.75–31 ms phase is an upper bound, and current receipts cannot identify how much extends the final join.

The larger serialized stages need attribution before a new production edit. Dedup resolution completes before the current chunk starts content compression. Canonical scanning performs twelve native calls over 364,869 rows, with 16,741,613 copied input bytes and no fallback. Its timer also includes module setup, input staging, native table work and pending-column adoption; those subphases have no separate durations. The 32,080-byte copied-output counter covers exact descriptors and excludes six adopted owned columns. Copy volume alone therefore does not establish which operation consumes the 51–55 ms median stage.

Firefox's 779 successful exact matches outside its recent-source cache are another lead. They pass through reference reads, grouped compressed-block loads, checksum validation, synchronous decompression and equality checks. The implementation already groups requests by block and shares in-flight loads, so adding basic read batching would duplicate existing behavior. Measure those subphases separately before choosing an optimization. Do not enlarge the cache or remove checks to manufacture a gain. Firefox reverse's 107 ms finalization median includes an 89 ms close-writable median, versus 21/8 ms in Firefox forward; these remain host-specific observations, not evidence that durability work can be omitted.

### Upstream scope

Fresh GitHub reads at `2026-11-20T00:00:03Z` confirm that `develop` is now `e8a927ab5401c19e6119a95de6a8f53eb92302ec`. [PR #759](https://github.com/ManabiIO/manabitan/pull/759) merged batched metadata publication at `594f7fde31c6a69262115ccce733c17a3382b2c8`; [PR #766](https://github.com/ManabiIO/manabitan/pull/766) merged reduced shared-content cache copying at `e8a927ab5401c19e6119a95de6a8f53eb92302ec`. Those changes belong to parallel work and are not attributed to this study.

Both browser studies and the phase inventory retain their exact `d829` baseline. Neither study was rebased or restarted after observing results. Candidate effects and phase costs on the newer `develop` revision remain untested. Any subsequent runtime proposal must reconcile that source and repeat its required functional and performance qualification; these fixed-baseline observations cannot be transferred to the new revision.

## November 20 continuation: current-develop validation and checksum costs

**Decision: retain both candidates as experiments; promote neither runtime change.** All 416 planned browser imports completed and passed their declared correctness checks. Component and phase costs fell, but no candidate comparison established a repeatable complete-import gain.

This continuation starts from `bde55dfbee1451edc32051f8bf51e8a870d5c72c`, including the metadata-publication, shared-content-cache, key-escape-hint and adjacent-key-reuse changes merged in PRs #759, #766, #768 and #769. The earlier [source-copy/prefetch study](https://github.com/ManabiIO/manabitan/pull/765) and [task-turn study](https://github.com/ManabiIO/manabitan/pull/767) retained 832 imports and qualified no repeatable complete-import gain. Those observations remain separate; this round does not reuse their timings as a current baseline.

### Candidate plan and gates

- **Resolved-reference validation:** remove repeated descriptor dispatch and repeated row-to-unique-index loads inside each synchronous record-validation run. Preserve independent offset/length bounds, numeric validation, fixed-length precedence, run splitting, generic fallback and descriptor selection after each awaited append.
- **Compressed-block checksum:** screen a single-pass implementation of the existing two-seed XXH32 pair against independent vectors and production envelope reads. Keep checksums, stored bytes, ownership, cache capacities and compression settings unchanged. Reject implementations that regress realistic payloads before browser qualification.
- **Measurement:** freeze candidate source commits after component screening. Use two identical baseline arms plus either two independent candidates or a duplicate selected candidate; declare comparisons explicitly. Retain fresh browser profiles, 24 balanced four-arm blocks per browser/order cell, two excluded warmups per arm, and an independent reversed-order cell. Do not add, retry, pool or exclude observations after seeing results.
- **Decision:** require complete-import evidence before describing any component improvement as an import speedup. Recheck relevant correctness, memory/storage and normal-lookup behavior before a runtime promotion.

### Recovered inputs and environment

The locked JMdict archive is `JMdict.2026-09-06`, 526,942 rows, 15,587,032 archive bytes, SHA256 `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a`. Its compressed term-bank payload is separately 15,574,114 bytes. Dependency installation and library generation use the unchanged lockfile. Local checks use Node 24.22.3; browser jobs retain Node 22.22.0.

Clang and LLD 21.1.8 were extracted from seven SHA256-verified official LLVM Debian packages. `npm run build:dictionary-wasm -- --check` passed on the baseline: parser SHA256 `7021e66558ce7efe8162ea3030f2ebe2d63434d10171a7cffe45726f7ff9fb27`, canonical scanner SHA256 `40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af`.

### Frozen sources and component screen

| Browser arm | Source commit                              | Role                                                    |
| ----------- | ------------------------------------------ | ------------------------------------------------------- |
| A/C         | `bde55dfbee1451edc32051f8bf51e8a870d5c72c` | Baseline and independently packaged baseline control    |
| B           | `9b947eb6130020bdd2986787cb42df3a7eb72d73` | Resolve validation descriptors once per synchronous run |
| D           | `025596858e4e176d92c8f7f016057317c60c2793` | Compute both existing checksum seeds in one pass        |

The new browser [manifest](https://github.com/ManabiIO/manabitan/blob/86bdc139eee5fe1af07e42521cec1a7867b30571/dev/perf/jmdict-validation-study/manifest.json) was frozen before any browser observation, SHA256 `6b95afafe06e522bd05375541eaa765236e7df32c77a8f8808448789663c2b6a`. Its 7,729-byte source bundle has SHA256 `9c62046f2ea9823faf0f5e8391785cd35ed1fc8d739ddd03d3488f32b17f1aa8`. Comparisons are C/A, B/A and D/A; B/D are distinct candidates. The exact source trees, 46 archived harness inputs and 34 shared product inputs are pinned. The validation/checksum study branch does not apply either runtime change.

The component cohorts used separate quiet-host intervals, frozen sources, complete planned observations, and post-timing validation. Negative changes mean faster. Component arm letters below are local to their own protocol; the checksum screen uses B/D as two copies of its checksum candidate.

| Component comparison             | Median paired change | Faster blocks | Scope                                                                   |
| -------------------------------- | -------------------: | ------------: | ----------------------------------------------------------------------- |
| Record validation, candidate     |            -21.2485% |         24/24 | Validation phase, 24 ABBA blocks; wall change -20.0628%                 |
| Record validation, separate A/A  |             +0.2157% |          9/24 | Same baseline method; wall change +0.06585%                             |
| Real-block checksum, B/A         |            -46.9310% |         23/24 | Both existing hash seeds over 28 production-packed payloads             |
| Real-block checksum, D/A         |            -46.4916% |         24/24 | Second candidate arm in the same four-arm cohort                        |
| Production reader component, B/A |             -8.8621% |         21/24 | Memory-backed block storage, checksum, decompression and selected reads |
| Production reader component, D/A |             -6.4562% |         19/24 | Same component boundary                                                 |

The validation replay checks all 526,942 native-parser row descriptors and compares every emitted record/index byte outside timing. The byte digest is `8990393a6d8a90d3896a983718b2468c75ad77481ba91076d7f9c9d6018d93f1`. Its median validation cost falls from 8.6348 to 6.8052 ms per dictionary replay, about 1.8 ms. Timed encoding/appending are constant sinks, offsets are native canonical-content spans without cross-group persisted dedup, and seven-bank grouping follows the earlier component runner rather than the browser planner. Both candidate and separate A/A cohorts retain 104 observations (96 timed plus eight warmups), with 12 full-dictionary replays per observation. This is not a complete-import saving.

The checksum reader checks every byte of all 28 decoded blocks (100,671,677 bytes) against original parser content spans, 725 selected references, and five corrupted-envelope/frame cases. Its timed store is memory-backed; no OPFS file I/O or production cache-miss frequency is represented. Reader arm medians are A 91.4901, B 83.4416, C 86.4291 and D 84.2176 ms. C/A control changes are -1.0428% for hashing and -2.7780% for the reader; D/B candidate controls are -2.4248% and +0.0161%. All 208 observations across the two stages are retained. Do not subtract these controls or transfer the component percentage to browser imports. The initial helper-based fused prototype was 2.1–5.2 times slower on synthetic frames and was rejected before this candidate.

### Correctness and additional component coverage

The validation candidate passed 217 focused tests, including 21 new cases, scoped ESLint and main/test type checks. Its complete unit run passed 620 files and 13,797 tests, with 47 skips. The checksum candidate passed 353 focused tests across six files, including independent XXH32 vectors, unaligned/stable-shared views and native-envelope compatibility. Its complete unit run passed 620 files and 13,866 tests, with 47 skips. Both candidates passed all seven dry-build targets, and all five generated WASM hashes matched the baseline before and after validation. These runs had no failures, reruns or source edits.

The frozen study tooling passed 15 Python contracts, 20 Firefox helper tests, 152 JSON type tests, JSON/README formatting, scoped ESLint, dev/test types and plan verification. Pinned actionlint 1.7.12 passed locally. The initial missing-generated-library lint failure is retained with its normal build correction. The unchanged Firefox helper retains exact expected-content probes and reload checks; Chromium retains sampled previews and a full browser restart. Neither is a whole-dictionary persisted-byte oracle, and untimed RSS snapshots do not establish peak memory.

Six additional validation cohorts cover generic arrays, fixed-length records and contiguous fixed spans, each with its own candidate and A/A cohort. Every cohort retains 24 ABBA blocks, two warmup blocks, 12 full-dictionary replays per observation and its complete byte oracle. Generic arrays project the real native descriptors; the fixed formats use synthetic 32-byte layouts with real keys. Negative percentages mean faster.

| Validation shape         | Candidate validation / wall change | A/A validation / wall change |
| ------------------------ | ---------------------------------: | ---------------------------: |
| Generic arrays           |                  -15.65% / -13.36% |            -0.118% / -0.106% |
| Fixed length 32          |                    -5.67% / -5.23% |            -0.836% / +0.070% |
| Contiguous fixed span 32 |                    -1.87% / -1.32% |            +0.456% / -0.162% |

These tested Node shapes show no established regression. The contiguous-span wall medians, 5.5800 and 5.5878 ms, are effectively equal; the paired percentage is not an established gain. The generic-array byte digest matches the resolved-layout digest above. None of these cohorts establishes browser performance for every supported format.

The checksum short-input screen covers 31 cases: 27 boundary lengths from zero through 1,025 bytes and four size buckets of actual JMdict canonical entries. All 3,224 observations are retained: 2,976 measured and 248 warmups. Both candidate-arm median comparisons favor the candidate in all 31 cases. B/A medians range from -25.57% to -44.50%; the four actual-entry buckets are -38.39%, -37.00%, -37.18% and -41.91%. Same-source control medians range from -6.50% to +6.14% and are not subtracted. Independent libxxhash witnesses cover all 962 fixture payloads. This closes the observed small-input concern in local V8, not Firefox or complete imports.

### Canonical resolver attribution

A separate six-pair diagnostic uses current baseline modules and the earlier full-resolver virtual-storage harness. The first arm is uninstrumented; the second adds five sequential adapter timers without changing native C/WASM, ownership or await boundaries. Their elapsed differences describe instrumentation and host variation, not an optimization. Every planned observation, full descriptor/content oracle and before/after source identity passed. Each child verifies two warmups; the historical harness exports only the measured replay's timers.

Instrumented median costs per complete dictionary replay are 24.20 ms in the native call, 2.86 ms staging inputs, 9.47 ms adopting/copying outputs, 0.09 ms setting up the arena/instance and 0.07 ms awaiting the already compiled module. Native time is a median 56.1% of resolver time outside the owner's exact-matching timer, with a 52.7–64.0% range. The timers do not exhaustively partition bookkeeping or failure paths, and they include host scheduling.

This component uses eight groups of up to seven banks, 364,609 native scanned rows, 360,859 pending rows, 3,750 exact descriptors, 2,915 recent-source hits and 835 entries fetched through four batched virtual-storage calls, with no native fallback. It excludes actual OPFS, envelope checksums and decompression and differs from the browser's twelve-group plan. The attribution supports a separate immutable-config snapshot experiment: read config words once per synchronous native call while retaining every volatile header store and the journal barrier before authoritative mutation. It does not itself demonstrate a saving. The separate [native-config diagnostic, PR #771](https://github.com/ManabiIO/manabitan/pull/771), freezes candidate `19b13a550d9b7f2a53f37d74aa36b2ee9c3e7472`. Its full-resolver component comparisons remain inconclusive and overlap same-source controls. One already prepared browser protocol addresses the unresolved engine/complete-import question; it does not imply that the component gate passed.

### Whole-browser results and interpretation

[PR #770](https://github.com/ManabiIO/manabitan/pull/770) measured tooling commit `007f16306b9f8036a9930b653fbffca3c750068e`, tree `22ae6f01e31d5a83da431cb078ba7f474f6578e1`, in [workflow run 44720953991](https://github.com/ManabiIO/manabitan/actions/runs/44720953991). All four cells completed: 384 timed imports and 32 excluded warmups, 24 balanced four-arm blocks per cell. Every planned observation is retained. Each cell uses fresh browser profiles and independent processes; the clock runs from file-input change through the current operation's completion.

The [recomputed analysis](https://github.com/ManabiIO/manabitan/blob/86bdc139eee5fe1af07e42521cec1a7867b30571/builds/perf/20261120-validation-study/all-browser-analysis.json) keeps browsers and order replications separate. Negative changes mean faster; arm medians and median paired changes are different statistics. Intervals are descriptive paired bootstrap intervals, not corrections for time dependence or multiple comparisons. Same-source controls are reported without subtraction.

| Browser / order    | Comparison | Median paired change | Equal-work change | Faster pairs | Descriptive 95% interval |
| ------------------ | ---------- | -------------------: | ----------------: | -----------: | ------------------------ |
| chromium / forward | C/A        |               +0.15% |            +0.70% |        12/24 | [-0.56%, +3.03%]         |
| chromium / forward | B/A        |               +1.85% |            +0.76% |         9/24 | [-1.24%, +2.85%]         |
| chromium / forward | D/A        |               +1.44% |            +1.19% |         8/24 | [-0.34%, +3.16%]         |
| chromium / reverse | C/A        |               -0.10% |            +0.13% |        12/24 | [-1.06%, +1.62%]         |
| chromium / reverse | B/A        |               -0.19% |            +0.48% |        14/24 | [-1.36%, +1.64%]         |
| chromium / reverse | D/A        |               +0.09% |            +1.00% |        11/24 | [-1.46%, +3.10%]         |
| firefox / forward  | C/A        |               +0.60% |            +0.29% |        11/24 | [-0.84%, +1.33%]         |
| firefox / forward  | B/A        |               -0.12% |            +0.17% |        12/24 | [-1.10%, +1.35%]         |
| firefox / forward  | D/A        |               -1.55% |            -1.17% |        14/24 | [-2.96%, +0.54%]         |
| firefox / reverse  | C/A        |               -0.62% |            +0.00% |        13/24 | [-1.10%, +1.37%]         |
| firefox / reverse  | B/A        |               -0.93% |            -0.77% |        14/24 | [-1.69%, +0.37%]         |
| firefox / reverse  | D/A        |               -0.37% |            -0.40% |        14/24 | [-1.20%, +0.85%]         |

Validation phase medians fall from 21.85 to 19.40 ms in Chromium forward, 29.00 to 23.90 ms in Chromium reverse, and 28 to 18 ms in both Firefox orders. The checksum candidate reduces the nested Firefox exact-compare median from 102 to 88.5 ms forward and 102.5 to 89 ms reverse. These phase changes are not additive complete-import savings.

Chromium reports 4,010 exact checks and 4,010 recent-source hits in every arm: no uncached exact-match read is observed. Firefox reports the same 4,010 exact checks but 3,231 recent-source hits, leaving 779 checks outside that cache. Hash-helper invocation count itself is not instrumented; zero envelope timers cannot establish whether reader checksums executed. The browser cache policies remain unchanged.

All 476 preparation/observation command receipts succeeded. Independent audits verify 2,688 original artifact payloads, every declared embedded harness input, source/package differences, runtime identities, fixture rows/bytes, effective flags, native path, zero fallbacks, and publication counters. Chromium uses Chrome for Testing 153.0.8010.12. Firefox uses the official Mozilla 161.0b5 release, application version 161.0, build 20261118090429, with geckodriver 0.37.1.

Chromium verifies twelve source-derived expression probes for readability, bounds, previews and unchanged sample digests after a full browser restart; it does not compare archive-derived readings/full glossaries. Firefox verifies twelve exact archive-derived expression/reading/full-glossary tuples before and after a realm-changing extension reload. That reload is not a browser-process restart. Neither browser path verifies every persisted dictionary byte. These limits remain distinct from the exhaustive component byte oracles.

The measured tooling head passed ordinary [CI run 44721076016](https://github.com/ManabiIO/manabitan/actions/runs/44721076016), including unit/type/lint/build checks, Chromium and Firefox E2E, restart/interruption recovery, the Anki matrix and CodeQL. Browser process-tree peak memory, exhaustive persisted-storage parity and dedicated normal-lookup performance remain unqualified. Since the complete-import gate did not pass, this study does not promote either candidate or spend further qualification runs on those remaining gates.

### Retained evidence and reproduction

The commands in this subsection use the PR #770 checkout at `86bdc139eee5fe1af07e42521cec1a7867b30571`; the links point to that immutable snapshot. Native-study reproduction is recorded separately below.

The [validation evidence archive](https://github.com/ManabiIO/manabitan/blob/86bdc139eee5fe1af07e42521cec1a7867b30571/builds/perf/20261120-validation-study/validation-evidence.tar.xz), its [hash-bearing receipt](https://github.com/ManabiIO/manabitan/blob/86bdc139eee5fe1af07e42521cec1a7867b30571/builds/perf/20261120-validation-study/validation-evidence.tar.xz.json) and [coverage index](https://github.com/ManabiIO/manabitan/blob/86bdc139eee5fe1af07e42521cec1a7867b30571/builds/perf/20261120-validation-study/artifact-coverage.json) retain every original browser ZIP file payload, complete job logs, independent auditors, all component cohorts and failed prototypes, exact source inputs, validation logs and toolchain receipts. The ZIP containers are identified by their original SHA256 values; their file payloads are preserved byte-for-byte. Historical studies remain separately linked to immutable commits.

The archive is 2,937,000 bytes, SHA256 `e3daca84f120a35a6a60df127be88dd2a4ce754b8142b8ce5538f73a8a579496`. It contains 2,838 payload files totaling 94,864,669 uncompressed bytes, including all 2,688 original browser payloads. Independent coverage found no missing, extra or changed original payload. No private transfer credentials were found in the selected receipts/logs, and no evidence redactions were needed.

The reproducible 19,548,576-byte checksum store image is excluded from Git. The exact generator, complete fixture manifest and verified relocation adapter are retained. Regeneration produces store SHA256 `4cee541ed8c6869e9ad8ec4c400f9fb61fcbf00f6e995a0a5df6d274fcd586f0` and manifest SHA256 `4629920d51385465dfa1d5afd3230c88d0bc3a7d3ccf23d5e0379d1b1425ab39`. The adapter changes only historical source/archive literals in a new generator copy, checks the exact baseline and WASM inputs, and verifies all regenerated manifest fields; the measured generator remains unchanged. No runtime archive or generated store image must be downloaded to inspect the recorded results.

```sh
python3 dev/perf/import-study-evidence.py verify \
  builds/perf/20261120-validation-study/validation-evidence.tar.xz
mkdir -p builds/perf/review-validation-evidence
tar -xJf builds/perf/20261120-validation-study/validation-evidence.tar.xz \
  -C builds/perf/review-validation-evidence
```

Use the exact source commits/bundle in `dev/perf/jmdict-validation-study/` for candidate reconstruction. The preserved pack recipe records all archive mappings and exclusions. Browser observations were not rerun during report assembly. A first analysis invocation assumed the Firefox auditors had extracted their ZIPs; they had audited the ZIPs directly. The failed path lookup occurred before analysis output, was retained, and was corrected by extraction into a separate analysis directory without changing any original artifact.

## 2026-11-20 native configuration diagnostic

A separate unqualified diagnostic is prepared in
`dev/perf/jmdict-native-config-study/README.md` on branch
`perf/jmdict-native-config-study-20261120-f34c9c9`. It compares baseline
`bde55dfbee1451edc32051f8bf51e8a870d5c72c` in A/C against native configuration
snapshot candidate `19b13a550d9b7f2a53f37d74aa36b2ee9c3e7472` in B/D.
C/A and D/B remain separate same-source controls; B/A and D/A remain separate
candidate comparisons.

The fixed native component screen was inconclusive: apparent candidate changes
(-6.07% and -4.53%) overlap unchanged-source movement (-5.11% and +1.15%), and
both candidate descriptive intervals cross zero. All 104 output/work/identity
oracles passed. This is not a passed performance gate. Eleven eliminated repeated
hot-loop configuration loads and 166 focused passing tests motivate one fixed
browser-engine/whole-import diagnostic; no component regression was established.
The source, timing boundary and sample plan were not adapted to that result.

The separate browser protocol fixes four Linux browser/order cells, each with
24 blocks, 96 measured observations and eight retained warmups. It reuses the
exact current Chromium binary and official Firefox artifact from PR770. Every
attempt, failure and tail is retained, without retries, pooling or extensions.
The initial protocol mistakenly declared only the packaged canonical scanner
WASM difference. Normal packages also include the changed C source; the v1
preparation guard rejected this omission before imports. The parser module, build
recipes and product policies remain unchanged. The source bundle and full patch
preserve the C, generated manifest/WASM and direct ABI tests. Version 1 produced no browser timing outcomes. Version 2 below preserves the
source and schedule while correcting the package declaration.

## 2026-11-20 native configuration diagnostic v2

The v1 browser attempt at tooling `5e2dea241ac11ef7b75c407c2ee1c878e1fd4091`
([run 44727365554](https://github.com/ManabiIO/manabitan/actions/runs/44727365554))
failed preparation in every cell before any warmup or import. The ordinary
packages contain both native C source and compiled WASM; v1's package map omitted
the changed C entry. Its artifacts, original ZIPs, logs and independent failure
audits are retained. No performance observations or browser correctness probes
were produced by v1.

A separately frozen v2 protocol lives in
`dev/perf/jmdict-native-config-study-v2/README.md`, with its own manifest,
workflow, evidence namespace and analysis entry point. It permits exactly
`js/dictionary/wasm/term-content-canonical-scan-v1.c` and
`lib/term-content-canonical-scan-v1.wasm` to differ. The full 538-entry A/B maps
retained from v1 are a regression fixture: they reproduce the original rejection,
accept the corrected declaration, and reject unrelated added, removed or changed
entries. Both same-source controls must retain complete entry equality.

The candidate remains `19b13a550d9b7f2a53f37d74aa36b2ee9c3e7472`, with the same
four tracked source changes and baseline `bde55dfbee1451edc32051f8bf51e8a870d5c72c`.
All four cells, 24 blocks, two warmups per arm, runtime identities, external timing
and failure policies are unchanged. The component result remains inconclusive;
v2 is an unqualified diagnostic, not a passed performance gate. The correction
contains no source or performance tuning, retries or appended samples. The v1
files remain unchanged, and only the new v2 workflow paths trigger this attempt.

### Native candidate and functional qualification

The candidate snapshots call-invariant configuration words into named scalar locals after the existing validation. Configuration lies below the 8 MiB prefix, while validated authoritative writes lie above it. The module has nonshared memory and no reentrant imports. The patch preserves the volatile header publications, journal stores, insertion memory barrier, error precedence, trap state, rollback and continuation boundaries. Static assembly changes eleven repeated row-loop configuration loads to zero; the seven header-load and six header-store occurrences retain their order. This structural change does not establish runtime performance.

The generated canonical scanner grows from 1,624 to 1,709 bytes, SHA256 `3bfd2ea83fdd8f3397cc5eafa1d4e5fa6f20afa1e4f3251fce4a858b030e959c`. The candidate tree is `c8f0aace6e3b11355220f22dfff8e668df97673b`. Its four tracked changes are the C source, generated WASM, generated manifest and direct ABI tests. Normal extension packages contain the changed C source and WASM; the separately preserved packaging erratum corrects the original native notes without rewriting their frozen receipts.

All twelve new direct ABI cases first passed against the baseline and then the candidate. They cover trap-visible journal/header state, late row/identity/source errors, non-reserving scans, invalid configuration, invalid table indices, capacity failure, resolved/pending counts and exact-descriptor continuation. The candidate passed 166 focused tests across five files, the complete 620-file unit suite with 13,788 passing tests and 47 skips, main/test type checks, scoped lint, all seven dry-build targets and the pinned LLVM rebuild check. Source and generated artifact identities matched before and after validation. The full unit run took 471.64 seconds; it is functional validation, not a performance observation.

The local full-resolver component retains 104 fresh-database observations in one process: eight warmups and 96 measured observations in 24 balanced four-arm blocks. Two fixture preparations occur outside timing. A/C use the baseline; B/D independently instantiate the same candidate. Every output/work oracle and source identity passed. The virtual store excludes OPFS, envelope checksums and decompression, and its eight groups of up to seven banks differ from the browser planner.

| Component comparison  | Median paired change | Equal-work change | Faster pairs | Descriptive 95% interval |
| --------------------- | -------------------: | ----------------: | -----------: | ------------------------ |
| C/A baseline control  |               -5.11% |            +1.74% |        12/24 | [-16.36%, +20.90%]       |
| D/B candidate control |               +1.15% |            +4.78% |        11/24 | [-7.43%, +12.71%]        |
| B/A candidate         |               -6.07% |            -6.81% |        13/24 | [-16.79%, +7.07%]        |
| D/A candidate         |               -4.53% |            -2.36% |        13/24 | [-24.79%, +20.04%]       |

Resolver arm medians are 54.9446, 51.3234, 53.5288 and 52.6647 ms for A/B/C/D. Both candidate intervals cross zero and overlap unchanged-source variation. No component benefit or regression is established. The separately frozen browser diagnostic addresses engine and whole-import behavior; it does not relabel this inconclusive component screen as a passed gate.

### Frozen native browser inputs

Version 2 measures tooling commit `72b8ab5471fc68e369a54d884efbbea933699d7c`, tree `e50ac7c7f7cf892a0e8dc666f5176f97e8800455`, in [workflow run 44729808376](https://github.com/ManabiIO/manabitan/actions/runs/44729808376). Its [manifest](./jmdict-native-config-study-v2/manifest.json), SHA256 `66062489217d31a117ee7892c4f51190ccb51b837886f2c1cdaef857e6b2afa7`, pins 54 harness inputs and 34 shared product inputs. The 5,421-byte candidate bundle is unchanged from v1, SHA256 `537eaf50c8a3400bf01cac3cd3e1de8496dc9356fc2657f2ab85ced2b262f5d5`.

Each browser/order cell uses two baseline arms A/C and two copies B/D of candidate `19b13a550d9b7f2a53f37d74aa36b2ee9c3e7472`. C/A and D/B are same-source controls; B/A and D/A are candidate comparisons. The protocol keeps 24 balanced four-arm blocks and two excluded warmups per arm, fresh browser profiles and independent processes. The external clock spans file-input change through the current operation's completion. Browsers, order replications and attempts are not pooled, controls are not subtracted, and no tail is removed.

Chromium remains Chrome for Testing 153.0.8010.12, binary SHA256 `8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e`. Firefox remains the official Mozilla 161.0b5 release, application version 161.0, build 20261118090429, with geckodriver 0.37.1. Its original runtime receipt bytes are pinned by SHA256 `42ada420f9c7ab4e395a7de94c8a9ec5d435b0e359a5efb4af7fffbac7f2b826`; the successful reuse/install checks preserve the source artifact identity. The 94,953,342-byte original runtime artifact was not downloaded locally.

V2 tooling passed 23 Python contracts, 158 JSON type tests, scoped lint, dev/test types, formatting, pinned actionlint 1.7.12, plan verification and the full 538-entry package-map preflight with six malformed-map negative controls. Independent reviews verified the source bundle, exact package changes, frozen inputs and isolated workflow trigger. Its measured source passed ordinary [CI run 44729816571](https://github.com/ManabiIO/manabitan/actions/runs/44729816571), including unit/type/lint/build checks, Chromium and Firefox E2E, restart/interruption recovery, the Anki matrix and CodeQL.

### Native whole-browser results and decision

**Decision: retain the native candidate as an experiment; do not promote it.** All four version-2 cells completed successfully, retaining 416 imports: 384 measured observations and 32 excluded warmups. Each cell contains 24 balanced four-arm blocks. The [recomputed analysis](../../builds/perf/20261120-native-config-study-v2/all-browser-analysis.json) matches every statistic emitted by the frozen driver; all original observations, failures and tails remain in the evidence. There were no observation failures or added measurements.

Negative changes mean faster. C/A and D/B are separate same-source controls. B/A and D/A compare two copies of the same candidate with A. The intervals are descriptive paired bootstrap intervals; they do not correct time dependence or multiple comparisons. These comparisons share observations and are not independent hypothesis tests.

| Browser / order    | Comparison | Median paired change | Equal-work change | Faster pairs | Descriptive 95% interval |
| ------------------ | ---------- | -------------------: | ----------------: | -----------: | ------------------------ |
| chromium / forward | C/A        |               +0.85% |            +0.66% |        10/24 | [-0.53%, +1.77%]         |
| chromium / forward | D/B        |               +0.51% |            +0.66% |         9/24 | [-0.34%, +1.40%]         |
| chromium / forward | B/A        |               -0.29% |            +0.28% |        13/24 | [-1.73%, +2.32%]         |
| chromium / forward | D/A        |               +0.59% |            +0.94% |        10/24 | [-0.76%, +2.46%]         |
| chromium / reverse | C/A        |               -0.53% |            -0.42% |        14/24 | [-1.94%, +1.37%]         |
| chromium / reverse | D/B        |               -1.54% |            -0.85% |        15/24 | [-2.38%, +1.42%]         |
| chromium / reverse | B/A        |               -0.11% |            -0.03% |        12/24 | [-1.58%, +1.81%]         |
| chromium / reverse | D/A        |               -0.60% |            -0.87% |        15/24 | [-1.56%, +0.09%]         |
| firefox / forward  | C/A        |               +0.54% |            +0.36% |        11/24 | [-0.62%, +1.54%]         |
| firefox / forward  | D/B        |               -0.36% |            -0.48% |        14/24 | [-2.07%, +0.99%]         |
| firefox / forward  | B/A        |               -0.31% |            -0.04% |        14/24 | [-1.06%, +0.63%]         |
| firefox / forward  | D/A        |               -0.58% |            -0.52% |        16/24 | [-1.81%, +0.31%]         |
| firefox / reverse  | C/A        |               +0.50% |            +0.05% |        11/24 | [-1.40%, +1.30%]         |
| firefox / reverse  | D/B        |               -1.06% |            -0.62% |        17/24 | [-1.41%, -0.13%]         |
| firefox / reverse  | B/A        |               -0.76% |            -0.46% |        15/24 | [-1.67%, +0.50%]         |
| firefox / reverse  | D/A        |               -0.94% |            -1.08% |        17/24 | [-1.91%, -0.26%]         |

Seven of the eight candidate intervals cross zero. The exception is Firefox reverse D/A at -0.9422%, with interval [-1.9070%, -0.2597%]. The same cell also has a negative D/B same-source control, -1.0598% [-1.4135%, -0.1267%], while B/A remains inconclusive and both forward candidate intervals cross zero. Preserve the favorable D/A result, but it does not establish a repeatable source effect across the duplicate candidate arms and order replication. No control correction is subtracted.

| Browser / order    |   A median |   B median |   C median |   D median |
| ------------------ | ---------: | ---------: | ---------: | ---------: |
| chromium / forward | 1000.15 ms | 1002.80 ms | 1004.55 ms | 1008.70 ms |
| chromium / reverse |  760.55 ms |  759.70 ms |  753.75 ms |  751.10 ms |
| firefox / forward  | 1118.50 ms | 1115.50 ms | 1125.50 ms | 1115.00 ms |
| firefox / reverse  |  805.00 ms |  805.50 ms |  809.00 ms |  800.00 ms |

Both forward cells ran on AMD EPYC 7763 hosts; both reverse cells ran on Intel Xeon 6975P-C hosts. The different absolute times are not attributed to order or candidate source. Within-cell paired comparisons are retained separately, with every minimum, p95, maximum, paired change and worst pair available in the audits. No timing is pooled across hosts, browsers or order cells.

| Canonical phase median |        A |        B |        C |        D |
| ---------------------- | -------: | -------: | -------: | -------: |
| Chromium forward       | 73.00 ms | 72.85 ms | 73.95 ms | 74.55 ms |
| Chromium reverse       | 62.70 ms | 61.60 ms | 62.80 ms | 62.20 ms |
| Firefox forward        | 63.00 ms | 63.50 ms | 63.00 ms | 61.00 ms |
| Firefox reverse        | 50.00 ms | 50.00 ms | 50.50 ms | 48.00 ms |

`dedupCanonicalScanMs` includes adapter and surrounding work after subtracting accumulated exact-comparison time; it is not an isolated native-kernel timer. These phase medians do not demonstrate a consistent native saving. The enclosing dedup and publication timers remain nested. In particular, `contentMetadataIndexPublishMs` includes `_cacheRecentPublishedTermContentSources`; adding its recent-source-cache timer again would double-count that work.

All 476 setup/observation command receipts passed. Independent audits verify every archived harness/shared input, source and package identity, full 538-entry package map, exact runtime, archive/source bytes, effective flags, executed work and clean publication. A/C package entries are equal and B/D entries are equal, with exactly the two declared C/WASM differences. Chromium retains dirty build-provenance markers for the common legal-page output and harness/dependency overlays; no clean-checkout claim replaces those recorded identities.

Every observation imports all 526,942 rows, executes twelve native calls scanning 364,869 rows, produces 360,859 bulk-pending entries and reports zero native fallbacks or snapshot bytes. Native input/output copy counters are 16,741,613 and 32,080 bytes. The candidate path therefore executed; the small/unresolved timing differences are not explained by a disabled optimization. Chromium reports 4,010 recent-source hits for 4,010 exact checks; Firefox reports 3,231 hits and 779 checks outside that cache. Worker counts, cache policies, source admission, batching, compression and durability remain unchanged.

Chromium verifies twelve source-derived terms for bounds, readability and previews through a full browser restart. Firefox verifies twelve exact archive-derived expression/reading/full-glossary tuples through a changed extension realm; its reload does not restart the browser process. Firefox retains 104 distinct profiles per cell, zero command/diagnostic errors and one invariant work/environment/flags/finalization record in each cell. Neither sampled persistence path is an exhaustive stored-byte oracle. The 38,928,384-byte reported parser heap and untimed RSS observations are not browser peak memory.

The complete-import qualification gate remains unresolved. Process-tree peak memory, exhaustive persisted-storage parity and dedicated normal-lookup performance were not separately qualified for this candidate. The study branch retains the product runtime from baseline `bde55dfbee1451edc32051f8bf51e8a870d5c72c`; the candidate is preserved in its exact source bundle and patch for review.

### Compression follow-up: prepared dictionary reuse

A separate read-only audit of the exact pinned Zstd source, `82d322c4973d9e2968d94047a40892bc6d9a9bdf`, rules out an ordinary `createCDict(-1)` / `compress_usingCDict` substitution as a way to remove native dictionary preparation for the frozen real-block corpus. No compression, build, byte-parity experiment or timing cohort was run for this audit.

The existing 16,384-byte JMdict dictionary and known one-shot source lengths make the prepared-state reuse conditions false for every one of the 28 decoded blocks. Their lengths are 638,051–4,194,300 bytes; ordinary reuse requires source length strictly below 131,072 bytes or below six dictionary lengths (98,304 bytes), an unknown source length, or advanced creation with stored level zero. Ordinary creation stores level −1. All 28 therefore reach the native reset-and-insert path again. This classification uses the unchanged seven-bank component fixture; it is not an inventory of the browser's twelve-group block plan. See the [pinned begin routine](https://github.com/facebook/zstd/blob/82d322c4973d9e2968d94047a40892bc6d9a9bdf/lib/compress/zstd_compress.c#L5256-L5305).

Advanced creation can select reuse for large inputs, but its full/tagged dictionary table construction differs from the current fast CCtx initialization, and parameter selection depends on source-size mode. Matching compression levels or successful decompression does not establish identical compressed bytes. A future candidate would need to preserve the current initial search state, ownership, failure ordering and per-realm lifetime, then pass a complete byte oracle and memory qualification. The recorded Emscripten build path also differs from the pinned LLVM dictionary-scanner toolchain. See [CDict initialization](https://github.com/facebook/zstd/blob/82d322c4973d9e2968d94047a40892bc6d9a9bdf/lib/compress/zstd_compress.c#L5600-L5621) and [the two fast-strategy table fillers](https://github.com/facebook/zstd/blob/82d322c4973d9e2968d94047a40892bc6d9a9bdf/lib/compress/zstd_fast.c#L15-L96).

The audit receipt binds eleven baseline files, seven exact upstream files, the dictionary, the unchanged fixture manifest and all 28 strict threshold evaluations. The final evidence preserves the inspected upstream source with license notices and an offline classification reproducer. This rules out the proposed ordinary-CDict mechanism for this corpus; it supplies no estimate of native setup cost or whole-import savings.

### Native evidence and reproduction

The [complete native v2 archive](../../builds/perf/20261120-native-config-study-v2/native-evidence.tar.xz) is 3,117,032 bytes, SHA256 `1f9c3822d610c96c83b9d1e3136e6e859db1f491a89efeb3c368bef7cbeabafe`. It preserves 2,858 payload files totaling 96,599,492 uncompressed bytes: all 2,724 original browser ZIP payloads and 134 supplemental files. The [coverage index](../../builds/perf/20261120-native-config-study-v2/artifact-coverage.json), [packing receipt](../../builds/perf/20261120-native-config-study-v2/packing-receipt.json) and [independent actual-byte review](../../builds/perf/20261120-native-config-study-v2/independent-packing-review.json) verify exact member sets with no missing, extra or changed payloads. All selected source names and bytes remained unchanged after packing and review. Credential-pattern review found no private transfer credentials; no evidence was redacted.

The archive contains the original browser observations and complete job logs, independent auditors and probe derivations, all native component observations and functional-validation logs, the original native notes and explicit packaging erratum, frozen tooling/preflight/CI receipts, exact source bundles/patches, toolchain pins, and the compression source audit with upstream notices and offline reproducer. Original ZIP containers are excluded while their hashes, byte counts, CRCs and every file payload remain preserved. Large dependencies, runtime archives and the locked JMdict archive are identified by their exact pins and observed verification receipts rather than duplicated.

| Cell             | Original artifact | ZIP bytes | Preserved file payloads |
| ---------------- | ----------------: | --------: | ----------------------: |
| Chromium forward |       14627490223 | 3,989,429 |                     732 |
| Chromium reverse |       14626318108 | 3,979,720 |                     732 |
| Firefox forward  |       14627208758 | 2,402,097 |                     630 |
| Firefox reverse  |       14627972249 | 2,398,251 |                     630 |

Version 1 stays in its [separate failed-preparation archive](../../builds/perf/20261120-native-config-study/failed-v1-evidence.tar.xz): 428,276 bytes, SHA256 `955c27d3037370dfb8e8ee27252467a5dcc4ec31105dc4dab299c84f74c5749f`. It retains 450 payload files / 10,026,376 bytes, including every one of the 416 original preparation payloads. Its [coverage receipt](../../builds/perf/20261120-native-config-study/failed-v1-artifact-coverage.json) records zero attempted imports. The successful runtime reuse/install checks are preserved, but preparation failed before runtime receipt copies were placed in the Firefox result archives; no v1 executed-path or persistence proof is claimed.

Root analysis and native-v2 packing each succeeded on their first execution. The analysis receipt retains the exact command, input cohort hashes and unchanged-input check. The independent packing review compared actual extracted tar bytes against all original ZIP members and selected supplemental files, rather than relying only on the packer's index. These post-measurement operations did not rerun imports or modify any measured source.

From this PR #771 checkout, verify and recompute the retained study:

```sh
python3 dev/perf/import-study-evidence.py verify \
  builds/perf/20261120-native-config-study-v2/native-evidence.tar.xz
python3 dev/perf/import-study-evidence.py verify \
  builds/perf/20261120-native-config-study/failed-v1-evidence.tar.xz
native_v2_evidence="$(mktemp -d)"
tar -xJf builds/perf/20261120-native-config-study-v2/native-evidence.tar.xz \
  -C "$native_v2_evidence"
python3 dev/perf/jmdict-native-config-study-v2-analyze.py \
  "$native_v2_evidence/chromium-forward" \
  "$native_v2_evidence/chromium-reverse" \
  "$native_v2_evidence/firefox-forward" \
  "$native_v2_evidence/firefox-reverse" \
  --output "$native_v2_evidence/recomputed-native-analysis.json"
python3 "$native_v2_evidence/compression-source-snapshot/offline-threshold-reproduction.py" \
  --output "$native_v2_evidence/recomputed-compression-classification.json"
```

The analyzer requires a new output path and preserves each cell separately. Relocated analysis paths differ from the original receipt; compare the cohort hashes and per-cell statistics, not the whole JSON file hash. The compression reproducer needs no compiler, Git checkout, network access or Zstd execution and checks all 28 classifications against the retained original audit.

The exact candidate can be reconstructed without applying it to the study branch:

```sh
git bundle verify dev/perf/jmdict-native-config-study-v2/candidates.bundle
git fetch ./dev/perf/jmdict-native-config-study-v2/candidates.bundle \
  refs/heads/study-source/native-config-20261120-f34c9c9
git worktree add --detach ../manabitan-native-config-reproduction \
  19b13a550d9b7f2a53f37d74aa36b2ee9c3e7472
```

Use an unused worktree destination. The bundle requires baseline `bde55dfbee1451edc32051f8bf51e8a870d5c72c`, already reachable from this study branch. The complete readable binary patch is also retained in `dev/perf/jmdict-native-config-study-v2/native-config.patch`. New runtime or protocol work must use its own declared source and cohort; these observations remain bound to their measured tooling head.

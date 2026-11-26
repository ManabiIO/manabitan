# Codex instructions: import optimization experiments

## November 26, 2026: redundant import index setup

The `perf/import-index-setup-20261126-513d` candidate starts from `0143e9596cd8f790d5e166d4ba6a2425fbc57f14`. When SQLite secondary indexes are disabled, schema initialization already removes all 23 current and legacy index names. Import startup now skips repeating those no-op statements. The enabled-index path still drops its indexes before insertion, and schema initialization still cleans up legacy databases. No worker, batching, cache, compression, dictionary threshold, or persistent format changes are involved.

The new SQLite tests cover legacy-schema cleanup, enabled-index deferral and restoration, rollback, and reuse after failures. Local Chromium qualification could not start: the container rejected the browser's process-singleton socket with `EPERM`, before extension loading or import. This is not a timing observation.

The prospective hosted screen is `.github/workflows/import-index-startup-513d.yml`. It runs only when this draft PR is first opened, freezing its event head against the baseline above. Each locked JMdict, Jitendex, and VNDB fixture gets six complete-import pairs on each of two independent hosts with opposite initial orders. The unchanged `import-qualification-20261125-a7f7.py` runner preserves identical-code controls, package and fixture identities, persisted-result checks, exhaustive media validation, and separate memory observations. Every prescribed failure is retained. This screening cohort is smaller than the full qualification prescribed below, and a green workflow is not a timing acceptance gate. Removing 23 statements is a work-count claim; no complete-import speedup is established by the implementation alone.

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

## 2026-11-25: numeric scalar candidate (#899), correctness evidence

**Hold.** The frozen [numeric scalar parser candidate, PR #899](https://github.com/ManabiIO/manabitan/pull/899), matched the baseline across every locked Jitendex and VNDB term bank at the parser and prepared-lookup boundary. These are correctness-only observations; no timings were recorded. The completed browser study below separately records the failed target speed gate. This evidence follow-up changes only the shared handoff and archived observations.

### Frozen source and fixture identities

| Source                        | Commit                                     | Tree                                       |
| ----------------------------- | ------------------------------------------ | ------------------------------------------ |
| Baseline `develop`            | `7d1643e6147a10cb2165e9744cf0e63b59e46632` | `99d23f16e973c7ae9feba77ca3643d1c27dfb93d` |
| Executed local numeric source | `cc750d34d7672a25e8adb8660ab71cdfa6ba66a6` | `f92b9b5663b0b7cd4f3c525cfc2f11483ff852a5` |
| Published numeric source #899 | `6d3d06408280e0f5d4437186c07b1d93429e2180` | `f92b9b5663b0b7cd4f3c525cfc2f11483ff852a5` |

Node was `v22.22.0`. The source-bound native manifests pin Clang and LLD `21.1.8`; each arm's loaded module was checked against its own manifest and source identity before parsing. Source files, the module, the dictionary lock and the executing runner were checked again at completion. Exact C, JavaScript and manifest hashes are retained in the [machine-readable evidence index](../../builds/perf/import-numeric-20261125-ef009/evidence.json) and the original reports.

| Native identity                       | Baseline                                                           | Candidate                                                          |
| ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `term-bank-parser.wasm` SHA-256       | `913da48a70eebfe8dfe8d96b60064cf0d472db3eccb2c12771686696cb78005c` | `b91dc90f9f42fe09f922d62cfc9f7788246d4c53c74d5373db4c671a174c5e0d` |
| Complete 14-file native source digest | `51253be7b58d1481097e0a27a1f69183c6dd763dc22bc32de3238b71982efa20` | `1eee8c0e70d8850796b705e72448d2016e26fdedf2f702746015781a3cbfd437` |

The dictionary-lock SHA-256 is `60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89`. The complete archive size and hash were verified before parsing. These are the current locked corpus counts for this observation; the older counts earlier in this handoff describe their historical round.

| Dictionary | Archive bytes | Archive SHA-256                                                    |
| ---------- | ------------: | ------------------------------------------------------------------ |
| Jitendex   |    38,831,822 | `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356` |
| VNDB       |   291,705,969 | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` |

### Complete-corpus observations and boundary

| Dictionary | Consecutive banks | Groups | Term rows | Decoded source bytes | Prepared lookup bytes | Result           |
| ---------- | ----------------: | -----: | --------: | -------------------: | --------------------: | ---------------- |
| Jitendex   |             1–219 |     22 |   436,555 |          538,927,310 |            20,078,148 | All groups equal |
| VNDB       |             1–665 |     84 | 6,648,310 |        4,267,992,967 |           353,523,608 | All groups equal |

The runner streamed ZIP entries in bounded groups, at most 64 MiB of decoded source and ten Jitendex or eight VNDB banks per group. These fixed component groups do not assert that production admission creates the same partitions. Both arms used the same parser options, including strict glossary validation, content hashes, token content, media hints and prepared lookup indexes; the exact options are in every report. Each source bank's decoded hash and immutability were checked.

SHA-256 covered all emitted prepared lookup bytes and compact plans, reading-equality flags, scores, sequences, per-row token-content bytes and hashes, and the projected media-row fields and typed byte arrays. Row, lookup-byte and projected-media-row counts were also compared directly. The reports retain digests rather than the complete emitted arrays. A separate post-run check verified every expected bank name in order, the exact locked row totals, group source-byte totals and the recomputed aggregate output digest.

| Dictionary | Aggregate output digest                                            | Fused attempts / fallbacks, each arm | Projected media rows, each arm |
| ---------- | ------------------------------------------------------------------ | -----------------------------------: | -----------------------------: |
| Jitendex   | `1d18ee585ea4f2e3ac9720d6ec0f578390408d9ccf35dffae0fb3e84e83d6e3f` |                               22 / 0 |                            339 |
| VNDB       | `05942aee301c1f8e7bb434c701132d1856353a8e692d083b3163cb32396c494a` |                              83 / 24 |                        146,645 |

Projected media rows are term rows, not unique image counts. The recorded maximum individual parser WASM heaps matched (89,063,424 bytes for Jitendex and 88,801,280 bytes for VNDB), but those diagnostics do not measure concurrent browser/process-tree memory. This comparison excludes worker IPC, compression, persistence/OPFS, browser restart and image-payload readback. It establishes no complete-import speedup or whole-process memory non-regression, and does not replace browser functionality, lookup, storage or reliability gates.

### VNDB interruption, resume and runner provenance gap

The first VNDB attempt exhausted the shared filesystem while writing its report checkpoint. The exact truncated 36,864-byte artifact is preserved, SHA-256 `a21cdb5902c80df8f53d92f1558f4306cb860f6377e7ef1fe1b5d83c17235cc4`. Recovery accepted only the fifteen fully recorded matching groups: banks 1–120, totaling 1,200,000 rows. Their complete objects were compared with the preserved partial artifact after the resumed pass. The incomplete group was processed again; the resume completed banks 121–665, totaling 5,448,310 rows, then required all 665 consecutive banks and all 6,648,310 locked rows before setting `complete: true`.

Resume support added atomic checkpoint writes, identity checks, per-group runner provenance and final consecutive-coverage checks. It required the same baseline/candidate source identities, modules, archive and lock hashes, parser options and grouping bounds. The reports retain both attempts rather than presenting an uninterrupted run.

| Runner use                                           | SHA-256                                                            | Source preservation                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All Jitendex groups and the first 15 VNDB groups     | `63999e7f071c99b8ca4efdf5344b4e0dc38fa8c8126e9e0cec7461b363f1ec0b` | Hash recorded by the original reports; original runner source unavailable                                                                                           |
| Remaining 69 VNDB groups and final resume validation | `2fa14d162d57557000516cb00635889781a975d3dbd364bc58591e01683777b5` | Exact source archived as [numeric-corpus-parity-resume-runner.mjs.txt](../../builds/perf/import-numeric-20261125-ef009/numeric-corpus-parity-resume-runner.mjs.txt) |

The original runner source was overwritten when resume support was added. A search limited to `/workspace/scratch/ef009a302ea8`, including ignored numeric/parity files but excluding dependencies and Git internals, found only the resume runner and its exact copy. No source file is supplied under the original hash. This is a provenance limitation for all Jitendex observations and the recovered VNDB groups. The archived resume source retains its original absolute worktree paths and relative imports; it is execution evidence rather than a relocatable CLI. Changing those paths would create a new runner identity.

### Durable artifacts and review

The [evidence index](../../builds/perf/import-numeric-20261125-ef009/evidence.json) maps every report and log to a byte-preserving gzip file under `builds/perf/import-numeric-20261125-ef009/raw/`, with both compressed and original byte sizes and SHA-256 values. It includes the failed attempt, truncated checkpoint and resume log. The complete raw report SHA-256 values are `748b175373a6861aa49206d04e748aa94b65d44a56dec524f5a88f1d962ae191` for Jitendex and `10131ec18947e822fc9b71add6c21ee118c1ec8cf7d7da2c0d1cd40d446b59cf` for VNDB. No decoded corpus or complete emitted arrays are committed.

Verify the archived bytes from the repository root without running an import:

```sh
python3 - <<'PY'
import gzip
import hashlib
import json
from pathlib import Path

root = Path('builds/perf/import-numeric-20261125-ef009')
evidence = json.loads((root / 'evidence.json').read_text())
for artifact in evidence['artifacts'].values():
    packed = (root / artifact['path']).read_bytes()
    assert len(packed) == artifact['compressedBytes']
    assert hashlib.sha256(packed).hexdigest() == artifact['compressedSha256']
    raw = gzip.decompress(packed)
    assert len(raw) == artifact['originalBytes']
    assert hashlib.sha256(raw).hexdigest() == artifact['originalSha256']
runner = evidence['runner']
source = (root / runner['preservedPath']).read_bytes()
assert hashlib.sha256(source).hexdigest() == runner['preservedSha256']
print('All archived artifact and preserved-runner hashes match')
PY
```

The decision remains **hold**. These observations add full locked-corpus parser/lookup correctness coverage for the numeric change. Browser timing and other promotion gates are separate; the completed browser study below records their relevant results. Prior exploratory component timings provide no qualified speed claim here.

### Local JMdict component observations

The earlier JMdict observations are preserved separately in the [exploratory evidence index](../../builds/perf/import-numeric-20261125-ef009/exploratory-component-evidence.json). The clean parser/lookup run contains six observations over all 528,299 locked rows; every output digest is `824881eada22d2d2f9ac8feddb66322e2bab124fe6af634ef5ded7c303c40b9b`. Its existing repository runner is retained at baseline `7d1643e6147a10cb2165e9744cf0e63b59e46632`, with SHA-256 `3d1a1fabd0b7827f279ec7d39d88c96ab830bc214a40cdbdee35773892a4119a`, matching every clean observation. The archive is 15,645,766 bytes with SHA-256 `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`.

| Component observation         | Pairs | Median wall change | Median process CPU change | Interpretation                                   |
| ----------------------------- | ----: | -----------------: | ------------------------: | ------------------------------------------------ |
| Parser plus lookup, clean run |     3 |             +3.17% |              Not recorded | Inconclusive; one of three faster pairs          |
| Native fused parser only      |     8 |            −26.10% |                   −16.28% | Exploratory; contradicted by large control drift |
| Native identical-code control |     8 |            −11.94% |                    −8.54% | Demonstrates shared-host variability             |

Both native cohorts contain sixteen observations over all 528,299 rows, with matching outputs in each cohort. The first parser/lookup screen overlapped a baseline unit-test run; its timing is excluded and the report and log remain archived with that reason. All nine original reports, logs and the current native runner source are preserved byte-for-byte as gzip artifacts. The native reports did not record a contemporaneous runner hash; the preserved current runner is identified separately and retains its original absolute paths. These observations exclude complete browser imports and do not justify promotion. The browser study below supersedes their timing interpretation.

## 2026-11-25: complete-import screen for numeric fields, metadata keys and image projection

**Decision: hold all three runtime candidates.** All three designated target cells missed the prospective material-performance gate. All six non-target cells passed their non-regression screens. The successful workflow conclusion records complete acquisition and correctness; it does not mean that a performance gate passed. No runtime default is promoted by this evidence update.

### Frozen candidates and acquisition

| Candidate                | Source PR                                              | Frozen commit                              | Frozen tree                                |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| Integer fields           | [#899](https://github.com/ManabiIO/manabitan/pull/899) | `6d3d06408280e0f5d4437186c07b1d93429e2180` | `f92b9b5663b0b7cd4f3c525cfc2f11483ff852a5` |
| Structured metadata keys | [#895](https://github.com/ManabiIO/manabitan/pull/895) | `36fd7a27b7aa631fc8aa20bd70a9f125850499cb` | `f0d5739c8344b4d14d6b51e0e740e0908e444400` |
| Single-image projection  | [#905](https://github.com/ManabiIO/manabitan/pull/905) | `2af6593a6e3631cbddff736bf2280f0fd40c2a69` | `02f97bf86278a702ab14236323bbd5eaaa71ac90` |

All candidates compare against `develop` commit `7d1643e6147a10cb2165e9744cf0e63b59e46632`, tree `99d23f16e973c7ae9feba77ca3643d1c27dfb93d`. The later #905 CI retry `f4994991ae6d5caa9f4f732d276e2c7a4efcc0a9` is an empty commit with the same frozen product tree. The implementation originally proposed in #893 was retired in favor of the concurrent #895 implementation; [#893](https://github.com/ManabiIO/manabitan/pull/893) now contains only additional regression tests stacked on #895. Earlier measurements of the retired implementation are not evidence for #895.

[Temporary measurement PR #911](https://github.com/ManabiIO/manabitan/pull/911) acquired all nine cells in [workflow run 45644488882](https://github.com/ManabiIO/manabitan/actions/runs/45644488882), attempt 1, at workflow commit `863bda45046ba0bf0c778008d0fb30e65b7f0669`, tree `3418f3b5f3daffed97b10dd19cd6a2070d51d83f`. Each candidate ran against each locked dictionary on a separately assigned GitHub runner. Each cell used three warmups, all six ABC permutation blocks (18 timed imports), and two exhaustive A/B media validations: 23 fresh-profile imports per cell. C used the exact A release ZIP. No browser observation was excluded, replaced or rerun.

The timer is the existing browser-monotonic interval from the file-input change through visible import completion. Original reports confirm Node `v22.22.0`, Chromium `153.0.8010.12`, Chrome release packages, production defaults, and disabled tracing, profiling, screenshots and process sampling. Every observation required source/package/harness/fixture identity, original import validation, public lookup and restart verification. Exact protocol, runner and workflow bytes are archived with the observations.

The prospective target requirement was at least a 5% median paired reduction against both A and C, with at least five of six faster pairs against each. Non-target medians could regress by no more than 3% against either control. A passing single-host screen would still require independent replication before a qualified performance claim. No candidate reached that next stage.

### All nine results

Negative percentages mean lower import duration. Every row uses all six predetermined timed cohorts.

| Candidate        | Dictionary | Role       | Median B/A | Median B/C | Faster B/A | Faster B/C | Gate |
| ---------------- | ---------- | ---------- | ---------: | ---------: | ---------: | ---------: | ---- |
| Integer fields   | JMdict     | Target     |    −1.940% |    −1.228% |        4/6 |        4/6 | Fail |
| Integer fields   | Jitendex   | Non-target |    −2.077% |    −0.987% |        5/6 |        5/6 | Pass |
| Integer fields   | VNDB       | Non-target |    +0.454% |    −0.158% |        2/6 |        3/6 | Pass |
| Metadata keys    | JMdict     | Non-target |    −3.895% |    −0.153% |        6/6 |        3/6 | Pass |
| Metadata keys    | Jitendex   | Target     |    +0.015% |    +0.322% |        3/6 |        3/6 | Fail |
| Metadata keys    | VNDB       | Non-target |    +1.844% |    +1.536% |        2/6 |        1/6 | Pass |
| Image projection | JMdict     | Non-target |    +0.448% |    −0.349% |        2/6 |        3/6 | Pass |
| Image projection | Jitendex   | Non-target |    −0.380% |    +0.060% |        3/6 |        3/6 | Pass |
| Image projection | VNDB       | Target     |    −0.805% |    −1.479% |        4/6 |        4/6 | Fail |

These observations do not establish a material complete-import speedup. Identical-code controls varied, and there is only one assigned runner per candidate/dictionary cell. The archive retains every paired ratio, control variation, equal-work total and descriptive uncertainty result; it does not select favorable subsets or transfer a component reduction to the complete import.

### Correctness, stored bytes and package size

Independent recomputation verified all 207 successful imports and semantic proofs, including 162 timed observations, 14,904 public lookup observations and 18 exhaustive media validations. Each import includes twelve probe terms across six passes. A/B results, restart checks, media counts, bytes and digests match. Each exhaustive VNDB validation reads 146,570 images totaling 188,131,284 payload bytes; the shared media digest is `ea94d392bc833baf0bee7b3d6becc3d3517eee84ee314a44986438ac6d5217cb`.

| Dictionary | Observed logical OPFS bytes after restart and verification |
| ---------- | ---------------------------------------------------------: |
| JMdict     |                            43,520,477 in every observation |
| Jitendex   |                            67,466,332 in every observation |
| VNDB       |                                    609,553,611–609,561,803 |

The only VNDB variation is in metadata-keys `cohort-1-B` and `cohort-1-C`: both add 8,192 bytes in one opaque SQLite pool file (536,576 instead of 528,384 bytes). The identical-source C control shares that increase. Content, term/index and media archive lengths are unchanged. This establishes the reported logical-size range, not complete persisted-byte equality or physical disk allocation.

The baseline release ZIP is 16,790,986 bytes. Numeric fields add 607 bytes, metadata keys add 486 bytes, and image projection adds 2,865 bytes. The native modules grow by 340 and 345 bytes respectively. Package-member hashes for each frozen source match across its dictionary hosts; only the declared two production members differ between each candidate and its baseline.

The raw reports mark `source.dirty: true`; preparation creates an untracked dependency symlink. The audit uses explicit source, native, harness and package hashes and does not claim clean worktrees. Nine distinct assigned runner IDs were verified, but the timing study did not record boot IDs or physical-host identities. The separate memory study retains its own host identities and does not supply latency evidence.

### Evidence, verification and scaffold repair

The [machine-readable aggregate](../../builds/perf/import-screen-20261125-ef009/evidence.json) is the entry point. It retains all compact observations and points to nine compressed full bundles containing 1,818 original reports, host snapshots, receipts, schedules and logs. Original GitHub artifact ZIP digests and all eighteen nested release ZIP hashes were verified. The large release ZIP payloads are omitted from the durable bundles after verification; their source identities, member maps and hashes remain archived, and the original CI artifacts retain the payloads.

The [independent audit](../../builds/perf/import-screen-20261125-ef009/independent-audit.json) has SHA-256 `3c256f93a30addf7815db848a9204a0c9286c6d85c54bb025cbe131b44c5fc69`. Its [exact auditor source](../../builds/perf/import-screen-20261125-ef009/independent-audit.py.txt) has SHA-256 `7259c6f64a1dfb6193df5cecc0f6f0baf8a7172e4c06ed36013c63ecfe0ecf6a`. It independently checked archived member bytes, observation counts, raw browser configuration, source/package/harness identities, semantic evidence, paired arithmetic, gates, stored sizes and cross-cell consistency. Preserve the archived bytes when inspecting them; do not rewrite original observations to match a new script or schema.

The temporary scaffold's general CI found one bookkeeping failure: its new protocol JSON was absent from `test/data/json.json`. The other 154 JSON tests passed. A one-entry registration repair passed the exact local `npm run test:json` gate (155 tests) without changing any executed protocol, runner or workflow bytes. The original failure and passing remediation logs are retained. This repair does not replace the completed observations or turn the failed performance gates into passes.

All fifteen enabled source-CI jobs passed for [numeric fields](https://github.com/ManabiIO/manabitan/actions/runs/45641722087), [image projection](https://github.com/ManabiIO/manabitan/actions/runs/45644919029), the [metadata-key implementation](https://github.com/ManabiIO/manabitan/actions/runs/45640793230), and its [test-only follow-up](https://github.com/ManabiIO/manabitan/actions/runs/45642650714). These include full unit tests, Chromium and Firefox extension E2E, Anki deduplication, pinned build, lint and types. Their four intentionally skipped optional jobs are not counted as passes. Source correctness CI and failed performance promotion gates are reported separately.

### VNDB image projection: component evidence and its boundary

The [image-projection evidence index](../../builds/perf/import-vndb-20261125-ef009/evidence-index.json) retains the complete local component report, executed runner, consistency audit, logs and source CI receipt. It compares synchronous owned chunk copying from the same native-validated borrowed input. All 6,648,310 rows across 665 term banks and 170 production-sized groups produced equal complete nested chunk outputs before the next native heap reuse and again after `structuredClone`. The native producer was unchanged; separate regression tests exercise actual compressed worker transport and reuse.

All 146,725 projected media rows took the new path with zero projection fallbacks on this pinned corpus, preserving 146,570 distinct image paths. The cumulative glossary decoder and corresponding snapshot input fell from 84,398,732 to 2,684,628 bytes: 81,714,104 bytes, or 96.82%, avoided. This counts work and copying over the corpus. It is not a peak-memory measurement or a browser latency result.

The local component schedule retained three ABC warmups and eighteen timed observations in all six permutations. Its paired medians were −32.59% against A and −29.02% against C, but one candidate pair was +59.05% and an identical-code control pair was +157.73%. All tails remain in the report. The shared host had competing work; this exploratory result cannot qualify a complete-import improvement. The frozen browser VNDB target subsequently measured only −0.805% / −1.479% and failed its prospective gate.

The executed projector source has SHA-256 `e0ba54af2c7595e72d5840ff6b32759b90470d27fe278c1c9620507d09dad658` and is byte-identical to the published candidate. The component parser hash is `d57f716ab26ea3e5c032f534ec2b0ee607510511f3e9ed8ec93e7377883c508d`; the final parser hash is `23f99cd19db8b4d562bf57e73a9b3bbe43e55f22df8fa33b4055d219f0e1569d`. Reversing exactly one leading-indentation edit reproduces the measured hash. That distinction is preserved rather than assigning final-source identity to the earlier component run. The archived runner is exact execution evidence with its original absolute paths.

Local validation passed 276 tests across five focused suites (94 new cases), changed-file ESLint, main/test types and seven target dry builds. The local full unit run was interrupted with exit 130 and is retained as incomplete. The later complete source CI passed all fifteen enabled jobs. Correctness and copy-volume results support retaining the candidate for review; the failed whole-import performance gate keeps it on hold.

## 2026-11-25: separate image-projection memory qualification

**Decision: hold; the complete six-cell memory requirement is unqualified.** Five cells passed the original coverage and memory limits. VNDB host 1 failed coverage in candidate observation B1. All acquisition and functional checks completed, but that missing qualified observation prevents a complete memory non-regression claim.

[Temporary memory PR #916](https://github.com/ManabiIO/manabitan/pull/916) acquired the study in [run 45646484626](https://github.com/ManabiIO/manabitan/actions/runs/45646484626), attempt 1, at workflow commit `57590f5eaee359d721ba9d5d8bde28728a8d172e`, tree `1be0798152baa751fd22a4bbd8f4b6a48c21be08`. It compares the exact frozen #905 image-projection tree with baseline `7d1643e6147a10cb2165e9744cf0e63b59e46632`. Protocol SHA-256 is `0880cf10e13635bddd64a4d0848db13c4f46b06684e92f826a643086d213bc42`.

Each dictionary used two separate hosted instances, with four fresh-profile imports per instance in fixed ABBA and BAAB order. The original Chromium-process-tree observer, auditor and their tests remain byte-identical to the declared earlier measurement source. Sampling retains 25 ms waits between scans, at least five fully covered import scans, and at most 250 ms covered gaps and import-window brackets. Both sampled PSS and private-memory maxima must have a median paired increase no greater than 5% and no individual-pair increase greater than 10%, with every observation qualified. No observation was rerun, replaced or judged under revised limits.

Identical test-only overlays mark the original automation import window and label browser reports, benchmark summaries and memory receipts as non-authoritative for timing. Exact original and applied harness hashes are retained. Product packages, their own native modules and source identities are unchanged by instrumentation. Startup, subsequent semantic/media readback and restart are excluded from the sampled maxima. These are non-atomic sampled process-tree maxima, not exact peaks or complete-import latency observations.

### Complete six-cell result

Negative percentages indicate smaller sampled maxima. Both values in each metric column are the median paired change and the largest individual paired change.

| Dictionary / host | PSS median / worst pair | Private median / worst pair | Result           |
| ----------------- | ----------------------: | --------------------------: | ---------------- |
| JMdict 1          |       −1.406% / −0.367% |           −2.210% / −0.937% | Pass             |
| JMdict 2          |       +0.251% / +0.905% |           +0.007% / +0.601% | Pass             |
| Jitendex 1        |       −2.409% / −1.829% |           −3.056% / −2.391% | Pass             |
| Jitendex 2        |       −0.196% / +0.352% |           −0.409% / +0.630% | Pass             |
| VNDB 1            |             Unqualified |                 Unqualified | Coverage failure |
| VNDB 2            |       +0.843% / +0.929% |           +0.926% / +1.104% | Pass             |

VNDB host 1 B1 has a maximum covered-scan gap of **254.998740 ms**, exceeding the frozen **250 ms** limit. Both audits recomputed it from the original raw scans and import markers. Its qualified PSS/private maxima, pair-1 changes and cell aggregates correctly remain null. The remaining qualified pair cannot replace it. This coverage failure does not establish a memory regression or a memory saving for the unavailable comparison.

All 24 imports exited successfully and passed their semantic checks, including 1,728 public lookup observations, restart validation and complete media readback. The audits verified all 2,399 raw scans, process identities and read sums, clocks, brackets, coverage, maxima, pair arithmetic, source/package/observer lineage, identical instrumentation and cross-host semantics. There are zero evidence discrepancies. Twenty-three observations qualify for memory maxima; the full study requires twenty-four.

Six distinct boot IDs and runner assignments establish separate hosted instances. Hostname labels are reused and do not establish physical-hardware independence. Both A and B package-member maps match across all six cells and match the corresponding timing-study releases. The instrumentation does not supply latency evidence for the failed complete-import speed gate.

### Evidence and maintenance

The [final decision summary](../../builds/perf/import-vndb-20261125-ef009/memory/decision-summary.json) links all six exact compact summaries, six full raw bundles, marker files, original receipts and the failed VNDB job log. The [unchanged-auditor re-execution](../../builds/perf/import-vndb-20261125-ef009/memory/independent-reaudit.json) and [separate direct audit](../../builds/perf/import-vndb-20261125-ef009/memory/independent-review.json) agree. The separate audit output has SHA-256 `b21a3df2528f8ffdb773ae5285b01aaa2c1edc1a20b73fad9ce435034a5f2a2d`; its exact archived source has SHA-256 `b30b0defee67bcc3c5981697ae8152d1a05eaf879e94bab78ed3dcdfa8f738dd`. The [bundle inventory](../../builds/perf/import-vndb-20261125-ef009/bundle-integrity.json) records retained file sizes and hashes.

Original artifact ZIP sizes and digests were checked on retrieval. Release ZIP payloads were omitted from the durable bundles only after their hashes, all member hashes, native bytes and frozen parser/projector source were verified; the original linked CI artifacts retain those payloads. Retained raw logs and archived execution source preserve their original bytes, including original whitespace. A refreshed signed URL was required for one already-completed artifact download; this did not rerun any observation.

The memory scaffold's general JSON CI found exactly two missing file registrations; 154 other tests passed. A two-entry registration repair leaves protocol, observer and workflow bytes unchanged. Its targeted local registry gate passed 77 tests, with 79 unrelated schema tests skipped by that targeted invocation. The full local JSON gate separately recorded 151 passes and five 60-second schema-test timeouts with cause unestablished. Original failure, timeout, targeted-check logs and the exact patch remain archived; the full local run is not counted as a pass.

### Executed commands and final disposition

The original workflows provide the full dependency, browser, archive and frozen-source setup. In a fresh isolated checkout of each recorded workflow commit, their per-cell commands were:

```sh
# Timing workflow 863bda45046ba0bf0c778008d0fb30e65b7f0669
python3 dev/perf/qualify-import-ef009.py integer-fields jmdict 0

# Memory workflow 57590f5eaee359d721ba9d5d8bde28728a8d172e
python3 dev/perf/import-memory-ef009/run_memory.py jmdict 1
```

The timing matrix used all three named candidates and all three dictionaries at replica 0. The memory matrix used all three dictionaries at replications 1 and 2. Each workflow job had its own fresh checkout and output directories; these example commands identify the executed entry points rather than instructions to overwrite an existing evidence directory. The evidence-only PR does not install these temporary workflows or alter product code.

The temporary measurement PRs are closed after acquisition and preservation. The bookkeeping-only registry repairs are retained separately at [timing repair commit `3cec8e1`](https://github.com/ManabiIO/manabitan/commit/3cec8e1c1dd158964ab3aa0cc567ec6285e5a698) and [memory repair commit `4b4f7e2`](https://github.com/ManabiIO/manabitan/commit/4b4f7e280067f3eaa2f5555b822b0b33d8db8d2e), preserving the exact executed study heads and avoiding another acquisition. They do not change any result.

The numeric and image-projection PRs remain on hold, and the measured metadata-key candidate does not meet the target speed gate. The extra parser boundary tests remain a separate reviewable follow-up. Further runtime promotion needs a new material complete-import result under a prospectively fixed comparison; image-projection memory qualification additionally needs a complete covered cohort. No favorable component percentage, unchanged-control fluctuation or incomplete memory observation is substituted for those requirements.

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

# Codex instructions: import optimization experiments

## November 26, 2026: index setup coverage and frozen screen

[PR #940](https://github.com/ManabiIO/manabitan/pull/940), head `afebf0a84057397afeffaa2c6b80b5c5563c46eb`, owns the runtime change that skips 23 redundant import-start index statements when secondary indexes are disabled. It was published concurrently before [PR #946](https://github.com/ManabiIO/manabitan/pull/946). The latter is now a test follow-up to #940: its runtime bytes match the owner exactly, and it adds only the missing real-SQLite partial-index-drop and transaction-start failure/retry cases. The owner's four tests plus these two pass, as do scoped lint and strict TypeScript. The original published implementation remains in the merge ancestry; it is not a second runtime candidate.

The original #946 acquisition remains frozen at `bfc31cc07a805238f57ba2411a8aee4b593c42b3`, against `0143e9596cd8f790d5e166d4ba6a2425fbc57f14`, in [run 45862169149](https://github.com/ManabiIO/manabitan/actions/runs/45862169149). Its one-shot workflow is retained for provenance and does not run again on this consolidation. Local Chromium failed before extension loading because the container rejected its process-singleton socket with `EPERM`; no local import timing exists.

Both original JMdict hosts completed all 26 prescribed observations, including six timed pairs, two identical-code control pairs, separate exhaustive-media checks, and four memory observations. Independent raw-receipt and memory audits pass. Paired medians were -4.240% and -4.192%, with 5/6 faster pairs on each host, but both descriptive intervals include zero and the identical-code controls drifted materially. The elapsed benefit remains unqualified. These are observations of the original frozen implementation, not measurements of the current follow-up head or the owner's exact package.

The original Jitendex and VNDB cells failed their first warmup receipt checks on both unchanged baseline A and candidate B, before any timed pair. Jitendex's observer expected a 512 MiB image-projection policy after production moved to 1 GiB; [PR #950](https://github.com/ManabiIO/manabitan/pull/950) owns that repair. VNDB's historical observer required 129–131 aligned 4096-byte SAH allocation units, while both current imports produced the same 37-unit active file. Imports, sampled content/media, and restart checks succeeded, but those failed cohorts remain failed and provide no timing or memory qualification. Any prospective observer policy must be explicit, source-bound, and independently tested; it must not relabel these acquisitions.

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

## 2026-11-26: import allocation verification (b4b3)

This round starts from `0143e9596cd8f790d5e166d4ba6a2425fbc57f14` and removes two remaining allocations without changing import settings, formats, worker counts, cache budgets, or native modules.

- [PR #934](https://github.com/ManabiIO/manabitan/pull/934), frozen head `cc9fad4a3a528304f546e12e76ebb9afbe1cde6d`, keeps untouched dense ZIP image entries compact when the existing prepared-media or cached-read path owns their payload work. Obtained or replaced entries and all payload fallbacks retain their existing behavior. Concurrent [#935](https://github.com/ManabiIO/manabitan/pull/935) covers the same runtime scope; these are alternative implementations, not changes to merge together.
- [PR #939](https://github.com/ManabiIO/manabitan/pull/939), frozen head `f6d685c0b2511257da4a9a83e7bd977087a42176`, aliases the owned v7 expression-ID column in segmented prepared plans. Value-based consumers accept its Uint16 IDs; native pointer inputs remain Uint32. Reading IDs retain their separate copy because the persisted column contains equality sentinels.
- Combined verification source `e4803e96d581e64eddfc496d847f397ac79bac34`, tree `eeaaadd658b5d1e525806c9bdce8aafec9a8ebf7`, contains exactly both reviewed changes. Its tree matches an independent local merge of the source commits. It is a verification branch, not an integration or release decision.

The first #934 unit run exposed one new replacement fixture missing the size metadata required by the existing inline-prefetch path. The corrected fixture retains that metadata and explicitly verifies it is not admitted to the new compact-entry path; runtime code is unchanged. All other checks in that run passed, including Chromium and Firefox E2E. The failed observation remains visible in run 45861195208.

The first #939 CI run exposed two producer annotations that were too broad after admitting compact expression columns. The frozen head above corrects those annotations, preserving the actual Uint32 producers and native contracts. Local source reviews found no additional blocker; exact-head hosted checks remain required. Failed and incomplete local checks under shared-host pressure are not counted as passes.

### Executable corpus checks

Both source checkouts need `npm ci` and `npm run build:libs`, with the unchanged locked archives in the supplied cache. Run the external-boundary media replay with:

```sh
python3 dev/perf/compact-media-corpus-replay.py \
  --base /path/to/baseline \
  --candidate /path/to/media-candidate \
  --cache /path/to/e2e-dictionary-cache \
  --out builds/perf/20261126-b4b3/media
```

The Python driver invokes `test/perf/compact-media-corpus-replay.mjs`. It independently checks each archive hash, every source-bank row count and referenced image, ZIP CRCs, exact decoded media bytes, and path identities. The Node side uses the complete importer with an explicit counting database and a real source-worker result computed before import. Ordinary maps remain ordinary maps. Numeric-to-object transitions count compact catalog materialization independently of the candidate predicate. The sink checks packed-index geometry, row IDs, CRCs, bounded payload ranges, and decoded image hashes. The replay counts term rows; it does not prove full term-content equality or browser persistence, transport, concurrent preparation, timing, or peak memory.

`--fixtures jitendex` selects one fixture. `--worker decline` tests the existing declined-result path; the importer may still prepare referenced media synchronously. Each subprocess has a bounded V8 heap, which is not a total process-memory limit. Receipts record running, failed, or passed state, reject optimized Python execution, and recheck source, generated libraries/WASM, dependency-lock, runtime, fixture, and harness identities. An incomplete receipt cannot be treated as a passing corpus.

The existing `dev/perf/import-lookup-screen.js` in the expression candidate independently compares all JMdict and Jitendex parser/lookup output. It normalizes only the in-memory expression-ID representation to Uint32 outside measurement; all encoded index, key, and content bytes remain exact. `ownedCompactExpressionRows * 4` counts cumulative Uint32 allocation/copy bytes removed in executed native segments. It is neither peak memory saved nor a whole-import speedup. Do not assume every row executes that route.

### Hosted verification boundary

[The scoped workflow](../../.github/workflows/import-allocation-verification-b4b3.yml) freezes the four sources above and checks JMdict, Jitendex, and VNDB in separate jobs. It runs the native output oracle where supported, complete source-media replay, and actual baseline/combined release-browser imports with all referenced images checked. One browser import per source and dictionary is functional evidence, not a controlled performance comparison. Raw reports may contain timings; no speed or peak-memory claim follows from this acquisition.

All receipts and failures are uploaded from `builds/perf/20261126-b4b3`. Product changes remain drafts pending their relevant checks and qualification. No completed corpus or browser result is asserted before its receipt is inspected.

<!-- da6c4 evidence checkpoint begin -->

## 2026-11-27: owned content overlap and source-bound screens (da6c4)

This round freezes develop at `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
Candidate `a20453bc325faff75a7f6a9c7d408a361c8fe981` has tree
`be4cdfac16b8a6d118c46a23d5750ab50063f142`. These are experiment branches;
no optimization PR or merge is implied. Hosted whole-import qualification is
pending at this checkpoint.

### Workload correction and mechanism

The initial codec replay used the block store's standalone **4 MiB** default,
but the production database uses **1 MiB**. The original 31-block result is
preserved as diagnostic history and establishes no production-default gain.
The corrected planner reads the target from frozen DB source and uses the exact
production span planner: 528,299 JMdict rows, 12 groups, 362,032 globally unique
pending contents, 100,300,626 input bytes, and **103 blocks**. All four baseline
compression workers are active.

The candidate admits one complete immutable owned shared group after its
predecessor publishes metadata. It prepares deduplication/compression while that
predecessor finishes persistence, but its own metadata and records wait for
predecessor completion. At most two append owners exist. Producer lead and owned
byte accounting retire only after completion. A continuing worker rotation
avoids restarting every partial worker round at worker zero. Worker counts,
block boundaries, codec settings, group sizes, budgets, caches, and stored formats
are unchanged.

Borrowed, partial, private, unwitnessed, media, and otherwise ineligible chunks
remain serial. Failure joins all started persistence and unwinds successors
before predecessor metadata rollback; abort, finish, close and purge drain
owners before releasing resources. The legacy append API remains completion-only.
Jitendex/VNDB full-media callbacks do not enable cross-group overlap.
Rotation changes only shared-span batches; private compression remains unchanged.
VNDB uses generic compression.

### Component evidence

The corrected Node v24.22.3 codec screen preloads exact spans, uses four real
codec workers, and excludes parsing, dedup, records, OPFS and UI. Twelve rounds
balance all six A/B/C order permutations. All 36 observations are retained.
Combined B/A paired median is **−16.5153%**, equal-work **−17.2931%**, 12/12 faster;
identical C/A is −1.1922% / −2.3661%. Elapsed medians are 78.6873 ms A,
78.0943 ms C and 67.5730 ms B. Every compressed block is byte-identical and
decodes correctly. This is not an import-speed percentage.

A separate prospective five-arm ablation retains 100 observations over 20
balanced Williams rounds and decodes all 103 blocks separately for every arm.

| Arm                         | Median elapsed | Paired change vs A | Equal-work change | Faster pairs |
| --------------------------- | -------------: | -----------------: | ----------------: | -----------: |
| Serial reset A              |      80.577 ms |                  — |                 — |            — |
| Identical serial C          |      85.018 ms |            +4.092% |          +13.312% |         7/20 |
| Serial rotation             |      78.235 ms |            +2.899% |           −1.906% |         9/20 |
| Lookahead, reset assignment |      76.190 ms |            −4.887% |           −3.293% |        16/20 |
| Lookahead and rotation      |      71.275 ms |            −8.581% |          −12.539% |        17/20 |

The identical-control variation makes exact ablation magnitudes inconclusive.
Rotation alone does not establish a reviewable gain. No observations are replaced.

The full actual DB/store component replay matches all 528,299 rows, metadata
columns, native dedup counters, 103 compressed blocks, and persisted content and
record files. Each arm reopens 36 source-derived probes and passes shard
integrity; native fallback is zero. Only validated matching nonzero random
descriptor/index generation IDs are masked. All 17 exercised source files are
independently bound to candidate `a20453bc`.

The forced gate proves successor compression before predecessor completion.
Maximum pending source bytes are 9,631,061 baseline and 18,700,692 candidate.
Twelve per-group RSS samples have maxima 424,624,128 and 432,545,792 bytes;
these are diagnostic samples, not peak-memory or browser-memory qualification.
The replay uses Node worker/OPFS adapters and a bootstrapped active bulk state;
SQLite setup/journaling/COMMIT and browser producer scheduling are excluded.

Failed attempts remain: an observer expected Uint8Array instead of the worker's
ArrayBuffer; a probe oracle expected negative source sequences instead of
production null; two processes exited 137 with an unestablished cause. Harness
corrections did not change product code. The first isolated baseline had already
written complete artifacts before its oracle failed. A separate read-only process
verified those unchanged files/probes, and the final comparison explicitly binds
the failed original receipt to its successful reopen receipt. Later checkpoints
use atomic replacement; the interrupted second baseline retains ten groups.

### Rejected screens

Prepared-score encoding ran on two independent hosted machines in
[run 46103123270](https://github.com/ManabiIO/manabitan/actions/runs/46103123270),
research source `347856807519a564d259955fe2a17ed34d73fda7`. Both cover all
528,299 rows, 12 groups/chunks, 19 boundary cases and 75 retained observations,
with identical encoded field/lookup hashes.

| Replication | Baseline median | Preparation + sink median | Paired total saving | Sink-only saving |
| ----------- | --------------: | ------------------------: | ------------------: | ---------------: |
| EPYC 9V74   |       10.420 ms |                 10.026 ms |    0.380 ms / 3.65% |         6.709 ms |
| EPYC 9V45   |        7.775 ms |                  7.431 ms |    0.314 ms / 4.06% |         5.484 ms |

Preparation costs about 6.005/4.887 ms. The sink ceiling partly overlaps #855's
direct length access. The five-arm schedule is mildly position-imbalanced.
Typed score columns remove 1,043,222 cumulative bytes, not measured peak memory.
Transport, consumer capability validation, persistence and UI are excluded.
The tiny preparation-inclusive saving does not justify production protocol work
or a score PR.

VNDB's recent shortcut already hits 6,490,301 of 6,648,310 rows. Only 158,009 rows
encode beyond it, while 170 complete native group scans contain 157,864 unique
representatives. A group-local raw-exact cache can remove at most 145 remaining
canonical encodes, possibly fewer. The further 714 duplicates are cross-group.
The default-off global exact flag from direct commit `385857d` adds hashing and
tables after parsing; its old synthetic all-unique regression is not outweighed
by this small ceiling. No implementation is pursued.

Per-worker compression batching was tried in `3469ffb` and reverted in `acc72e4`;
no performance reason for that revert was established. Existing 103-job traces
put idealized critical removal of all queued inter-job gaps near 0.95 ms. This
excludes some handler work and is not a full upper bound, but does not justify
another batching implementation.

### Validation, hosted gates, and evidence

Six focused suites pass 79 tests. Main-source TypeScript and the scoped inherited
test project pass; all seven build targets pass. Local complete test TypeScript
exhausts 512/768 MiB heaps. Multi-file lint and the single-worker complete unit
suite exit 137 before source/test diagnostics. These are retained incomplete
process failures, not passes.

[Qualification run 46105070655](https://github.com/ManabiIO/manabitan/actions/runs/46105070655)
requires complete lint, runtime/test types, unit tests and builds before six
independent dictionary × AB/BA cells. Each cell prescribes 12 timing pairs, four
warmups, interleaved identical-code controls, exhaustive media checks and
separate process-tree memory observations. The exact package gate permits six
changed modules and one added coordinator. Existing +5% paired-median/+10%
per-pair PSS/private bounds remain. Current VNDB active SAH allocation is
prospectively 37 units. Passing correctness/memory alone is not a speedup claim.

Fresh unchanged-source attribution profiles are
[run 46105395307](https://github.com/ManabiIO/manabitan/actions/runs/46105395307),
tooling `7a9fb3c25e97c6aaadc3dd3c5d540f71d4b47f4b`. Each dictionary has one
ordinary release import with all media checked, no experiment flags or tracing.
Build occurs before the source/runtime snapshot and import uses `--no-build`,
avoiding a false generated-manifest identity failure. Single profiles are not
comparative timing evidence.

Raw evidence is `builds/perf/import-overlap-20261128-da6c4/components-v1.tar.gz`,
with member/archive hashes in `components-v1-index.json`: 72 files including both
wrong-target/corrected codec studies, all ablation observations, failed/reopen/
parity receipts, scratch scripts, corpus manifests, both original score
artifacts/job logs, and validation receipts. Pinned ZIPs, reproducible source
spools, and Node OPFS output bytes are excluded; their identities and performed
checks remain recorded. No source optimization is promoted from this checkpoint.

### Follow-up checkpoint: lifecycle repair, rejected cache view, and VNDB route proof

The current source candidate is
`5048ba3e8a65fc41b9ae898c47b54d5731cd759e`, tree
`9d5adaad4be1660b5d22c0e54a5d964e8a11d264`. This supersedes the validation
status above; it does not rebind the earlier full DB replay to newly edited
source files. The original DB parity receipt remains bound to `a20453bc`.

The broader local unit attempt exposed three real lifecycle-ordering regressions
in the unchanged 66-test import-cleanup suite. An unconditional await of an empty
pipeline drain added a microtask before established cleanup ownership. The repair
closes admission synchronously when no owner exists, claims FINALIZING before a
real drain, and permits already admitted owners to complete under that lifecycle.
A gated two-owner test checks that competing close/purge/finalization cannot take
ownership while the drain is pending. Existing assertions were not weakened.

An independent diagnostic repair now subtracts the union of overlapping consumer
wall intervals when deriving `termParseMs`. Per-chunk elapsed sums remain intact.
Nine deterministic cases cover overlapping and reversed completion, disjoint
work, failures, aggregation failure, yielder exclusion, and backward clock
movement. Changes in this derived counter alone are not import-speed evidence.

Validation on the latest source: seven focused suites pass all 146 tests,
including the existing 66-test cleanup suite; all seven build targets pass;
repository-config lint passes for the three changed test files; diff checks pass.
The scoped TypeScript retry exited 137 without diagnostics and is incomplete.
The fixed twelve-shard full-unit attempt retains shard 1 (57 files / 954 tests,
pass) and shard 2 (the three cleanup failures before exit 137); shards 3–12 were
not run. It is not a complete-unit pass.

The original [hosted verification](https://github.com/ManabiIO/manabitan/actions/runs/46105070655)
failed lint before types, units, builds, or browser qualification. Its raw log is
retained. Besides formatting/JSDoc, the failure drain now explicitly collects
only non-null completion promises before `allSettled`; it still releases every
borrowed owner only after real completions settle. The intermediate `805390c8`
cohort is also retained. Current
[qualification 46108795917](https://github.com/ManabiIO/manabitan/actions/runs/46108795917)
and [workflow lint 46108795914](https://github.com/ManabiIO/manabitan/actions/runs/46108795914)
were queued at this checkpoint. No complete-import gain or PR is claimed yet.

#### Rejected recent-cache origin view

A separate prototype retained the full already-charged owned source view when
three JMdict groups began pending content at offsets 49, 289, and 366. It added
an exact contiguous-range/non-alias proof and otherwise preserved scalar and
copied fallbacks, physical-byte accounting, FIFO eviction, and covered-payload
metrics. It recovered bulk mapping for 89,237 entries but required 89,234 extra
contiguity comparisons, 18 alias-pair checks, six small arrays, and three map
insertions per corpus. Three focused files pass 165 tests; all 362,032 resolved
references and 720 replay passes preserve mapping/cache/eviction checks.

The prospectively fixed twelve-round A/B/C replay retained all 36 observations,
each with twenty full-corpus passes. Median times are A 2.700 ms, B 4.146 ms, and
identical C 2.325 ms. B/A paired median is **+33.34% / +1.032 ms**; equal-work
total is **+41.54% / +1.193 ms**, with B faster in only 4/12 pairs. Identical
control drift is −7.93% by equal-work totals. About 91.8% of the measured
candidate regression appears in the nine groups whose row work is unchanged;
the exact mechanism is unestablished. No unchanged rerun, source promotion, or
cache-origin PR is warranted. The complete rejected patch and all observations
remain in the evidence.

#### Current cost attribution, with separate cohorts

Source-identical baseline A observations from external run `46102526376` were
reused only for attribution while this study's own hosted jobs queued. They are
not pooled with component timings or presented as a candidate comparison.

| Corpus / retained baseline cohort | Complete import median | Relevant overlapping counters                                                                                           |
| --------------------------------- | ---------------------: | ----------------------------------------------------------------------------------------------------------------------- |
| JMdict, BA, 12 observations       |             1,070.1 ms | Compression 357.4 ms; canonical scan 106.8 ms; metadata publication 73.4 ms; recent cache 42.45 ms; finalization 129 ms |
| Jitendex, AB, 6 observations      |            1,583.55 ms | Compression 622.8 ms; canonical scan 80.1 ms; exact comparison 51.7 ms                                                  |
| VNDB, AB, 6 observations          |            5,955.45 ms | Worker parsing sum 8,552.5 ms; CRC 1,878.85 ms; result copy 1,863.6 ms; mixed lookup preparation/encoding 846.25 ms     |

These counters overlap and must not be summed. VNDB's lookup counter includes
worker preparation; subtracting its worker counterpart per observation leaves
180.1–222.3 ms, median 216.9 ms, of owner-side lookup encoding. Compaction before
that encoder is outside this particular clock. The VNDB external cohort failed
memory sample coverage (267.10 ms gap versus the 250 ms gate), despite no semantic
failures; it is not a memory-qualified comparison.

The independent exact-source JMdict diagnostic trace attributes the long
finalization interval to one import-worker task with 117.691 ms wall time but
1.820 ms thread CPU. A 116.866 ms sample gap brackets the synchronous index
writer flush; later close work is below 0.4 ms. This supports a flush-wait
inference, not an exact kernel/fsync duration. Concurrent descriptor and index
close counters do not establish that the 45-byte descriptor causes the wait.
Prior #868/#821 work already covers this route.

The recent-cache trace contains mostly validation/extent-loop samples, but its
weights are wall samples, not CPU duration. Some apparent JIT-adjacent spans have
negligible thread CPU, and no optimization/deoptimization events establish a
JIT cause. The trace reports zero borrowed cache bytes and no hidden cache copy.
Its parser preserves negative raw sample deltas and joins profiles by process
and profile ID. Original trace bytes and the attribution scripts are retained.

#### Actual VNDB mixed-content route census

A complete native-parser/global-dedup/content-store diagnostic covers all 170
groups and 6,648,310 rows with real persisted content offsets. It preserves the
actual 512 KiB compression threshold: group 0 stores 503,818 bytes as raw-v6;
group 1 stores new content as raw-block-v2 while 31 rows reuse earlier raw-v6
content. No synthetic offset ranges or forced route selection were used.

Only 175 later references to initial raw content cause eight mixed groups
`[1, 87, 91, 92, 105, 123, 126, 139]` to discard their whole prepared lookup maps.
Those groups contain 320,000 rows (4.81%); the other 162 groups / 6,328,310 rows
retain their prepared bytes. Twenty-seven content-name slices become thirty
fallback encoder runs. The discarded prepared payload totals 16,876,960 bytes.
Fallback compaction reconstructs offsets for 1,856,155 source-key entries
(7,424,620 bytes of offset arrays), copies 508,101 selected keys / 9,051,685
string bytes, and creates 2,560,000 bytes of row-ID arrays. Transferred plans do
not contain full hashes or offsets; the encoded lookup format also does not
persist full key hashes.

All 6,648,310 row-key references pass the source oracle. Native dedup matches
the browser/capture: 170 calls, zero fallback, 157,864 scanned representatives,
157,150 global uniques, and 714 persisted hits. Two record destinations match
the browser, and actual persisted content is 7,533,449 bytes. This diagnostic
intercepts only final record encoding/appending and therefore proves route
counts, not record-persistence parity or speed. The initial pre-execution syntax
failure and the successful three-group gate are retained. A separate subset
prototype and exact ten-group replay capture are in progress, with no gain
claimed at this checkpoint.

The follow-up raw archive is `components-v2.tar.gz`: 91 files, 11,535,260
uncompressed bytes, 1,295,660 compressed bytes, SHA-256
`8d426c47c2921d0f66d7b963ce66cefde4c26a8330ce87419aeec743d2112fae`.
`components-v2-index.json` records each member's size/hash, exact scope, and
exclusions. It preserves original baseline reports used above and the original
diagnostic trace; large unrelated external product packages are excluded with
their archive identities retained. The immutable v1 archive remains unchanged.

### Subsequent checkpoint: rejected subset route and completed ordinary profiles

The original ten-group VNDB record capture completed before the executor became
unavailable. It covers 400,000 rows, the eight mixed groups, two unchanged
controls, original global ID gaps, and all 32 baseline final runs. Its manifest
SHA-256 is
`9b0e9360aa091613674d6288491d5f9f7c520e8bb2801b9bfc83a18393c09460`.
This capture is separate from the full-corpus route witness already in v2.

The prepared-index subset prototype passed 209 semantic cases and reproduced
all 17,306,784 lookup payload bytes across the eight affected groups. Its fixed
twelve-block A/B/C screen completed all 36 observations and 864 timed group
rebuilds. Preparation-inclusive medians were A 78.675 ms, B 95.571 ms, and
identical C 84.950 ms. B/A paired median was **+17.008 ms / +21.875%**, faster
in only 2/12 blocks; B/C was **+11.275 ms / +13.317%**, faster in 3/12.
Equal-work changes were +13.216% and +9.699%, respectively. Identical C/A
paired-median drift was +7.168%. Every affected group was slower in B than
both controls by its group median. The candidate rehashed almost as many key
bytes while adding whole-source validation and recreating the same outputs.
This route is stopped, without a production implementation or timing rerun.

These post-v2 raw observation, capture, and census files were not uploaded before
the executor outage. The separately committed
`post-v2-known-results-handoff.json` records the findings, original known
file hashes, and the prior independent audit's scope; it is explicitly a
known-result receipt, not reconstructed raw data. Neither immutable archive
contains those later original payloads. Regenerated experiments receive new
source/capture identities and do not replace the unavailable originals.

The actual unchanged Jitendex worker census also rejects the proposed
media-free overlap extension: all 22 groups are borrowed, and only the final
group has no media hints. There are zero eligible complete-owned groups and
zero adjacent media-free pairs. No implementation or timing is justified by
that census. The separate current-source early-release study on
`perf/early-content-release-20261128-81585d` already covers a useful borrowed
worker route; this branch does not duplicate it.

#### Completed current-source diagnostic profiles

All three jobs in
[run 46105395307](https://github.com/ManabiIO/manabitan/actions/runs/46105395307)
completed successfully against exact source `9e10d3b3`. Before/after tracked
and runtime manifests match, exhaustive media checks pass, and cold restart
plus 72 lookup observations pass per dictionary. Each is one ordinary,
untraced observation on its own hosted machine; the following values are
diagnostic attribution, not paired improvements or cross-host comparisons.

- JMdict on EPYC 7763: page import 977.6 ms, worker 939.5 ms, parser wall
  814.2 ms, sink 577.0 ms, compression 385.1 ms, canonical scan 107.4 ms,
  and finalization 27.2 ms. All 12 groups use the owned native route.
- Jitendex on EPYC 9V74: page import 1,475.9 ms, worker 1,449.5 ms, parser
  wall 1,087.6 ms, sink 700.0 ms, compression 493.4 ms, media writes
  140.0 ms, and finalization 131.8 ms. All 22 groups use borrowed results.
- VNDB on EPYC 7763: page import 6,953.1 ms, worker 6,913.9 ms, parser wall
  6,675.1 ms, sink 3,099.0 ms, compression 351.5 ms, record fields 545.0 ms,
  and record writes 828.2 ms. Mixed lookup attribution is 908.9 ms including
  687.8 ms worker preparation, leaving 221.1 ms owner-side attribution.
  All 170 groups use owned native results. Finalization is 33.7 ms.

The phase clocks overlap. VNDB's larger lookup total is not removable serial
work, and neither worker CPU sums nor allocation counts establish a whole-import
latency or peak-memory gain. The exact content seed is 7,533,449 bytes, matching
the preserved route witness.

`current-baseline-profiles.json` preserves all three full parsed reports,
source identities, original decoded job logs, and artifact metadata as separate
entries. Artifact ZIP digests are GitHub-advertised identities; the ZIPs were
not freshly downloaded or rehashed during the outage. The retained artifact
IDs are 15249815569 (JMdict), 15249047935 (Jitendex), and 15249408881 (VNDB).

#### Prospective scheduling and alias screens

The active shared-span first-free-worker FIFO component is
[run 46113052837](https://github.com/ManabiIO/manabitan/actions/runs/46113052837),
tooling `81d35bc83af349b611f9ad51cc223de788a2d0d6`. It regenerates
checksum-bound inputs from `9e10d3b3` and executes the frozen `5048ba3e`
codec runtime with the actual 1 MiB / 103-block JMdict plan. A and C are
identical current two-group rotating dispatch; B changes only the physical
worker scheduling policy. Four workers, two admitted groups, output order,
codec settings, and ownership barriers remain fixed.

The screen retains 36 balanced observations, three warmups, and three
source-poisoning ownership checks. Every output must match the original block
hashes and exhaustively decode after compressor workers terminate. The two
incomplete local exit-137 attempts remain separately described; they support
no performance conclusion. No unchanged local retry or pooling is permitted.

The first hosted source, `587d684f` /
[run 46111938461](https://github.com/ManabiIO/manabitan/actions/runs/46111938461),
was superseded while still queued, before accepting any acquisition. Review
found that an idle-worker exit after the final output was saved could be
latched but omitted from the terminal success path. The active source joins
all worker terminations and checks the failure latch before decode or
acceptance. A focused deterministic case fails against the original terminal
block and passes against the repaired block. The successful timed region and
dispatcher class remain byte-identical; the complete script has a new hash.
Every eventual outcome of the superseded cohort remains separate.

Before hosted acquisition, the plan froze a mechanical advance rule: B must
save at least 5 ms and 5% by paired median against both controls, be faster
in at least 9/12 pairs against each, have lower equal-work sums, and have
strictly negative upper endpoints for the specified 20,000-resample paired
bootstrap intervals. Identical-control drift must be less than half the
smaller measured saving. Even a passing component would require a separately
source-bound production implementation and full browser qualification.

The next distinct VNDB screen considers record-only compressed aliases for
the two old raw records responsible for the eight mixed groups. The static
work census is 2,983 bytes of alias input across eight groups and 429,824
fewer lookup payload bytes, before measured frame/envelope/reference overhead.
These are byte counts, not timing gains. The prospective component bounds
are at most 64 canonical raw entries and 64 KiB input per mixed group, an
already selected compression session, and one existing target block family.
Canonical dedup/cache mappings remain unchanged.

That experiment must include canonical reads, compression, append, private
reference construction, the real record sink, and both stores' finalization
in one endpoint. Its input is explicitly an immutable capture; generic
post-await mutation and production provenance remain separate design gates.
The candidate intentionally changes physical layout and therefore requires
semantic/layout-aware verification rather than claiming byte-identical A/B
storage. No alias observation or product modification is claimed here.

#### Registered alias cohort and remaining production boundaries

The immutable VNDB alias screen is
[run 46113754947](https://github.com/ManabiIO/manabitan/actions/runs/46113754947),
source `d0a79f888b36684f26ca76ef880c019ad06c88f1`, tree
`7853cbb3eac7967b90386f9f9f9b1ced06e7f764`, on
`perf/vndb-raw-alias-component-20261128-da6c4`. The
[source-bound reproduction bundle](https://github.com/ManabiIO/manabitan/tree/d0a79f888b36684f26ca76ef880c019ad06c88f1/dev/perf/raw-alias-da6c4)
and its independent review are retained. The workflow, protocol blob, research
HEAD/tree, baseline source, generated codec assets, fixtures, and every helper
are bound before acquisition.

The workflow first requires actual Node 22 syntax, eighteen real-file adapter
cases, and arithmetic gates. It then regenerates all 170 native groups to
verify the original route witness and exact content seed, retaining only the
ten selected groups under an inclusive 64 MiB capture/proof bound. Each of
36 observations uses a fresh child with empty read caches. Every source row,
definition reference, record field, native candidate lookup payload, and
reopened query witness is checked outside the common timing endpoint.
Finalization stays inside that endpoint. Success also requires clean worker
termination and no surviving file locks or staging files before reopening.

The fixed advance gate requires at least 10 ms and 10% paired-median saving
against both A and identical C, at least 9/12 faster blocks against each,
lower equal-work sums, strictly negative upper bootstrap bounds, and the
prospectively specified control-drift bound. All observations and failures
are retained. A component pass would permit production design and a separate
full browser study; it would not establish an import-speed or peak-memory
claim.

The
[ownership audit](https://github.com/ManabiIO/manabitan/blob/d0a79f888b36684f26ca76ef880c019ad06c88f1/builds/perf/import-overlap-20261128-da6c4/raw-alias-ownership-audit.json)
found no existing capability covering whole native lookup/record/reference
columns across the proposed read/compression awaits. The content-slab adoption
witness covers a different allocation. Exported record-factory identity and
dimensional prepared-map validation are insufficient. #820's worker-local
copy-elision proof does not cross transfer, and the concurrent one-use
receive-side receipt expires before an awaited callback continues. A new
private ownership/lease protocol or explicitly isolated snapshot would be
required. Ordinary mutable/factory/caller-supplied inputs must retain the
existing split, revalidation, and rebuild path.

Likewise, a future FIFO product implementation would have to preserve private
buffer transfer timing. This component qualifies only already snapshotted
shared-span messages; it rejects transfer lists. Delaying legacy private-buffer
detachment or ignoring their occupancy in a shared worker queue is outside
its proof.

At this source checkpoint the active overlap verification, repaired FIFO
screen, and new alias screen remain queued. No complete-import gain, alias
observation, production alias/FIFO implementation, or PR is claimed.

<!-- da6c4 evidence checkpoint end -->

### Review candidate: exact component-to-product source binding

The corrected codec replay has now been inspected directly from its verified
archive member. It imports the unchanged `9e10d3b3` production codec pool.
Its B arm rotates that pool's worker array and admits at most two codec groups.
It is a scheduling prototype, not a timing execution of runtime `5048ba3e`.
The committed pool uses a persistent worker cursor; the product coordinator
also waits for predecessor metadata publication before admitting successor
content preparation. That additional barrier can make the useful overlap
window narrower than the component's.

The [compact review receipt](../../builds/perf/import-overlap-20261128-da6c4/corrected-codec-review-receipt.json)
retains all 36 timing observations and all twelve paired rounds, with source,
fixture, archive-member, script, and output hashes. The [exact replay source](../../builds/perf/import-overlap-20261128-da6c4/corrected-codec-replay.mjs)
is byte-identical to the archived script. This is a read-only derivation of the
existing cohort; it adds no observations and replaces none.

B/A paired median change is -13.074684 ms / -16.515289%, with 12/12 faster;
B/C is -10.6450815 ms / -12.919712%, with 11/12 faster. Equal-work changes
are -17.293121% and -15.288806%, respectively. Identical C/A paired median is
-1.011903 ms / -1.192231%. The difference between the arm medians
(78.6873235 ms A and 67.573001 ms B) is 11.1143225 ms; it is a different
statistic from the paired median change.

Every timed observation has identical hashes for every output block.
One separate verification-only serial run decoded all 103 blocks and matched
100,300,626 input bytes. This does not claim 36 separate decompression passes.
The full DB/store parity replay remains bound to original runtime `a20453bc`;
the later `5048ba3e` lifecycle, diagnostic, and lint repairs have current focused
test/build evidence but no repeated full-corpus parity acquisition.

This component gain warrants review of the bounded-overlap candidate in a clean
draft, held for complete current validation and the frozen browser timing,
semantic, and memory gates. No full-import speedup or production memory result
is inferred. The independent FIFO and VNDB alias studies remain separate.

### Clean review branch and independent interpretation

[Draft PR #977](https://github.com/ManabiIO/manabitan/pull/977) is now open at
`4702e9e9d73dda0d0f6ea83dce399a249ebb13a6`, directly on frozen develop
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. It contains exactly seven runtime
files, six focused test files, and the enforced copyright-header registration.
Its tree is `879621db6fc05a24a04239dc51dd748165ff68da`.

The complete `ext/` subtree
`498442aef1fa20e49c414b930c23e38a29749ce4`, `test/` subtree
`d4e90453af7af534f5a8029179e633015e1cbfff`, and ESLint configuration blob
`ecacd4bd0572e1df051d2f0167d11d09d3026cf8` match frozen runtime `5048ba3e`
exactly. The clean branch excludes research scripts, qualification helpers,
archives, and the accumulated research handoff.

The [independent clean-diff audit](../../builds/perf/import-overlap-20261128-da6c4/clean-product-source-audit.json)
records all fourteen path-to-blob bindings, applicable repository validation
requirements, and nearby distinct optimization work. The [independent codec
interpretation](../../builds/perf/import-overlap-20261128-da6c4/independent-corrected-codec-interpretation.json)
recomputes all arithmetic, confirms order balance, and explicitly records the
cohort's downward drift, preloaded-memory scope, noisier later ablation,
one-pass decode check, and earlier-runtime parity boundary.

The prototype's inherited comment about an idle fourth worker applies only to
the superseded 4 MiB screen. All four workers are active at the actual 1 MiB
target. The committed worker cursor changes every shared-span batch; only the
cross-group preparation eligibility is JMdict-specific. Jitendex and VNDB
therefore remain required cross-corpus controls even with serial sinks.

Normal [PR CI run 46114581653](https://github.com/ManabiIO/manabitan/actions/runs/46114581653)
was discovered queued at 06:00 UTC, with ordinary source/type/unit/build and
extension checks unchanged. The existing `5048ba3e` release-browser
qualification remains a separate fixed acquisition. No additional performance
cohort was started by opening the PR; unrelated pre-existing candidate workflow
gates skipped. Draft status and the full-import/memory hold remain explicit.

### Execution handoff: held draft and queued fixed studies

The source reviews are complete and no further runtime change was made after
opening draft #977. The clean head remains
`4702e9e9d73dda0d0f6ea83dce399a249ebb13a6`; develop remains `9e10d3b3`.
The local executor is unavailable. Hosted jobs have been submitted, but their
pending status is not validation or timing evidence.

The [qualification/PR snapshot](../../builds/perf/import-overlap-20261128-da6c4/qualification-status-20261128T060938Z.json)
records the complete observed check metadata at 06:09:38 UTC: current-runtime
qualification `46108795917`, FIFO hosted2 `46113052837`, their actionlint jobs,
and PR #977's substantive checks are queued. Intentional unrelated workflow
skips are distinguished from passes. No queue cause is inferred.

The [FIFO follow-up design](../../builds/perf/import-overlap-20261128-da6c4/fifo-production-followup-design.md)
is source-only and conditional on the unchanged complete hosted2 advance gate.
It preserves immediate private buffer transfer and clone boundaries, accounts
for all posted private/shared jobs when deciding worker availability, keeps
source-consumed separate from final completion, and distinguishes per-job
failure from terminal pool failure. Browser termination has no awaitable join;
the design does not import the stronger Node transport guarantee. No FIFO
production code was added.

The [VNDB alias ownership design and status](../../builds/perf/import-overlap-20261128-da6c4/raw-alias-conditional-ownership-and-status.json)
records exact `d0a79f8` run `46113754947` and actionlint `46113754928` still
queued at 06:13:27 UTC, with no adapter tests, capture, or observations executed.
A viable product design would need a private receiver-to-importer ownership
lease, explicit authority rebinding at the importer payload copy, and a second
publication-bound lease for mutable DB resolution tables. The lifetime must
cover the whole real record append, including lookup payload copying and split
runs, rather than ending at field encoding.

A defensive snapshot would copy at least 26,719,071 cumulative bytes across
the eight affected groups before row columns and other metadata. An
offset-only overlay is derived at 61,360 cumulative bytes, largest 8,528 bytes.
These are source/counter derivations to confirm against the new capture,
not measured peak memory. Production canonical reads may use the import
overlay; a fallback snapshot refresh can flush/close storage. The completed-seed
component does not measure that integration cost. Generic/factory-only callers
retain the existing validation and rebuild behavior. No alias product
implementation is justified before the fixed 10 ms / 10% component gate.

The [related-study snapshot](../../builds/perf/import-overlap-20261128-da6c4/current-related-import-studies-20261128-0610.json)
preserves duplicate-avoidance research separately. Newly committed current-base
#820 summaries show no demonstrated JMdict latency gain; their medians and
faster-pair counts were recomputed from every published ratio, while full raw
bootstrap/semantic receipts were not re-audited. Its VNDB cell remained in
progress. The current #955 port's source validation passed, but all six timing
cells remained queued. The distinct owned-whole `92c09` study had four
successful browser cells and two VNDB failures in separate memory/semantic
qualification; unavailable narrower causes and numerical cohorts stay
unavailable. No results are pooled across those sources or hosts.

To resume, inspect the exact run/job attempts and preserve their complete logs
and compact receipts before diagnosis. Analyze only a complete fixed cohort
against its predeclared controls, identities, semantic checks, and arithmetic.
Keep failed or superseded acquisitions separate. A passing component permits a
new implementation and exact-source browser qualification; it does not
authorize a full-import gain claim or promotion of the held draft. Inspect
develop and PR heads before any later source integration. No unchanged reruns
or relaxed acceptance thresholds were requested.


### Resumed investigation: completed component decisions and repaired qualification

The resumed investigation began at 07:27 UTC on 2026-11-28 after the request to
try harder. This section supersedes the earlier queued-state snapshots only
where an exact completed run or new source is identified; the earlier evidence
and failed acquisitions remain retained.

#### VNDB record-only raw aliases: component advance, product qualification pending

Run [46113754947](https://github.com/ManabiIO/manabitan/actions/runs/46113754947)
executed source `d0a79f888b36684f26ca76ef880c019ad06c88f1` successfully through
setup, eighteen adapter cases, full 170-group route regeneration, bounded
ten-group capture, all 36 fresh-child observations, semantic/closure checks,
and the frozen analysis. Its job failed afterward when actions/upload-artifact
rejected real OPFS filenames containing `|`. No physical OPFS/capture artifact
was retained. The complete decoded job log and all 41 compact JSON records are
retained below. Artifact-upload failure must not be represented as either a
timing failure or a retained binary capture.

The actual component included canonical reads, alias compression and append,
private reference construction, record writing, and both stores' finalization.
Across twelve balanced ABC rounds, B/A paired-median saving was 188.7700885 ms
(52.6206937646%), and B/C saving was 181.704151 ms (50.9718844610%). Both comparisons
were faster in 12/12 pairs. Equal-work changes were -52.2149775067% and
-51.7298341680%, respectively. The paired-median delta 95% bootstrap intervals
were [-191.2481715, -184.2195475] ms versus A and [-200.303275, -173.5919975] ms
versus C. C/A paired-median drift was -1.27031967198%. The predeclared 10 ms/10%,
9-of-12, equal-work, bootstrap, and control gates all passed.

All 36 observations matched the complete 400,000-row semantic witness,
84 reopened lookup probes, and 9,302 referenced canonical definitions, with
clean locks/staging/resources and unchanged input hashes. The root and an
independent reviewer separately recomputed every pair, all four bootstrap
distributions, and final PRNG state 1110904116. This is an immutable captured
component using a completed content seed, not a current complete-import or
browser-memory result. The measured half-time reduction concerns this component
only. The gate authorizes a production implementation and a separate source-bound
qualification; it does not establish a corresponding import speedup.

Retained evidence:

- [Decoded full hosted log](../../builds/perf/import-overlap-20261128-da6c4/raw-alias-hosted-job-140882831654.log)
- [All compact setup, route, capture, observation, and analysis receipts](../../builds/perf/import-overlap-20261128-da6c4/raw-alias-hosted-complete-receipts.json)
- [Independent full arithmetic and evidence audit](../../builds/perf/import-overlap-20261128-da6c4/raw-alias-hosted-independent-audit.json)
- [Root's separate complete recomputation](../../builds/perf/import-overlap-20261128-da6c4/raw-alias-hosted-root-audit.json)

The product implementation is being developed independently on baseline
`9e10d3b3`, rather than stacking it on unqualified overlap runtime. It requires
private receiver-to-importer provenance, explicit rebinding at the importer's
payload copy, a distinct DB-publication lease, and lease retention through the
entire record append and rollback. Review found and corrected cancellation
before rollback-state adoption and external close/purge racing an awaited alias
append. These are new product validation obligations; component provenance
does not cover them. Ordinary mutable/factory-only callers retain the original
split/revalidation behavior. The original binary capture was lost with the
ephemeral home directory; a subsequent product capture must have a new explicit
source/fixture identity.

#### JMdict FIFO: complete negative result, no product implementation

Run [46113052837](https://github.com/ManabiIO/manabitan/actions/runs/46113052837),
exact source `81d35bc83af349b611f9ad51cc223de788a2d0d6`, completed successfully.
All 36 timed observations, three warmups, three source-poisoning ownership
witnesses, and 42 exhaustive decode proofs passed. All four workers joined
cleanly with no terminal failure. The frozen performance advance gate failed:
FIFO was slower than both controls.

B/A paired-median change was +4.227437 ms / +6.6828065%, with only 2/12 faster
pairs; equal-work change was +6.9889125%. B/C was +3.642377 ms / +5.6627342%,
with 3/12 faster; equal-work change was +4.1089470%. The respective 95% time
intervals were [1.511905, 8.650361] ms and [-1.106683, 6.763570] ms.
Control drift passed its gate. The candidate's required gain did not.

The full 489,446,028-byte artifact was streamed to verify its SHA-256 against
GitHub's artifact metadata. Thirty compact members were recovered without
retaining another full archive copy. The exact 4,623,329-byte observations JSON
is preserved as gzip, along with the unmodified gate and acquisition metadata.
An independent reviewer recomputed the complete fixed cohort. There is no FIFO
production change, no unchanged rerun, and no promotion of the conditional
source-only FIFO design.

Retained evidence:

- [Full observations JSON, gzip](../../builds/perf/import-overlap-20261128-da6c4/fifo-hosted2-observations.json.gz)
- [Decoded hosted log](../../builds/perf/import-overlap-20261128-da6c4/fifo-hosted2-job-140880647245.log)
- [Exact full gate](../../builds/perf/import-overlap-20261128-da6c4/fifo-hosted2-complete-gate.json)
- [Setup receipt](../../builds/perf/import-overlap-20261128-da6c4/fifo-hosted2-setup.json)
- [Full artifact stream verification](../../builds/perf/import-overlap-20261128-da6c4/fifo-hosted2-artifact-stream-verification.json)
- [Recovered archive member index](../../builds/perf/import-overlap-20261128-da6c4/fifo-hosted2-member-index.json)
- [Exact reproduction evaluator](../../builds/perf/import-overlap-20261128-da6c4/fifo-hosted2-reproduce-analysis.mjs)
- [Independent arithmetic audit/evaluator](../../builds/perf/import-overlap-20261128-da6c4/fifo-hosted2-independent-audit.json)

#### Overlap source validation: fix the concrete errors, preserve the runtime

The original `5048ba3e` qualification run
[46108795917](https://github.com/ManabiIO/manabitan/actions/runs/46108795917)
passed project JavaScript lint and main-runtime TypeScript, then failed the
test TypeScript gate with three errors. Browser acquisition never started.
The static-web check on the old clean PR source failed for the same errors.

Two test-only fixes explicitly narrow the non-null block session and derive the
dedup helper's actual return type instead of asserting an obsolete Promise<void>.
No runtime code or test assertions changed. Clean draft #977 now points to
`c819bb92d4c26a99300987c00ea79f54fc1734f7`, tree
`3090e6e169da5e623e330e709c343c49837494a4`, with seven runtime files, seven
test files, and the ESLint header registration.

New independent qualification source
`c4330b235eaa31a62c48837578f230038dc48226`, tree
`698af3f9b37112f14f94edf30a0a319fedb60af6`, adds those same fixes and its
dedicated branch trigger to frozen `5048ba3e`. It excludes later research
scripts from project-wide source validation. The clean PR and qualification
source have identical `ext/` subtree
`498442aef1fa20e49c414b930c23e38a29749ce4`, `test/` subtree
`00917417cd71807aa0ca60e7479f31d42a7c8add`, and ESLint blob
`ecacd4bd0572e1df051d2f0167d11d09d3026cf8`.

Local Node 24.22.3 validation passed the full test TypeScript project, 225
affected tests across seven files, 66 cleanup tests, scoped ESLint, and
whitespace checks. The larger local validation runner was stopped while doing
lint; it is not a full local gate pass. The original error log, exact fixes,
and local validation receipt are retained:

- [Original failure and repair identities](../../builds/perf/import-overlap-20261128-da6c4/overlap-test-types-failure-and-repair.json)
- [Current local validation receipt](../../builds/perf/import-overlap-20261128-da6c4/overlap-test-types-local-validation.json)

The new fixed qualification is
[run 46121740432](https://github.com/ManabiIO/manabitan/actions/runs/46121740432);
normal PR CI is
[run 46121741374](https://github.com/ManabiIO/manabitan/actions/runs/46121741374).
As last observed at 07:48 UTC, those checks were queued. Their status is pending,
not a source-validation pass or acquired performance result. All original
whole-import, semantic, timing-control, and browser-memory gates remain intact.

#### Fresh critical-path analysis and novelty checks

A single source-unchanged actual DB diagnostic on `9e10d3b3` processed all
528,299 JMdict rows, twelve groups, and 103 actual content blocks, including
parity and terminal checks. The
[exact diagnostic source/report/log bundle](../../builds/perf/import-overlap-20261128-da6c4/jmdict-current-db-diagnostic.zip)
retains the instrumented execution. Native canonical calls consumed 75.8 ms;
in-flight registration, contiguous publication, and recent-cache phases also
remain visible. These are nested diagnostic clocks from one instrumented Node
run, not additive critical-path costs or comparative performance evidence.

The [current mechanism novelty screen](../../builds/perf/import-overlap-20261128-da6c4/current-record-mechanism-novelty.json)
binds eight concurrent un-PR'd branch heads and four related PRs. Existing work
already covers native record encoding, fused whole-run validation/field output,
cache publication scans, range-backed recent caches, and canonical rejection
tags. Those exact ideas are not being reimplemented under another name.
A distinct bounded early read of one small tag-bank text is under source review;
its possible late-stage overlap remains unmeasured. Existing cached-native late
tag decoding is a separate related alternative, so the original diagnostic's
13 ms late tag-read duration is only an opportunity ceiling, not an expected gain.

No new complete-import gain is established in this checkpoint. The VNDB
component result advances one implementation, the JMdict FIFO result rejects
one mechanism, and the repaired overlap draft remains held for current-source
qualification.


### Current-parser baseline and new source-bound investigations

Develop advanced at 07:56:22 UTC to
`dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`, tree
`d911260f1a57f518d59b3a12127fcc3b2293c918`, by merging
[#972](https://github.com/ManabiIO/manabitan/pull/972). Its structured-glossary
fastpath and scalar-token-end reuse change the native parser/WASM. The five
develop changes are disjoint from the candidate patches, but the performance
baseline is materially newer. Existing `9e10d3b3` evidence stays historical;
new acquisition uses current native assets rather than silently composing old
performance numbers.

#### Current overlap review and qualification

Draft #977 now has clean head
`ae19a4c3f471cf5b5b0d2b6215f283c41a1ea9ed`, tree
`11db07622fe196dd1a6fd587aec247553e8de193`. Its fifteen optimization/test/config
path-to-blob changes are unchanged. The current independent qualification head
is `10e8ee6b3daf7020521e3cfec2b2479e907c2fa8`, tree
`1cc06cffff56eccbeddbdcea1c2b2db074b9a1a5`, on
`perf/owned-overlap-current-20261128-da6c4`.
The product and qualification have identical `ext/` subtree
`11b766a159cc47121ac6be913b139d568bbb6632`, `test/` subtree
`1d85377e47fb844195fb7e4b0d3239dc7ba9c7d5`, and ESLint blob
`ecacd4bd0572e1df051d2f0167d11d09d3026cf8`.

[Run 46125980377](https://github.com/ManabiIO/manabitan/actions/runs/46125980377)
is the new current-parser qualification. Its
[prospective decision plan](https://github.com/ManabiIO/manabitan/blob/10e8ee6b3daf7020521e3cfec2b2479e907c2fa8/builds/perf/import-overlap-20261128-da6c4/current-parser-qualification-plan.json)
requires a replicated JMdict improvement of at least 10 ms and 1% paired median,
9/12 faster pairs, negative upper time/percentage bootstrap bounds, lower
equal-work totals, and small identical-control drift. Each Jitendex/VNDB cell
must meet the fixed nonregression, complete semantic, and unchanged memory gates.
There is still no current whole-import result.

Prior repaired head `c819bb92` passed static-web Chromium run
`46121741356`. Its ordinary CI later reported two successes, thirteen
cancellations, and four conditional skips; those cancellations are not passes.
The older `9e10` qualification `46121740432` was queued with no browser
acquisition when superseded. At 08:33:16 UTC its source verify/build job had
started; no browser matrix was observed. It was not cancelled by this work.
Any eventual output from that old source remains separate.

#### Bounded tag text prefetch: implemented, no PR without a measured gain

A distinct small opportunity overlaps the first ordinary small tag-bank read
with term processing. The candidate retains one immutable text result and keeps
JSON parsing, entry validation, progress, and persistence in the existing tag
phase. Both declared ZIP sizes must be known and at most 64 KiB. A separate
writer bounds actual decoder output before copying it, so a forged small ZIP
header cannot authorize unbounded retained text. The existing direct-read scope
owns cancellation and joins decoder cleanup before archive disposal/rollback.
CRC checks and actual decoded-size checks remain active. Artifact/preloaded,
oversized/unknown-size, and term-free imports retain their prior paths.

The initial qualification source `81da87b1` was superseded before timing by
current-base head `b2a909472aa6a415a9bc0b91f7d37208390af016`, tree
`3d74b708853a342c55e89fb825e545a35e8ef57d`, on
`perf/bounded-tag-prefetch-20261128-da6c4`.
[Run 46125860840](https://github.com/ManabiIO/manabitan/actions/runs/46125860840)
uses current baseline `dcfc02a0`. No PR has been opened for this mechanism.

Its [fixed plan](https://github.com/ManabiIO/manabitan/blob/b2a909472aa6a415a9bc0b91f7d37208390af016/builds/perf/import-tag-prefetch-20261128-da6c4/registered-plan.json)
requires at least 5 ms and 0.5% paired-median JMdict savings on each independent
host, 9/12 faster pairs, negative upper bootstrap bounds, lower equal-work work,
small identical-control drift, and all cross-corpus semantic/memory/nonregression
gates. The previous 13 ms late tag read is only a diagnostic opportunity ceiling.
The new bounded writer is part of the candidate, so any effect is not attributed
solely to scheduling. The related cached-native late tag reader remains a
separate mechanism.

The [independent source review](../../builds/perf/import-overlap-20261128-da6c4/tag-prefetch-independent-source-review.json)
found no concrete lifetime/integrity blocker. Historical-base local checks
passed main/test TypeScript, 137 focused import cases, 42 Python qualification
tests, scoped ESLint, and all seven build targets. A full local unit invocation
completed with 659 passing files but also fifteen five-second timeouts, two
missing-WASM-compiler suites, and five unexpected worker exits. The four suites
containing those timeouts then passed all 209 cases with maxWorkers=2, without
increasing timeouts. That diagnosis does not turn the incomplete full run into
a complete pass. The exact failures, subsequent results, and command receipts
are retained in the
[validation archive](../../builds/perf/import-overlap-20261128-da6c4/tag-prefetch-local-validation.zip).
Current-base full hosted gates remain required.

#### VNDB alias product: clean current source and full-data correctness work

The clean source-only branch `perf/native-record-alias-20261128-da6c4`
advanced from `601ccc83` on the old base to
`2c02336b135ee01661ca2a788395afec75e66712`, tree
`17995fab3d9e2fd226f0cc37d306f5dfc7e39505`, on current develop.
It contains seven runtime files, five test/support files, and header registration.
There is no alias PR or product performance result yet.

The [final thirteen-file manifest](../../builds/perf/import-overlap-20261128-da6c4/raw-alias-product-source-manifest.json),
[complete patch](../../builds/perf/import-overlap-20261128-da6c4/raw-alias-product-source.patch),
[local validation logs](../../builds/perf/import-overlap-20261128-da6c4/raw-alias-product-local-validation.json),
and [superseding independent review](../../builds/perf/import-overlap-20261128-da6c4/raw-alias-product-final-review.json)
bind the exact source. Earlier review/checkpoint artifacts remain historical.
Main/test type checks passed before the final style-only changes; the 344
focused/related cases reran afterward. Scoped lint and all-target build passed.
After moving to current develop and rebuilding the 69,068-byte native parser
asset, 392 parser/import/ownership/cleanup cases passed. A temporary Git index
proved the executed current working tree equals the clean remote candidate tree,
while retaining its honest local HEAD/dirty-state record.

The [original product protocol](../../builds/perf/import-overlap-20261128-da6c4/raw-alias-product-browser-protocol-9e.json)
is superseded by the
[current-source amended protocol](../../builds/perf/import-overlap-20261128-da6c4/raw-alias-product-browser-protocol-current.json).
All numerical gates remain fixed: both VNDB hosts need at least 100 ms and 1%
paired-median savings, 9/12 faster pairs, negative upper bootstrap bounds, lower
equal-work totals, and small identical controls. The four JMdict/Jitendex cells
must pass their declared nonregression/control limits and all semantic/memory
gates. The source and verification witnesses must be frozen before timing.

Alias storage intentionally changes physical record/content/index layout and
later canonical physical offsets. The protocol therefore requires a complete
natural-source relocation/alias proof and a separate untimed browser export.
Only the five exact term-storage files and physical reference digest may differ
between arms, and each difference must match a frozen layout witness. Ordinary
observations retain the stock per-observation validation plus an identical,
explicitly bound, read-only post-endpoint hash hook. This is a test-harness
overlay, not a product overlay and not an unchanged-harness claim. Raw hashes
and random generation IDs are retained; only the schema-declared 16-byte
record/index generation fields may be normalized, after validating matching
header linkage. Unrelated media, storage inventory, allocations, and logical
results stay strict.

The first source-setup attempt stopped with zero groups because a bare dense
descriptor lacked the real importer's getData capability. A later observer
attempt stopped before its first record append because it assumed an array
where the existing DB permits uniform dictionary-name representation. Both
are retained harness failures, not product discrepancies or timing observations.
The repaired current-baseline A pipeline then completed all 170 groups and
6,648,310 rows with real native workers, clean termination, no fallback, and
canonical counts matching the historical byte oracle. Its content seed is the
same 7,533,449-byte f50a48e2… file. Separate fresh-reader verification initially
stopped because its process omitted codec initialization; that verifier is
being repaired against the already preserved A output without rerunning the
pipeline. This checkpoint does not claim a completed A/B persisted comparison.

#### Additional JMdict evidence and explicit diagnostic corrections

The [prepared-only census and existing range-cache audit](../../builds/perf/import-overlap-20261128-da6c4/jmdict-capsule-census-and-range-audit.zip)
preserve two rejected/redundant directions. The private-copy census found
15,189,559 cumulative fallback-column bytes, of which only 4,754,691 are beyond
already studied key/expression reuse. Preserving raw sequence semantics reduces
the distinct omission to 2,641,495 bytes: 20,939 real rows have negative
sequences other than -1 that persisted indexes normalize to null. A broader
private-only representation could change that contract, but its small ceiling
does not justify a five-module protocol. No capsule implementation was made.
The existing range-cache branch already implements the proposed representation;
its two audited JMdict cells did not show a replicated latency gain.

The [single actual-DB CPU diagnostic](../../builds/perf/import-overlap-20261128-da6c4/jmdict-db-cpu-profile-9e.zip)
is exactly `9e10d3b3`, not current `dcfc02a0`. It preserves the raw profile,
source/clock/row/block/probe receipts, original analyzer failure, corrected
timestamp analysis, and parity against the earlier diagnostic. Native canonical,
registration, cache, record validation/encoding, and write-side hashing dominate
the observed DB work; those mechanisms have active prior studies. Reader
integrity checks and cold-query posting validation are not import opportunities.

The [explicit route-filter correction](../../builds/perf/import-overlap-20261128-da6c4/jmdict-profile-route-threshold-correction.json)
supersedes an erroneous exclusion in the initial analysis: the route threshold
is 128 MiB, not 1 GiB, and 171,617,523-byte JMdict does build route filters.
Its eighteen filter leaf samples must not be discarded. The separate byte
census disabled route-filter preparation, so its counted fallback columns remain
valid but it is not a complete ordinary-options allocation census. The raw
profile was not rerun or silently replaced.

A new single full-browser diagnostic is prepared under
`dev/perf/jmdict-current-trace-da6c4/`, pinned to current `dcfc02a0`.
It reuses the existing browser-wide trace path and requires source-identified
profiles for three parser workers, four compression workers, and one import
worker, plus complete original source/corpus/runtime/semantic receipts.
[Local control checks](../../builds/perf/import-overlap-20261128-da6c4/current-jmdict-trace-control-checks.zip)
cover twelve receipt cases, YAML parsing, and all ten shell blocks; local
actionlint is unavailable, so the repository's hosted actionlint check remains
required. All traced elapsed values are diagnostic only and cannot be pooled
with ordinary timing. No current browser trace result is claimed yet.


## Follow-up checkpoint: full VNDB product proof and callback compatibility (2026-11-28 08:53:31 UTC)

Current natural VNDB A6/B7 term-storage correctness is complete on baseline dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16 and candidate 2c02336b135ee01661ca2a788395afec75e66712, tree 17995fab3d9e2fd226f0cc37d306f5dfc7e39505. Both arms fully verify 6,648,310 rows/definitions, all 157,150 canonical metadata entries, every sidecar checksum/frame, and all 170 normal content spans. The candidate retains the canonical identities and exact verified relocation map; no canonical entry points to an alias. Eight bounded aliases affect 175 rows across the predeclared eight groups. Native whole-group record admission rises from 162 to 170 groups. Content grows 2,260 bytes and the two index files shrink 431,240 bytes, giving a net five-file reduction of 428,980 bytes. The actual eight canonical reads total 2,983 bytes and require zero additional file operations or ensureLoaded flushes. All reads, bounded copying, compression, and persistence execute in this diagnostic.

This is actual current-source parser/importer/database term-storage integration over a lazy Node file adapter, not complete browser import timing. It includes media reference discovery but excludes media requirement resolution, payload writes, and SQLite. Whole browser media/storage equivalence remains a mandatory preflight; no full-import gain or process-memory qualification is inferred. A6 pipeline max RSS893,328KiB and B7 901,592KiB are single diagnostic readings only.

Every failed attempt remains separate: A3 lacked real archive getData catalog capabilities; A5's observer mishandled the uniform dictionary-name representation; A6's first fresh verifier omitted codec initialization, then the corrected source-bound verifier checked the existing acquisition without rerunning it; B6 was externally killed at1,120,000rows with no proven cause or clean-settlement claim. A6's four completed record files were losslessly archived and all member hashes reverified before removing only those originals, freeing267,095,750bytes. B7 was prospectively allowed once headroom materially recovered and then completed. The134,804,146-byte exact A archive and complete B files remain local; the handoff explicitly distinguishes those binaries from the durably retained source/config/JSON/log blobs. Browser exports are still required.

The complete natural handoff and summary are retained under raw-alias-natural-handoff.json and raw-alias-natural-summary.json. Every44 listed source/config/report/log blob, including gzip originals and the earlier A3failure, is anchored in raw-alias-natural/ with original hash metadata. The browser-layout helper handoff plus all9 source/test/log files are also anchored. Its8Node/13Python tests are helper tests, not browser results. It hashes all bytes of the exact term files after the original endpoint and validation; only the validated16-byte random generation IDs normalize. Full raw hashes and header linkage remain recorded. The identical harness overlay is explicit and source_dirty=true in all arms; product packages remain independently guarded. Whole-browser export/full row proof precedes ordinary acquisition, and every ordinary observation receives full bounded file hashing.

### #977 qualification failure and correction

Superseded9e-based run46121740432 failed its full unit gate after type checks, before browser acquisition: two native settlement child cases and one late failed spans replacement-pool startup case. The full816,174-character log is retained. The worker startup timeout reproduces alone under the normal5s limit. A cleanup-only diagnostic exposes the stale expectation (one call rather than two) without hiding a retrying worker. Test repair blob2271f2744adda13d0e902281aadbae80c2f2dd3d selects the first logical batch's recorded dispatch IDs/worker instances instead of assuming every adjacent shared batch restarts at worker0. Its cleanup disables retries, closes workers and joins tracked owners. All38cases in five relevant suites and scoped lint pass; runtime pool1310d598e4e230eed12c415eb4fbf9be60c8c5a4 remains unchanged. The full failure/diff/pass evidence is retained in overlap-rotation-test-repair.json.

The parser failures are a genuine compatibility issue: the previous runtime awaited and ignored ordinary callback values, while the new shape test rejects incidental numeric Array.push returns. The repair under development identifies genuine one-shot completion tickets through a private WeakMap and ignores ordinary values without reading their properties. It preserves native settlement fixtures unchanged. Until that runtime amendment and combined gates are published, current clean headae19a4 and queued qualification10e8ee are explicitly incomplete; no browser result from those sources will be promoted. PR977 remains draft/HOLD and its description now records these findings.

### Further JMdict novelty checks

The fresh all-worker current-dcfc trace is published at e2786268b7576849fc4e84358623cd9d2277dcc0, run46127144239, still queued at this checkpoint. Local current Node24 exposes Worker.startCpuProfile, so a source-bound actual compressed-input diagnostic is being assessed while hosted acquisition waits; no second measurement has yet run.

The45-byte JMdict descriptor tail was investigated. Related experiments2e1621f4c4d3892723109ce3ea7e848e81affd10 and ebc56e97ecfb6543a85d6d2c61cc6568391b24f6 already overlap descriptor preparation/drain with sidecar sealing; no duplicate prototype was made. Historical diagnostic PR868 demonstrates that descriptor close promises can include blocking local index flush on the same worker. The contemporaneous novelty receipt is retained. A wider16-byte SIMD string scanner was also found in prior PR44: its direct incremental comparison with the existing8-byte first-special scanner did not exceed control variation. PR951 already covers empty-string admission. Those ideas are not presented as new gains.

## Checkpoint: repaired owned-overlap source and completed current JMdict trace (2026-11-28 09:16:12 UTC)

The exact repaired clean #977 head is 88add36ce87811bf0e7ce4f61d833b49911d7b11 (tree331e46081ec8938b3ffcdee3b8dbebf905c3dbd2). Its qualification head55c7d6e3d570c585185e932afaf20c778ca5a1a6 (tree801db1f2a22f070f1eb14760bb6aa4e691da97f6) has byte-identical ext7c2db3acb0121fca3e639350c629d8afb561a9f7, test28f95fb32a077e9c384573b3abeadb90c7542405, and ESLint ecacd4bd0572e1df051d2f0167d11d09d3026cf8. The new qualification is run46129519577. It is queued at publication, not passed; no ordinary browser measurements of this source exist yet. The unchanged fixed timing/control/semantic/memory gates remain in the source plan. GitHub commit/event times are authoritative; the plan's manually entered09:16 timestamp is approximately two minutes later than its actual publication09:14:23 and has no gating role.

The current-dcfc predecessor run46125980377 completed lint and main/test types, then failed the same three full-unit checks as the older9e source. It passed672files and15,174tests before the final failed summary. Complete812,120-character job log32ba0897c3e554c490dfd91729fbedd475ada890 is retained. All browser cells skipped. The real callback compatibility regression is repaired by explicitly registered immutable single-use completion owners, stored in the already imported ownership module. Ordinary callback values/objects/getters retain awaited/ignored legacy behavior. The replacement-pool test now follows recorded logical-batch dispatches and joins cleanup; its runtime cursor is unchanged. Four runtime and four test files changed, giving16product/test/config paths versus frozen dcfc. Root and independent review found no new correctness blocker; independent exact8-file byte review33aa75454bba309bb45beebc9c49222760a19278 is retained.

Current local native settlement default/reference commands exited0 against the69,068-byte WASM SHA5d216041823936521f8a70b721472fb8c42052d165d771a92b59ed967d8d2695 before the outage, but their raw JSON/log files were not retrieved. They are not claimed durably archived. Current local Vitest and lint launches exited137; no repaired full types/lint/unit pass is claimed. Final code was reconstructed from exact GitHub source and recorded edits after the executor became unavailable. The source recovery, retained failures, V8 semantic checks and these limitations are recorded in callback-compatibility-current-repair-evidence.json (54a143076148e5073f502e9caeb5df4bae5e04a3). Native fixture source is unchanged.

The source-bound current JMdict Chromium trace run46127144239/job140924149519 completed successfully: one ordinary release import on dcfc, all3parser workers,4compression workers and1import worker required and captured, original semantic/media/restart/storage gates passed, source/runtime/fixture/package guards unchanged. Artifact15256811856 is the preserved completed acquisition. Full120,253-character job log039cbe5fb48981d6d0d9cc223cfb72dd517e454c is retained. Trace timing is diagnostic and cannot establish an ordinary performance gain. An analysis-only hosted helper is being prepared to read that exact artifact because local execution is unavailable; it will not rebuild or reacquire. It will preserve raw negative V8 profile deltas while using reconstructed/sorted absolute timestamps for weighted attribution.

The separate current Node actual-parallel-worker profiling design and Node24Worker.startCpuProfile API smoke are retained as node-current-parallel-profile-plan.json (101c6c9dde131d7fceb6fcb48fe2ef73f3169f9f). No corpus/profile acquisition started from that design.

At approximately09:02UTC the executor became explicitly unavailable after transport loss. Root and agents stopped local commands. Root's attempted move of the pinned VNDB fixture from tmpfs to disk has UNKNOWN completion and no successful receipt; neither destination nor freed memory is assumed. B7 sidecar compaction was reported complete by the owning agent, but its recovery receipt will be anchored separately. Persisted source/evidence Git blobs remain available. No Work mode, CUA, production changes, merges, force pushes, or contact messages were used.

The small-tag qualification46125860840 is still in source verification. The alias browser runner is in review, has corrected its A/B toolchain comparison to exactdcfc stock blobs, and has not acquired a browser cohort. Verify and the mandatory untimed full-browser proof may run independently; every ordinary cell will require both, with per-host VNDB proof retained. No gate has been loosened and no current whole-import gain is claimed.

## Checkpoint: current tag gates and hosted browser qualification (2026-11-28 09:28:36 UTC)

Bounded tag-prefetch sourceb2a909472aa6a415a9bc0b91f7d37208390af016 passed its complete verification job140920188484 in run46125860840. Complete log498ec3485fe43477679d8d1632b1ed23a818869e and compact receipt81a6f68a2dc5d3ae50c7886086832ef7376a8953 are retained. JavaScript, main/test types,670unit files(15,156passed+47skipped),42Pythonidentity/receipt tests, and all7target build configuration dry-runs passed. The build gate is node dev/bin/build.js --dryRun --all, not proof of7emitted release archives. Actual Chrome packages are produced and guarded in the6ordinary cells, currently queued. No tag timing gain exists yet. A clean4-path product commita05325410c895542348e499ef2517bf6ab17540d (tree15747700c65a45e8ad8cf0f71a785f3bd706ee0d) was created but deliberately left unreferenced, without a PR. Its ext4f0410361a87b3639455f70ef246e4295d8f7cac, teste3127b188e0d85f855126d99cbf8d177e5c8ad9b and ESLint0da06ad87b39f658b3fe2bc4624bc3f9de616d14 match the qualification exactly.

The exact28-file VNDB browser controls were published on separate branch perf/native-record-alias-qualification-20261128-da6c4, first commit46060c7b0defec5bb36f58010d95ffe2a05c17c1. Workflow46130108071 failed validation with zero dispatched jobs and zero import observations. Six job-level env expressions used runner.temp where the documented context is unavailable. No exact annotation text was recoverable; the source defect and zero-job API result are recorded without inventing an annotation. Corrected commit1b65be131a92d1843bc47ba091bf81b3c9d757ea/treea590a8f9401f5bc039c2600f79d90d215b84ed2a changes only workflow path initialization and its manifest hash among the28controls. Source-bound failure receipt d93c50f508faa2ca070d32b783b0819ef1bfe45b and original run/jobs JSON are retained in that commit. New run46130307914 is accepted/queued with repository gate140933763930 and browser preflight140933764149; six ordinary cells require both. Actionlint46130307933 is queued. Clean alias product2c02336 is unchanged. Revised complete handoffb388de968aff622288c108267b87e08826219e3c and independent runner/API review8eadb71d4105e61f25efac00df45db96ac3fec2f are retained. All fixed timing/control/media/semantic/memory gates, per-host VNDB full proofs, safe tar transport and no-retry rules remain unchanged.

The handoff records known B7 compaction output precisely:134,717,749-byte archive SHA b808605ac2ae1d05f2a6e2536795cf4f04fc97b875c72ab9c10b43aee23f6de3, four original401,468,656-byte sidecars verified before deletion,266,750,907bytes freed. The exact local raw compaction receipt was not uploaded before outage and is not claimed available. Original content/canonical metadata and failedB6 files were retained locally; post-outage survival remains unknown. This does not replace complete hosted browser exports.

Current JMdict trace analysis-only controls are published at a4fb865b8d926053d661b3a390aed28352cc8f27, run46130295082/job140933725716, actionlint46130295098. It reads only completed acquisition46127144239/artifact15256811856 and exact acquired release/source bytes. Root and independent source review1f766168a9179bde152d5dccfefe35380c9bf3f4 completed;13authored Python tests will execute before analysis. A review correction stable-sorts ProfileChunks by(event timestamp, original event index) while retaining original chunk arrays/deltas; sample wall attribution then sorts reconstructed absolute timestamps and excludes unobserved prefix/tail. Function locations are declaration lines, not sampled instruction positions. The frozen harness stops the trace on worker-import completion before later explicit benchmark state/probe validation; actual log records the worker stop. No exact shared-clock timed-import crop is asserted and no traced cost becomes an ordinary gain. The top current parser export in raw leaf counts is parse_and_encode_term_bank_token_binary_dedup(index36); unexported indices remain unnamed until exact evidence supports more attribution.

A separate Jitendex audit39a4f824a7b7837c91f3e5b3d5ef20f251e3fe92 found historical9e140ms deferred media writes, with current relevant JS unchanged. Existing SQLite code already uses one transaction, cached prepared statements and64-row/4MiB batching(#776), plus SQL/bind reuse(#266/direct-bulk-bind). Nine-to63-row tail geometry is unmeasured. Existing external media content APIs are a separate potential route, but it changes physical persistence and is held pending current baseline-A phase evidence. No new Jitendex diagnostic or product was launched. Baseline-A receipts from the current tag cohort will be reused before considering acquisition.

Additional root novelty checks reject duplicate work: #899/#761 already fuse strict numeric projection witnesses; #735/#972 cover grammar/token-end reuse. The existing suffix-window branch7960f290 records CLOSED_NO_REVIEW_WORTHY_IMPORT_GAIN over252imports, with memory qualification incomplete/failed, and is not a new candidate. Shared compression-message batching already exists at7d4e4979 and15b77f6a; no duplicate implementation was started.

At this checkpoint repaired #977qualification55c7 is still queued. Its normalCI has some passing jobs, but static-web46129517279 failed the combined type step and exact diagnostics are being fetched. No all-gates pass is claimed; no browser cohort of the repaired qualification has started. Any necessary source amendment will be retained and bound before interpretation.


## Checkpoint: exact type repair, completed trace analysis, and VNDB setup repair (2026-11-28 09:40:05 UTC)

The #977 clean product head is now 2e82d9957e2a6d8cfe9dc713bdc3b8420f7fed5a (tree 2497bc64bbef07ad9d352b043fffa52e9a314024), with qualification head 53a00db6a070a02f40b4111d69dc439b868e1fe4 (tree 48dab59d5a412c8d9567bbc410a605837cc05cc7). The only amendment since 88add is the new callback type-assignability test: deferred/lazy/compressed callback parameter index is 3, while eager is 2; the numeric-returning function is inferred first and then assigned to the void callback type. All runtime bytes remain unchanged. Exact ext subtree 7c2db3acb0121fca3e639350c629d8afb561a9f7 and test subtree 0263e3c7b6c37045faab54d6e3e596ea3e44cef6 match between clean and qualification source. The failed predecessor type log e0080200c7d825b471a37d07938e22058340ce6e and amendment receipt a673c55d0cf6b9ef4ea5a7ca18ccc3c0dbbd9486 are retained.

Exact amended-source static-web run 46130835581/job 140935381652 completed SUCCESS. Main, test, and web TypeScript checks, 78 focused tests and all 24 browser acceptance checks passed. These include full real JMdict/Jitendex imports, checksum verification, cancellation/rollback, abrupt-tab recovery of SQL and sidecars, media, full restart/offline/delete and no uncaught exceptions. Full log adf02fcd489116952613f8a29cb69a9c738782c9 and compact receipt 246a67f9fa5118e9f5b08ee03523181282f1a4cb are retained. Full new qualification run 46130837802 remains pending. These functional results do not establish comparative import or memory gains.

Predecessor 88add runtime, identical to current 2e82, separately passed complete unit job 140931418850 (674 files, 15,186 tests passed plus 47 skipped), Test Build job 140931418589 (pinned WASM reproduction and seven actually emitted extension packages), and Chromium E2E job 140931418757 (real JMdict/Jitendex import, lookup, update, restart/deletion). Full logs 579b2a163cebca90c921f451c54c5340d7f065ef, 34bdfe021acdf45b977630087182e4143f7b2e77 and 769462621d59a80515dab8434992a8a3c6c3528a are preserved with combined receipt 5545811817e4c8cd6ab76c11dbbecc76d1155a85. Other queued 88add lanes were cancelled after the new head and its static type gate had failed. This is not a complete green predecessor CI claim. The tag qualification's seven-target dry-run remains distinct from these actual build outputs.

The analysis-only JMdict trace job 140933725716/run 46130295082 completed SUCCESS on exact research source a4fb865b8d926053d661b3a390aed28352cc8f27. All 13 Python tests passed, the frozen acquisition artifact and source/package identities were verified, and analysis artifact 15257800501 was uploaded (1,599,208 bytes; SHA256 c1c3dcd7288634238c057a08b5cfe0ffb980dd8374034afa31399415608f375a). Full log a280549674dfd898f9eafc8051944ac95733c2fb is preserved. No browser acquisition, rebuild or timing rerun occurred in this job.

Current trace diagnostics: the three parser profiles contain 9,537 samples and 2,604.430 ms of adjacent-sample wall attribution in aggregate. Fused parser/content export index 36 has 1,248 leaf samples/330.178 ms and 3,458 inclusive samples/888.474 ms. Internal indices 13, 18 and 27 under that export account respectively for 694/163.593 ms, 428/119.633 ms and 360/95.870 ms of leaf attribution. Under inflate export index 1, internal indices 49 and 2 account for 631/228.123 ms and 535/197.903 ms. They are not assigned C names without exact evidence. The import worker's canonical scan export has 322 leaf samples/96.049 ms; canonical scan wrapper inclusive attribution is 467/132.149 ms. The importer has 4,223 samples/1,141.208 ms, including 1,293 idle samples/386.209 ms. Compression profiles are predominantly idle across their four workers. These are concurrent, instrumented, all-captured-profile wall attributions, not additive CPU cost, critical-path savings or comparative speedups. No exact shared-clock timed-import crop has been established.

The pinned current parser WASM is stripped and has no name section. A narrow proposed follow-up will reproduce the unmodified pinned build, rebuild separately with only the strip-all linker argument removed, and require byte-identical ordered noncustom sections before assigning any internal symbol. It will reuse the completed trace analysis and acquire no new imports. It is prospective at this checkpoint.

Inflate novelty checks found current source already uses libdeflate by default and already uses uint64_t machine_word_t under wasm32 with fast unaligned access. The previously studied short-copy early exit ac0894ec was a clear regression (+6.49% versus A, 0/12 faster), so it will not be repeated. Native DS, FIFO, numeric-witness, suffix-window and compression-message batching history remains retained as occupied or rejected work.

VNDB qualification attempt 2, source 1b65be131a92d1843bc47ba091bf81b3c9d757ea/run 46130307914, completed with both independent prerequisites failing at the baseline release source guard. Python AST, Node syntax and four artifact transport tests passed; actionlint run 46130307933/job 140933764049 passed. Neither prerequisite acquired any import, and all six timing cells were skipped. The original guard did not record git porcelain, so the complete dirty-path set is unknown. Full verification/preflight/actionlint logs and complete outcome 435935961767232a249474a453d6761624a7aa87 are preserved.

A concrete setup defect was independently confirmed: a top-level node_modules symlink is not ignored by a directory-only node_modules/ Git ignore rule. Source cfa026b01684ff4815e2fbfe12c70a8448a6637a (tree 40e3deba69effa1eef1b3bf0947455931d83f5ac) replaces it with the stock hardlink-copy real directory and adds a focused temporary-Git regression test. It records raw porcelain, staged/worktree diffs and generated-file hashes before dependencies, after dependencies and after build. The original zero-dirty guard remains fatal; no tracked change is restored or ignored. Runtime, fixed protocol, numeric gates and acquisition schedule are unchanged. New runner 870e1ed48d95202f582c77b99041bf96e3693fd3, test fa0bb6ccde072758cb71545279df841e9d75d83e, plan 0a1b30ecd61e795d4e2a0c688218b383bad6fb6a and manifest bb966fc57ea4fba91104c2c281d6eb9a8c6756f3 are fully mapped in handoff 19cafac8b8779ce40ad6ab56fea0de15130b95bd. Current clean product 2c02336 is unchanged. No VNDB product PR or whole-import gain is claimed.

Local execution remains unavailable, and no executor probes have been made after the explicit outage. The fixture move and local receipt survival remain unknown. All new publishing and evidence recovery used source-bound GitHub operations. The user-authorized work continues; no Work mode, merges or force pushes are used.

## 2026-11-28 10:07:02 UTC: completed negative tag result and current qualification checkpoint

The bounded tag-prefetch candidate is rejected for a product PR. Both current JMdict cells in run 46125860840 completed all 36 prescribed timing observations, all semantic checks, and the separate four-observation memory screen. Independent full-artifact recomputation, with every member CRC/hash checked, retained all observations and exactly reproduced the seeded paired bootstrap:

| JMdict cell | Paired median ms / % | Equal-work % | Faster / 12 | 95% paired median % | Identical-code control median % |
| --- | ---: | ---: | ---: | ---: | ---: |
| AB | +11.75 / +1.301336 | +1.010856 | 4 | [-1.628237, +4.682455] | +2.724755 |
| BA | -6.65 / -0.816772 | -0.831112 | 9 | [-1.165722, +0.067737] | -1.119780 |

Neither cell clears its predeclared timing gates. AB regresses; BA's confidence interval includes zero and its identical-code control exceeds the apparent benefit. No unchanged retry, host pooling, observation exclusion, threshold change or favorable non-target result can turn this into a qualified JMdict gain. Full job logs, raw observations, package/source identities, phase counters, memory receipts, archive member hashes, reproducible independent audit and sanitized audit inputs are retained under `builds/perf/import-overlap-20261128-da6c4/tag-completed-jmdict/`. Original ZIPs remain GitHub Actions artifacts 15258606134 and 15257688856; this checkpoint does not claim their ZIP bytes are Git-anchored.

The ordinary baseline-A observations expose a stable JMdict record-close region: medians 111.95 ms (AB) and 115.30 ms (BA), over the twelve prescribed A observations per host. These overlapping diagnostic counters are not independently removable CPU time. Existing 8 MiB local checkpoint study 0c63c2ba0e582ce02f61dca6a5d52c93742302d6 was already rejected in its retained 20261120 report. The distinct existing shared-compression-index-worker candidate dc482f58e9d84ff984ca615530b196fa24d56725 was independently checked from completed current-baseline run 46126663964: all six B/A pairs on each JMdict host regress; paired medians +6.298466% and +6.863308%. This read-only duplicate check retains full logs and all timed records and does not claim a full artifact or memory audit. Do not duplicate either mechanism.

Owned-overlap clean head is now 54844293b8ea82350531b8da92336b325d5ab7ec, qualification c98110712296be803fcb30b9295bb11c7d0b44bc. The three-file amendment only repairs test lint; runtime remains identical to 88add36. Prior failed lint output and the precise amendment are retained. Current verification job 140939372876 in run 46132124178 succeeded. First completed JMdict AB browser job 140941694500 reports a -0.052475% paired median, +1.178284% equal-work change, 6/12 faster pairs, confidence interval [-1.335524%, +1.280412%] and +1.653702% identical-code control median. Memory passes. Full artifact audit and opposite-order/non-target cells remain in progress; this first result does not meet promotion gates. PR #977 remains draft.

VNDB raw-alias attempt 3 retains the clean dependency-copy checks but stops before imports on generated-bundle identity. Both full logs and the 18-member exact mismatch inventory are preserved. No product performance conclusion is drawn. A bounded reconstruction has reproduced the natural and hosted bundle hashes from the known generated dependency-path labels; a separate reviewed source-bound repair is being prepared without weakening runtime/semantic gates.

The current parser symbol-recovery control completed successfully: original pinned build and separate stripped reproduction both match the traced SHA256 5d216041823936521f8a70b721472fb8c42052d165d771a92b59ed967d8d2695, all nine ordered noncustom sections match the unstripped symbol build byte-for-byte, and 52 emitted function names are recovered. Seven focused tests and actionlint passed. This identifies functions, not inlined instruction lines or removable wall time. Full success log and receipt are retained.

## Completed current JMdict owned-overlap result: reject and close #977

Both current JMdict cells of run 46132124178 completed the original 36-observation schedule and separate four-observation memory screen. Independent full-ZIP audits verify exact archive identities, every member CRC/hash, every prescribed observation and source/package receipt, semantic equality, and exact paired/bootstrap arithmetic. No observations were excluded, reacquired or pooled.

| JMdict cell | Paired median ms / % | Equal-work % | Faster / 12 | 95% paired median % | Identical-code control median / equal-work % |
| --- | ---: | ---: | ---: | ---: | ---: |
| AB | -0.35 / -0.052475 | +1.178284 | 6 | [-1.335524, +1.280412] | +1.653702 / +1.492707 |
| BA | +15.40 / +1.867625 | +1.515092 | 3 | [-0.323900, +4.217975] | +0.776313 / +1.357110 |

Both hosts fail every frozen JMdict timing criterion. Both semantic/memory screens pass. This is a completed negative whole-import result despite the earlier favorable standalone compression component. Close #977 without merging or promoting the unchanged design. Remaining Jitendex/VNDB acquisition/audits continue for completeness and cannot rescue the failed primary timing decision.

The overlap mechanism is active: in all 24 candidate primary observations the sum of chunk-sink durations exceeds the entire term-file phase; none of the 24 baselines show this. Candidate parser-worker-wall medians increase from406.45 to428.25 ms (AB) and536.95 to587.55 ms (BA); the whole term-file phases change485.5 to483.5 and633.5 to640.5 ms. These overlapping clocks suggest contention/queueing as a follow-up hypothesis, not additive CPU costs or proof of a particular causal bottleneck. All raw per-observation metrics are retained. There is no basis to label this an accidentally disabled optimization or retry the same source.

Current qualification verification is now fully source-bound and archived: 674 unit files,15186 passed/47 skipped, JavaScript lint, main/test types,42 Python receipt tests, and all-target dry-run validation. This gate does not claim seven emitted release packages. Restored native settlement raw JSON/log evidence supplements the original31/31 default/reference success on the prior compatibility-repair tree; it does not retroactively claim a latest-head local rerun.

Current tag Jitendex artifact audits complete the two cells: AB -0.174387% median/-2.313635% equal-work, BA +0.159062%/+0.454767%. AB passes the registered non-target screen; BA fails its upper95≤3% bound (+3.968980%). Both memory screens pass. All72 observations, raw phase evidence, controls, tails, archive/member hashes and exact auditor are retained. The registered tag plan has no separate numeric control threshold. The12.5 ms media-write median on each host, with the229 ms AB A outlier retained, does not justify a new storage-layout implementation.

The VNDB generated-bundle discrepancy has a complete read-only proof: all18 natural and18 hosted hashes reconstruct exactly from645 generated dependency-path spans. All nine sourcemaps differ only in sources paths; zip/resvg (the two mismatched reachable bundles) have exactly identical executable ASTs. Other four AST differences are restricted to70 recognized sole __commonJS callback source-label keys. A fresh esbuild0.25.1 write:false build reproduces all18 surviving outputs;297 actual inputs and compiler/package hashes are bound. Raw reconstructions and failed diagnostic attempts are preserved. A narrow fixed-pair source guard is being prepared; no generated runtime bytes or product sources were changed.

A distinct native parser experiment is now being developed from the full exact current corpus census. The existing compact-glossary helper accepts286214 rows; structured lists alongside notes/references account for73626 missed rows and42.94MB of glossary text. Reusing the same child-list grammar inside the general scanner is a hypothesis only until correctness, component measurements and separate complete-browser qualification pass.

## 2026-11-28 10:38 UTC — complete negative cohorts, narrow setup repairs, and a new native screen

Owned-overlap PR #977 remains closed. The independently audited Jitendex AB cell has paired median +0.792336% and equal-work +0.736097%; its control equal-work +1.002052% fails the fixed 1% control gate without rounding. BA has paired median -0.275337% but equal-work +3.875332%; both BA controls fail. All72 ordinary observations, both large tails, original phase receipts, exact source/semantic proofs and both memory passes are retained under owned-completed-jitendex. VNDB jobs are now both terminal: AB140941694505 failed and BA140941694488 succeeded; raw artifact audit remains pending. These do not reverse the complete negative JMdict decision.

The complete tag-prefetch VNDB audit is negative on both hosts: paired median +1076.8ms/+18.870590% (AB) and +1072.45ms/+19.247247% (BA), with 0/12 faster pairs each. All72 timing observations and logical/source checks passed. AB memory sampling fails the registered250ms maximum-gap rule in3/4 observations, so its aggregate effect is null. BA qualifies all4 observations but regresses PSS median86.481075% and private median106.935280%. No observations or outliers are excluded.

Root source review identified a concrete defect in this unmerged tag experiment: its new BoundedZipTextWriter is not accepted by the dense ZIP native read path, which recognizes only TextWriter and Uint8ArrayWriter. Prefetch therefore initializes the full147237-entry fallback map before terms. Dense admission requires at least128MiB and8192entries, excluding current JMdict/Jitendex ZIPs. The finding cannot rescue failed JMdict tag-prefetch results. Two corrected, actually admitted stored/DEFLATE dense fixtures fail on the original experiment and pass after the six-line writer admission/guard repair;103 focused tests across5 suites pass. Initial invalid fixture/CLI attempts and two lint processes killed by the environment remain in the receipt. No lint success, attributable latency/memory amount, full fixed-experiment performance, standalone baseline bug, or PR is claimed. Exact repair source and all negative raw artifacts are anchored under tag-completed-vndb and tag-dense-integration-repair.

Clarification to the preceding JMdict census:286214 existing whole-list matches is the media-hints-on count; media-hints-off accepts286227. The new guarded embedded child-list helper is a different path. It executes after reuse on66897 lists/11977682 source bytes, after54641 reusable glossaries, with212262 probes and208562 general composite calls. Untimed final-module gates pass73 focused tests,960 native differential strict/permissive and media-mode cases, and exact53-bank/12-group/528299-row output equivalence among stock, release candidate and counter builds. Stock LLVM21 reproducibility also passes. No raw morphology percentage is presented as executed production coverage.

The final native component was frozen before timing in plan4b014a1ee26e5db4e4dd458e0f955c91b4602ef0 and independently reviewed in50743676d4e17f5d96e1aa520505a407180cef8b. Its exact candidate C/WASM/manifest/test and all controls are anchored under jmdict-child-list-native-v1. It runs one fixed36-observation,12-balanced-round ABC schedule with fresh processes, both controls on identical dcfc02a bytes, no counter instrumentation, exact full output receipts and no replacement runs. Promotion requires at least3% paired native improvement against both controls,9/12 faster pairs each, negative95% bounds, equal-work improvement, low control drift and no more than1% full-group equal-work regression. This is a warm serial native component, not complete-import qualification. Later f28c280 changes storage/runtime but not these C/WASM baseline bytes; any browser experiment must freeze its own current base. Acquisition is in progress at this checkpoint; no result or PR is claimed.

Alias attempt4 eaee9b0/run46134500034 is fully preserved under alias-hosted-attempt4. Both real full-media browser imports and separate6648310-row persisted verifiers exited0 and matched their own historical natural five-file witnesses. Overall preflight failed at the cross-arm probe projection, with exactly20 rawContentPreview differences under investigation. Original complete projections and physical file evidence remain intact. The six ordinary/memory cells were skipped, so there are zero ordinary performance observations.

The independent verification job passed28 source-guard tests, package equivalence, JS/main/dev/test/bench types and the remaining static lint stages, then failed4 new ownership fixture cases (15185 passed/47 skipped). Root reviewed an actual4CPU reproduction:3 parser workers produced only3 fixture sources, below the existing4-source admission requirement. The single test-only Math.max(4, workerCount) repair passes all4 cases. Clean product branch now advances2c02336 to cce6353276f92b80fc6c377bf543354ea59edce3, tree b65955a62da72c55e24a681011684601fa089f07. Runtime ext subtree64089ebc7f3b247b3a0d5e1cb0e58e64f73b75a1 is identical. Historical natural B7 source identity stays2c02336; a prospective test-only descendant amendment is being prepared with unchanged numerical gates. No qualification restart has occurred yet.

## 2026-11-28 10:58 UTC — completed owned-overlap audit; rejected native screen; separate tail candidate

The owned-overlap campaign is now complete and independently audited across all three corpora. VNDB AB retains all36 ordinary observations with median -42.95ms/-0.712594%, equal-work -0.989387%,8/12 faster and95% interval[-4.019967%,+0.944741%]; its non-target timing/control gates pass, but all4 memory observations exceed the fixed250ms coverage gap (292.784/273.927/340.611/277.381ms), so qualified maxima and effects remain null. VNDB BA regresses+141.10ms/+2.771786% median and+2.624874% equal-work,2/12 faster, interval[+1.308175%,+4.153179%]. Its median identical control+1.0964476% also fails the exact1% gate. BA memory passes (+3.037480%PSS/+3.274626%private median). Both313-member ZIPs and every source/package/WASM/semantic/lookup/restart/all-media/memory receipt reconcile. Complete raw envelopes, auditor and logs are anchored under owned-completed-vndb. No host/corpus pooling, replacement or favorable rounding changes the rejected JMdict primary decision or closed PR977.

The new embedded child-list native v1 screen completed all36 frozen observations and exact53-bank/12-group output/source checks, but FAILS its predeclared advance gate. B/A paired native median -1.7628%/-6.062ms has only6/12 faster pairs and95% interval[-13.7578%,+13.2737%]; B/C is-7.4718%/-26.221ms,8/12 faster, interval[-14.7069%,+3.0271%]. Native equal-work changes are-0.918%/-7.115%. Identical C/A control drift is+1.8272%median/+6.6715%equal-work, exceeding the0.8814% half-smaller-benefit limit. Full-group wall changes-4.975%/-9.373% cannot substitute for the failed primary/control gates. Independent arithmetic recomputed all20000 shared-round bootstrap samples and found zero discrepancies. Complete137-member source/log/observation/failure archive and portable independent audit are anchored. This is inconclusive, not a gain; no unchanged rerun or browser promotion is authorized.

Alias qualification repair5 is prospectively published at6594b22915ee717b4009e414a299007badfb25f6, tree e839aa5615a6c65c811733b710878ff3a4fe4ac7. Its runtime candidate is the explicit test-only descendant cce6353276f92b80fc6c377bf543354ea59edce3, while the historical natural B7 remains2c02336. Root checked all12 final source files by bytes/SHA256/Git blob, reviewed the exact identity and probe code, verified unchanged ordinary observation() text and recursive numerical-plan equality, and retained both independent reviews. The helper recomputes physical digests from raw probes; validates29 saved byte ranges/132 compact references; permits only the original170-span uint64 pointer relocation; and compares every future complete raw preview against its own arm. Stable row IDs, expressions/readings, decoded content, error fields, direct hits, ordering and restart state are strict. All34 combined source-bound tests pass. The corrected binder accepts original attempt4 saved files, but that retrospective analysis does not turn the failed workflow into a pass or qualify the new test-only source. Fresh hosted verification/full-browser preflight precede every ordinary cell. No timing was acquired during the repair.

A materially different owned-tail candidate is frozen on later develop f28c2801fcfd9416f220b46b9cbafeee901c1cb2 at cb77c4727d0bfd5175aa3684395a66e9887bfe64, tree c89d9747a4e1836913e98497d7c3613d0f115eee, branch perf/jmdict-tail-overlap-20261128-da6c4. The exact548 ownership/completion delta was three-way integrated while preserving #981 changes. It retains a second owned storage callback only after every parser result has actually arrived and passed existing error/profile/row checks. Assigned-but-pending work and synthetic failure slots do not count. It adds no wait for all results or worker-loop completion, so borrowed leases and lead windows cannot create a new barrier. Existing two-owner, ordered retirement, cancellation, rollback and byte-budget behavior remains. The scalar lookahead diagnostic counts admission before prior owner retirement, not necessarily simultaneous CPU execution. Two Vitest tests exercise19 extracted production-control-flow scenarios; all pass on the final source. The original full-overlap implementation fails the new before-all-results behavior check. Exact interim/final source hashes, tests/logs, source manifest and bounded independent review are anchored under tail-prototype. Broader source/browser qualification remains pending, with a separate JMdict-first protocol being prepared:24 pairs/8 controls/4 warmups per opposite-order host, original10ms/1%effect requirement scaled to18/24 faster pairs, strict CI/control/memory checks; non-targets run only if both JMdict hosts pass. No new PR is open for this candidate.

A fresh untimed baseline census identifies208562 remaining generic glossary scans/61.30MB and10.197M loop iterations after existing reuse/whole-list dispatch. The extra short-adjacent-reuse opportunity is only5422 generic rows/1.143MB/~168794iterations, so threshold tuning is rejected without implementation. Static data/style whole-object matching was found already in old c8acce2669 for two literals, with an old uncontrolled four-pair JMdict screen slower3/4. A19-literal table would extend that occupied family; it was not implemented. A different direct grammar for compact flat string-valued metadata objects is only under source/novelty review, with no code or measurement yet. Corpus morphology and instrumented counts are work evidence, never latency claims.

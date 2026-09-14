# Codex handoff: implemented import experiments

## Objective and status

Four **default-off runtime flags are implemented**, not proposed placeholders. Qualify them against the selected `develop` head before enabling anything. Prioritize full import completion time, then lookup latency. Memory and stored dictionary size are non-regression gates, not resources to trade freely for throughput.

The implementation is based on `ManabiIO/manabitan` commit `8bd9c56d419d4493c0602b58c2070b2b336840c0`, tree `6ab2fc9ac92a6c6c15c1625eb5838a5c2f634df4`. This includes the reliability changes after the previous `3a125475...` review. The complete local baseline tree was reconstructed and matched against every remote Git blob. Local reconstructed commit IDs are aliases, not the remote commit ID.

Read `git log` and record the exact candidate revision before testing. Do not mix results from intervening development changes. This handoff replaces the earlier implementation-proposal document. Historical prototype measurements are not measurements of this implementation.

## Implemented flags

| ImportDetails flag                   | What it does                                                                                                                                                                                            | Important limits                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `experimentalTermBankSpans`          | Keeps CRC-verified inflated banks intact in one arena; removes the pass moving their interiors into joined JSON. The fused parser and its non-fused fallback traverse independently bounded bank spans. | Most promising on the compressed-source route. Does not force that route, alter grouping, or widen source budgets.                                                                           |
| `experimentalNativeEscapedKeys`      | Decodes exceptional JSON expression/reading keys in the unused interner tail, then interns their decoded UTF-8 bytes without restarting the group.                                                      | No separate key scratch allocation. Invalid raw UTF-8, key-length limits, or exhausted interner capacity retain the established fallback. Requires a fused group.                            |
| `experimentalValidatedGlossaryReuse` | Reuses a successful prior row's glossary validation and hints only after full byte equality, bounded to the current bank. Carries that equality witness to later content deduplication.                 | The existing four-row window is unchanged. Samples only reject candidates. Unique/common-prefix inputs remain negative controls; do not enable broadly on repeat-heavy wins.                 |
| `experimentalFusedSingleBank`        | Removes the existing multi-source-only restriction on fused parse/intern/encode/dedup for otherwise eligible single-bank groups.                                                                        | This is the additional structural experiment from the second review. It changes neither group sizes nor worker counts. Measure its larger native reservation versus avoided JavaScript work. |

All four default to `false`. Only the boolean `true` enables a flag. They are ephemeral `ImportDetails` fields, **not new persisted settings or UI controls**. Snapshot them before import work, propagate them through the existing source pipeline and actual worker request, and reset them for subsequent imports/worker requests. Native flags are per-call bits, not mutable C globals. Single-bank admission is decided in JavaScript.

Do not assert that a requested flag executed merely because it appears in a report. For example, native escaped-key handling does no work when the corpus has no escapes, and a single-bank group without fusion cannot exercise the native glossary experiment. Use the execution counters below.

### Integration map

- `types/ext/dictionary-importer.d.ts`: typed optional flags.
- `ext/js/dictionary/term-bank-experiments.js`: strict immutable snapshot and native bit mask.
- `ext/js/dictionary/dictionary-importer.js`: per-import snapshot, parser options and diagnostics.
- `ext/js/dictionary/term-bank-wasm-parser-worker.js`: worker snapshot, source inflation, column parsing, existing ownership and lookup preparation.
- `ext/js/dictionary/term-bank-wasm-parser.js`: source spans, admission, bounded allocation, fallback, metrics and worker-profile aggregation.
- `ext/js/dictionary/wasm/term-bank-parser.c`: independent-bank cursor, exceptional decoder, validation witness and fused implementation.
- `test/term-bank-experiments.test.js`: flag matrix, differential, worker, boundary, ownership, fallback and growth regressions.

Rebuild generated libraries after changing the C source. Existing WASM entrypoints accept additional trailing arguments; old calls that omit them have zero-valued arguments. Generated WASM, dependencies and fixtures are not committed as experiment source changes.

## Correctness boundaries already addressed

Bank transitions retain one group-wide interner, content deduplication table, canonical output cursor and ordered row stream. All offsets remain relative to the source arena. Each token is nevertheless bounded to its own bank; even an early fused failure cannot join malformed separate banks into a valid document. The ordinary fallback uses the same independent-bank cursor. Preloaded fallback input is owned before heap reset, and the span boundaries survive that reset.

Archive CRCs still cover original bank bytes. Compression methods, exact compressed consumption, decoded sizes, wrappers, nesting and JSON grammar remain validated. No cache budget, worker count, source cap, compression level or persistent format changed.

Escaped UTF-16 pairs become UTF-8; lone escaped surrogates match `TextEncoder(JSON.parse(token))` replacement behavior. Invalid raw UTF-8 in an exceptional token retains the established replacement-decoder fallback. Decoding uses unused space in the existing interner rather than a separate 64 KiB scratch buffer. Duplicate decoded keys leave that tail available. Running out of space falls back without overwriting earlier keys.

**Do not recompute the raw-reading equality flag from decoded interner indexes.** Literal and escaped tokens can decode to the same key while the established fallback represents an explicit reading separately. The fused C flag is retained through JavaScript row projection. Tests compare that flag and persisted lookup-sidecar bytes as well as displayed key strings; comparing only rendered strings would miss this regression.

Glossary equality does not imply equal rules/tags or equal entire term content. Reuse is restricted to successful earlier rows in the same immutable input lifetime. Full comparison is required; suffix/middle samples are reject-only filters. The equality witness eliminates a redundant later comparison only for the exact witnessed row. Surrounding row fields and delimiters are still parsed.

## Diagnostics and activation proof

The parser profile includes:

```text
experiments
fusedParseAttempts
fusedParseFallbacks
discardedFusedParseMs
discardedFusedRows
bankSpanCount
escapedKeyDecodeCount
validatedGlossaryReuseCount
fusedSingleBankGroups
maxWasmHeapBytes
```

Failed fused work is included in the final allocation/copy/parse totals rather than being silently replaced by the recursive fallback's profile. This does not make overlapping phase totals additive end-to-end time.

Each `term-file-fast-path:*` diagnostic includes `parserExperiments`, `parserFusedAttempts`, `parserFusedFallbacks`, `parserDiscardedFusedMs`, `parserDiscardedFusedRows`, `parserBankSpanCount`, `parserEscapedKeyDecodeCount`, `parserValidatedGlossaryReuseCount`, `parserFusedSingleBankGroups` and `parserMaxWasmHeapBytes`.

The overall summary exposes corresponding `fastPathParser*` fields plus requested/effective snapshots. **Those summary fields refer to the last fast-path profile, not automatically every batch in the import.** For import-wide accounting, aggregate the disjoint per-file/group reports once; do not count both those reports and their aggregate profile. Worker aggregation sums work counts and takes the maximum individual heap size. That maximum is **not** total resident memory across concurrent workers.

Use counters to prove activation, fallback and meaningful opportunity size. A zero-escape dictionary cannot establish an escaped-key speedup. A request which fell back to an unrelated importer is not a successful experiment measurement.

## Local validation and evidence boundaries

The focused suite has **64 new tests** and **463 passing tests including the existing parser, scanner and composite-state suites**. It covers all 16 flag combinations across ordinary and compressed source routes, multi-chunk content offsets, growth, all-empty banks, metadata-capacity fallback, exhausted interner space, early/late escaped keys, CRC/size/truncation/trailing bytes, malformed cross-bank input, same-length glossary mutation, hint propagation and differing tags/rules.

An actual `worker_threads` bridge runs the production browser-worker module. It tests enabled/default/enabled/default requests, owned key retention, equivalent literal/escaped reading aliases, and byte-identical persisted lookup sidecars. This is real worker-module execution and structured cloning on Node, **not browser extension/OPFS execution**.

One test compares 4,096 deterministic mixed UTF-16 keys against the independent JSON.parse/TextEncoder oracle. A separate retained ASan+UBSan harness tests the exact exceptional-key C helper with 4,485 valid/invalid/capacity cases and leak detection. That sanitizer claim covers the extracted decoder helpers, not the entire browser/WASM pipeline.

A full intermediate-source local unit run reported 6,318 passed, six failed, 46 skipped, plus one unhandled error. The same six failures and unhandled error reproduce in the untouched baseline's two affected offscreen suites. The failures concern changed import/lookup queuing expectations and missing `chrome.runtime.getURL` in an offscreen mock, outside this patch. Do not turn this into an all-green claim; final-source execution and remote qualification records supersede this intermediate run.

The separate options suite passes 27 tests; all-target dry builds pass. Read the delivered logs for final-source type/lint/unit results rather than inferring them from older runs.

The evidence archive contains a reproducible synthetic component runner, complete raw observations, source/WASM/runner fingerprints, and the native sanitizer harness. Its timed boundary is resident prepared fixtures through optional inflate+CRC, column parsing and completed lookup-sidecar preparation. Fallback JavaScript lookup preparation is included so both arms perform equal work. Fixture creation, compression for fixture preparation, and validation digests are outside timing. One full excluded warmup occurs in each fresh child process.

**This is not a whole-import benchmark:** no worker IPC, global persisted deduplication, Zstd output compression, OPFS, browser UI or cross-device measurement is included. Its after-parser memory sample and lifetime maxRSS include different boundaries and must not be relabeled whole-import peak memory. Keep same-binary controls and all unfavorable observations.

## Completed final-source component comparison

Linux x86-64, Node 24.20.0, clang 17; eight fixed alternating pairs per cell, one excluded full warmup per fresh child. Negative is less elapsed time. These results include the final contiguous-fallback and reading-alias fixes. Source, runner and WASM fingerprints are retained with every cohort.

| Experiment / workload                | Paired median change | Equal-work total change | Faster pairs |
| ------------------------------------ | -------------------: | ----------------------: | -----------: |
| same-binary-aa / structured-ordinary |               +1.27% |                  -1.61% |          3/8 |
| source-all-off / structured-ordinary |               +2.02% |                  +1.77% |          3/8 |
| source-all-off-unique / unique       |               -3.41% |                  -5.06% |          6/8 |
| source-all-off-single / single-bank  |               +0.32% |                  +0.28% |          4/8 |
| spans / structured-deflate           |              -16.96% |                 -20.76% |          8/8 |
| spans / structured-stored            |              -13.72% |                 -12.22% |          8/8 |
| keys / escaped-first                 |              -51.34% |                 -50.40% |          8/8 |
| keys / escaped-last                  |              -62.04% |                 -63.49% |          8/8 |
| reuse / structured-ordinary          |              -19.92% |                 -19.72% |          8/8 |
| reuse / unique                       |               +3.80% |                  +0.81% |          3/8 |
| reuse / common-prefix                |               +7.77% |                  +7.18% |          0/8 |
| single / single-bank                 |              -37.13% |                 -38.32% |          8/8 |

The initial all-off single-bank comparison raised an overhead concern. The final implementation restores the established contiguous fallback loop and selects span traversal once per call. The final all-off single-bank comparison is approximately flat at this sample size; it is not a cross-device equivalence proof. All earlier runs, including unfavorable observations and a failed equal-work verifier setup, remain separate historical evidence.

The final enabled native-key cells use 640 KiB more WASM high-water space than their fallback controls, while their median after-parser RSS samples are lower. Single-bank fusion uses 1,920 KiB more WASM high-water space; its after-parser RSS samples are also lower. These samples do **not** establish lower whole-import peak memory. All-off and span/reuse pairs have identical observed WASM high-water sizes in this fixture set. Encoded unique-content byte counts and complete logical-content/lookup-sidecar digests match within every completed pair.

**Hold glossary reuse for broad activation:** all eight common-prefix pairs are slower. Keep the other experiments default-off until real-dictionary end-to-end and memory/lookup qualification completes. Component percentages must not be quoted as browser import gains.

## Benchmark execution

### Pin and build first

Use the existing repository toolchain and immutable fixture lock; do not upgrade dependencies as part of measurement. The reviewed setup uses Node 24.20.0. Record compiler, browser, CPU, cgroup limits, source tree, lock hashes, effective options and actual source route.

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

The locked dictionaries are JMdict (526,942 term rows), JMnedict (667,942), and Jitendex (435,448). `test/perf/dictionaries.lock.json` remains authoritative for ZIP hashes, exact metadata and versions. Do not silently download a newer fixture.

### Run functional coverage before interpreting timings

```sh
npm test
npm run test:playwright:integration
npm run test:e2e:chromium-extension
npm run test:e2e:firefox-extension
node node_modules/vitest/vitest.mjs bench --run
```

Also run the focused regression matrix after each implementation change:

```sh
node node_modules/vitest/vitest.mjs run \
  test/term-bank-experiments.test.js \
  test/term-bank-wasm-parser.test.js \
  test/term-bank-composite-state.test.js \
  test/term-bank-parser-string-scan.test.js
```

Do not stop after the first unrelated baseline failure and call the remaining suites tested. Record individual statuses. Reproduce baseline failures on the exact baseline; preserve failures instead of deleting tests, weakening assertions or suppressing errors.

Run browser functional scenarios with all experiments enabled as well as defaults. Existing Chromium automation accepts `MANABITAN_E2E_IMPORT_FLAGS_JSON`; use it to propagate flags through the actual import UI and assert execution counters. Do not assume the Firefox harness consumes the same override without checking its code. Add explicit coverage there when needed, rather than claiming an ignored environment variable tested the flags.

### Three distinct comparisons

1. Original baseline source versus the new source with **all flags false**. This catches overhead from the refactor itself. Build separate worktrees with identical toolchains. Same-binary flag comparisons do not replace this gate.
2. Same candidate binary, all flags false versus **one flag true**.
3. Same-binary A/A controls with identical options.

Pre-register a fixed plan, at least 12 adjacent alternating AB/BA pairs per dictionary/runtime cell, excluded warmups and interleaved A/A controls. Reverse initial order in an independent replication. The existing runtime A/B wrapper does not automatically provide every part of that protocol; extend its driver or orchestrate immutable worktrees without changing the timing boundary.

The following commands use implemented runtime flags and the existing A/B entrypoint. Add the independent source/A/A plan around them:

```sh
for dictionary in jmdict jmnedict jitendex; do
  node dev/perf/import-ab.js "$dictionary" --pairs 12 \
    --flags '{}' --label same-binary-aa
  node dev/perf/import-ab.js "$dictionary" --pairs 12 \
    --flags '{"experimentalTermBankSpans":true}' --label bank-spans
  node dev/perf/import-ab.js "$dictionary" --pairs 12 \
    --flags '{"experimentalNativeEscapedKeys":true}' --label native-escaped-keys
  node dev/perf/import-ab.js "$dictionary" --pairs 12 \
    --flags '{"experimentalValidatedGlossaryReuse":true}' --label glossary-reuse
  node dev/perf/import-ab.js "$dictionary" --pairs 12 \
    --flags '{"experimentalFusedSingleBank":true}' --label fused-single-bank
done
```

The timing boundary must remain browser file-input change through current-operation post-UI completion. No tracing, screenshots, process sampling or verbose debug instrumentation during authoritative timing. Profile and measure memory separately. Do not infer CPU time by summing concurrent workers' wall times or profile sample counts.

Report per-pair ratios, median paired change, total time across equal work, uncertainty intervals, worst pair and control variation. Keep slow tails and failed observations. Incomplete plans receive no accepted effect estimate; do not splice runs or stop when a favorable result appears.

### Interaction matrix and workloads

Only after individual experiments survive, measure spans+keys, keys+single, spans+single, and the all-enabled combination. Reuse must also survive unique and common-prefix negative controls in those combinations. A faster bundle must not conceal a regressing individual flag.

Cover real native constrained hosts and higher/unknown-memory routing; single/multibatch imports; compressed and ordinary input; many tiny banks; large banks; duplicate-heavy and unique content; text normalization and media; early/late escaped keys; malformed input; canceled/failed imports; updates and reimports. Observe actual page AND worker capability values. Device-memory emulation is not a substitute for physical memory pressure.

Add dictionaries with genuinely frequent escaped keys and representative single-bank group distributions. Keep adversarial synthetic cases distinct from corpus-wide estimates; do not replace production data with unusually repetitive fixtures to claim a general win.

### Memory, storage and lookup gates

Measure whole-browser/process-tree peak and steady memory, JavaScript heap, WASM high-water pages, number of concurrent worker arenas, outstanding borrowed slabs, retained bytes after release, GC and cancellation cleanup. The span table costs eight bytes per bank. Native escaped decoding reuses the existing interner tail; it does not enlarge cache budgets. Single-bank fusion can reserve more native memory even when it eliminates JavaScript work. **Do not promote it without resolving that tradeoff on complete process memory.**

Require matching logical content and lookup results across every imported row, canonical unique-content counts, persisted term-record/lookup bytes where determinism permits, actual OPFS file sizes, compressed-content totals and unchanged compression policies. Component content/lookup byte equality is not exhaustive persisted-database equivalence. The standard harness's small readability sample is necessary but insufficient.

After reopening the extension/database, measure cold/warm exact, deinflected and prefix lookups; first popup content; repeated hover; media; dictionary switching and updating. Preserve result ordering, complete definitions and crash/cancellation rollback. Import gains must not shift latency or memory into first lookup.

## Second-pass analysis and decisions

The new single-bank flag targets eliminated passes and boundary work, not larger reservations as a tuning strategy. Keep it independent so its saved parse/encode/intern work and native memory costs can be attributed separately.

Native escaped-key decoding was further refined to use the interner tail, removing both the separate scratch allocation and the copy into the interner for newly decoded keys. The equality-witness path removes a second glossary comparison only when an exact earlier comparison already established it. Neither refinement changes persisted formats or expands a cache.

Do not introduce shared parser/Zstd memory, another scheduler, dictionary-name exceptions, larger caches, weaker equality checks, skipped archive validation or a new persisted representation in this round. Zstd dictionary/context reuse and parser-to-compressor ownership are possible future profile targets, but existing context reuse must be audited first; changing ownership or compression output without evidence is not an additional accepted optimization.

Preserve accepted miniz, local composite state and multibatch routing. Do not revive rejected SIMD hashing/scanning, ZIP splitting, aligned-copy/gather or old-stack packing variants. PR #19's withdrawn UI timings remain withdrawn. No Reader native importer, vendor pin or release branch is part of this work.

## Completion criteria

Return the exact selected revisions, per-flag activation evidence, complete raw comparisons, separate memory/profile results, full correctness status and an **accept / hold / reject** decision for each flag. Require a material full-import benefit or removal of a real severe exception-path cliff with negligible ordinary-path cost. Treat all-off source overhead, memory, storage and lookup regressions as blockers even when enabled component timings improve.

Keep all defaults off until qualification is complete. The code is a runnable experiment platform, not release approval or a general speedup claim.

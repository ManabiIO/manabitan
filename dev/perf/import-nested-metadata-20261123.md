# Reusing validated nested metadata during dictionary import

## Status

Candidate implementation; complete-fixture differential validation passes, hosted browser qualification is pending. No complete-import speed claim is made. Cache admission, capacity, and replacement policy are frozen before timing.

Baseline: `5e1f8c12f7ff798ba407323aff675cb23b22af02` (`develop`). This branch is independent of the current outer-row parser, leading-string, source-read, and content-ownership candidates.

## Problem and change

JMdict and Jitendex repeat small `data` and `style` objects inside otherwise distinct structured glossary entries. Their bytes still need to be read, but a successful prior validation can avoid repeating the JSON state-machine work for the same complete object.

The fused native parser learns successfully validated flat object values of literal `data` and `style` keys. Eligible objects contain only primitive JSON values and occupy 16–512 raw bytes. A call-local cache has eight sets of four witnesses. The first 16 bytes choose a set and reject candidates; only complete bounded byte equality grants reuse. No hash, prefix, decoded key, or sampled comparison is sufficient by itself.

A miss uses the existing scalar/string validation primitives. Nested, oversized, malformed, and escaped-parent-key cases return to the generic parser. The normal nesting limit still applies. Each witness independently records media, whitespace-normalization, and text-normalization hints; a hit replays those hints without inheriting state from an earlier enclosing row.

The cache occupies exactly 1,040 bytes of bounded stack storage, checked at compile time. It stores source offsets, lengths, prefixes, and scalar hints, with no payload copies or persistent source references. Witnesses die at the end of each fused invocation. Two optional native scalar getters report successful last-parse reuse count and bytes; every parse entry and heap reset clears them. The existing five-word native experiment-statistics buffer ABI is unchanged, and older injected modules without the getters report zero.

## Correctness and build

The parser source is rebuilt with the pinned LLVM/LLD 21.1.8 toolchain. The manifest records the two new exports, source digest, and regenerated WASM hash. The package continues to use the pinned artifact rather than compiling an untracked binary at runtime.

Focused tests cover exact reuse, colliding prefixes, misses, truncated/corrupt JSON, scalar grammar, depth limits, escaped and duplicate keys, all three hints, required glossary fields, bank boundaries, heap reset, fallback/retry lifetime, optional getter compatibility, and the unchanged five-word statistics ABI. All 288 focused tests across seven suites pass, including the 45 new witness cases. Main/test TypeScript, scoped ESLint, all seven dry-run build targets, and a pinned reproducible WASM check pass.

Complete-fixture functional comparison against the unchanged baseline passes for both dictionaries. It checks every row's content, hashes, numeric fields, reading-equality flags, and prepared lookup bytes:

| Fixture  |    Rows | Equal output digest (SHA-256)                                      | Reused objects | Reused raw object bytes |
| -------- | ------: | ------------------------------------------------------------------ | -------------: | ----------------------: |
| JMdict   | 526,942 | `430a59f035c1e6bb66352f50b3d722b8bf853b394d56d5816f0576594e1ebb57` |        848,987 |              19,902,534 |
| Jitendex | 435,448 | `b618d21aa8c89a3f2f21613fa15c9fa8689bdd9efb991c9475e78e8ac057e805` |      1,443,267 |              42,116,210 |

This functional runner groups seven JMdict or ten Jitendex banks per call. Its cache counts describe that fixed component grouping and are not predictions for the production browser grouping. Local elapsed times are not used as performance evidence. The candidate native artifact is 58,663 bytes, SHA-256 `d5a00ed71bb1ed0bffb2f158398a3acb93d5fa968981a53e1f199856a3e42a89`, compared with the 54,596-byte baseline artifact.

## Frozen browser screen

Each of the pinned JMdict, Jitendex, and VNDB archives gets a separate hosted Chromium job. Each job has two excluded warmups, four adjacent candidate/baseline pairs, and four bracketing unchanged-code control pairs. Production import defaults are used; tracing and process sampling are disabled during timing.

The fixed order is:

```text
C1 D1 D2 C2 A1 B1 B2 A2 B3 A3 A4 B4 C3 D3 D4 C4
```

`A`, `C`, and `D` use the identical baseline package; `B` uses this candidate. Both sources receive the same measurement-only VNDB overlay. Expected packaged changes are exactly the parser JS, importer JS diagnostics, and parser WASM. Package-entry hashes and the candidate manifest are preserved with every cohort.

Timing spans file-input change to the post-UI import-complete event. All scheduled observations, including failures, are retained. Checks cover source/package identities, exact fixture hashes and rows, parser/importer work, every non-timing phase field, sampled lookup/content output, browser restart, and VNDB source-media bytes before and after restart. Metadata reuse must actually activate in both JMdict and Jitendex, with reused bytes bounded by the number and size of witnessed objects. VNDB is a negative-control corpus for the targeted workload; its actual counter values remain visible.

All phase timings are retained. Native heap capacity and new mechanism counters are reported separately from logical work equality. Queue peaks and write-coalescing counts are retained separately because they can vary with scheduling. Worker sums and wall intervals overlap and are not additive. Controls are not subtracted or pooled with candidate results.

Advance to independent confirmation only if the mechanism activates, correctness/work checks pass, and the screen indicates a plausible complete-import benefit without an unresolved regression in the other corpus. Confirmation must retain the same product bytes, use at least 12 candidate pairs on a new host with reversed ordering and unchanged-code controls, and retain every observation. A source change starts a new cohort. Component-only gains or effects indistinguishable from controls do not justify promotion.

## History and overlap

An earlier experiment, `c8acce26691`, hard-coded only two neutral metadata objects. Its four-pair screen was not promoted: JMdict was 3.59% slower and Jitendex 1.88% faster. This candidate instead learns bounded complete flat objects and preserves their hints, but the prior result makes miss/probe overhead an explicit qualification risk. Capacity and probe policy will not be retuned after seeing the cohort.

This differs from reusing top-level glossary type validation, scanning leading glossary-string runs, and specializing the outer eight-field term row. Combining independently measured candidates requires a new complete-import qualification; their isolated percentages cannot be added.

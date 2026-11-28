# Native record-field encoder: first browser cohort

## Decision

**Hold. No performance PR is justified by this cohort.** The native field encoder reduces work in its own phase, but the complete-import comparisons do not establish a reliable overall improvement. JMdict and VNDB also lack complete qualified memory coverage.

The experiment keeps the existing record format and authoritative validation. It optionally encodes eligible private Int32 score/reference columns using a small native module. Unsupported, mutable or non-integer representations retain the original JavaScript path. All source, package, semantic and timing receipts below belong to the frozen candidate, not a later repair or composition.

## Frozen identities

| Item | Identity |
| --- | --- |
| Baseline | `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` |
| Measured candidate | `731c7374dc9e1e242142796f597be9939a3cda2c` |
| Measured candidate tree | `ab5e7a2fa9a6f80ba390e55d5cb263253bbe0df5` |
| Research workflow source | `8d584d465399849de2019bec090fc62bdab345dc` |
| Workflow run | [46102045293](https://github.com/ManabiIO/manabitan/actions/runs/46102045293) |
| Native encoder module | 1,180 bytes; SHA-256 `e5945647b0130053c7f93bfd6c5f05e1db68928cdab27b281f43ffa1d3b4ce3a` |

The fixtures are the complete checksum-pinned archives from `test/perf/dictionaries.lock.json`: JMdict 528,299 rows, Jitendex 436,555 rows and VNDB 6,648,310 rows. These are pinned fixtures, not a claim about the latest upstream releases.

## Complete-import measurements

Each corpus has four excluded complete warmups, six alternating AB/BA treatment pairs, two interleaved identical-code A/C pairs, two separate exhaustive-media imports and four separate memory observations: **26 observations per corpus, 78 total**. Every browser profile is fresh. Timing covers file-input dispatch through the existing post-UI completion boundary. Memory sampling and exhaustive media verification run separately from authoritative timing.

Negative changes mean lower elapsed time. The median is calculated from individual paired ratios; equal-work compares the sums of the six complete imports. No observation was removed, retried, substituted or trimmed.

| Corpus | Paired median | Equal-work change | Faster pairs | Descriptive 95% interval | Identical-code median |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | -0.442% | -1.134% | 4/6 | [-4.228%, +1.372%] | +1.989% |
| Jitendex | +1.635% | +1.399% | 2/6 | [-1.396%, +4.068%] | -1.450% |
| VNDB | -1.142% | -1.422% | 4/6 | [-5.528%, +2.564%] | -0.099% |

All descriptive intervals include no improvement. These are small, single-host cohorts, and no independent opposite-order whole-import confirmation was run for this standalone encoder after these results.

The field-encoding phase medians were -38.462% for JMdict, -25.924% for Jitendex and -58.325% for VNDB. These overlapping phase counters are not a decomposition of elapsed import time. Jitendex's identical-code field-encoding control itself improved 42.414%; that phase needs particular caution. The field improvements must not be presented as complete-import gains or added to percentages from other experiments.

## Correctness, storage and package identity

All 78 observations passed source/package/semantic receipt checks. The independent audit recomputed the fixed plans, paired arithmetic, original scan qualification, source hashes and package-member maps.

The only changed existing release member is `js/dictionary/term-record-opfs-store.js`. Exactly three members are added:

- `js/dictionary/term-record-fields-wasm.js`
- `js/dictionary/wasm/term-record-fields-v1.c`
- `lib/term-record-fields-v1.wasm`

There are no other changed, added or removed release members. The compressed release package grows by **5,654 bytes**. Durable logical storage byte totals match within each corpus, including 43,520,477 bytes for JMdict and 67,466,332 bytes for Jitendex. Exhaustive media verification matches all 236 Jitendex images (4,992,155 bytes) and all 146,570 VNDB images.

Lookup/readback, restart and stored-work checks are retained in every original report. The package and native parser/canonicalizer bytes are independently identified; the original parser and canonicalizer modules are unchanged.

## Memory acquisition

The original gate requires complete, stable process-tree reads, at least five fully contained import scans, pre/post brackets and no covered-scan gap above 250 ms. Missing coverage is not a measured saving or regression.

| Corpus | Original qualification |
| --- | --- |
| JMdict | B2 has a 276.029 ms covered-scan gap and fails acquisition. The other three observations qualify. The first pair is PSS -0.322%, private -0.460%; the second pair and full cohort remain unqualified. |
| Jitendex | All four observations qualify, with 333 raw scans and maximum gaps of 103–111 ms. Median PSS change +0.140%, worst +0.634%; median private change -0.187%, worst +0.171%. |
| VNDB | All four observations miss coverage: maximum gaps 276.314, 290.120, 387.775 and 268.667 ms. Qualified maxima and comparisons remain null. |

No gate was relaxed and no failed observation was replaced. The raw samples, markers, failure reasons and independent calculations remain in the archives.

## Source validation and later lint repair

The measured source passed the complete unit suite: **15,167 passed, 47 skipped, 670 files**. All four TypeScript projects, pinned native reproduction and all-target builds passed. The measured source's ESLint lane failed with 37 wrapper/test diagnostics; that failure is preserved.

A later formatting/JSDoc repair is published separately at `0d9b11df78f05217b96e3c14ad06de6aeebc29b8`, tree `aaa7d373385c85bc91fa72e042be9c532e25a773`. An independent AST comparison and independent esbuild comparison establish identical executable wrapper syntax after removing comments and normalizing whitespace (4,770 bytes, SHA-256 `7354efe788b32c604b0b573c4d105829d8a284a5c329fae664d92d29835a13da`). Only two test callbacks acquire names. The store, C and native module are unchanged.

The repair passed scoped lint, 32 native-encoder tests, the complete main TypeScript project and a focused test/transitive typecheck. The original complete browser results remain attributed to `731c737`, whose package bytes were actually measured. The repair does not turn the original failed lint job into a pass.

## Representation correction in component replays

An earlier component capture converted every score column to Int32. That was faithful for JMdict and Jitendex but overstated VNDB native admission. The corrected replay preserves actual source types: 144 VNDB groups, containing 5,648,310 rows, admit native encoding; 26 groups, containing 1,000,000 rows, carry Float64 score columns and correctly fall back. All captured values happen to be lossless Int32 values, so the previous byte oracle remains valid, but its activation/timing scope does not.

The browser campaign uses the actual product path and actual types; it is not based on those coerced inputs. A separate Float64-admission experiment has only local component evidence and is not included in this candidate or any result above.

## Retained evidence and reproduction

`index.json` records the original artifact archive hashes and retained archive hashes. Each corpus receipt ZIP preserves every original raw member except its two reproducible release-package ZIPs, and adds an independent audit plus an inventory containing the SHA-256 of **every original member**, including the omitted packages. Original source/package/member maps, browser identity, fixed plan, all raw reports, logs, memory scans and failures remain present. The original complete artifact ZIPs were independently downloaded and verified before this packaging step.

Original workflow artifacts: JMdict `15247215895`, Jitendex `15247261185`, VNDB `15245904227`. GitHub artifact retention is temporary, so the receipt archives here retain the raw observations beyond it. `source-validation.zip` retains completed job logs, the original lint failure and the later lint-equivalence proof/checks.

The frozen workflow is `.github/workflows/native-record-browser-beb5.yml` at the research source above. It calls `dev/perf/import-qualification-20261128-beb5.py` with six pairs, three parser workers, explicit expected release-member changes and the existing 37×4,096-byte VNDB SAH allocation policy. Dependencies, fixtures, browser and all source identities are locked and recorded. Reproduction must use the frozen baseline/candidate, preserve all failures and obtain a new independent acquisition; it must not splice observations into this completed cohort.

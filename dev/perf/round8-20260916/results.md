# Round eight: parser control flow and exact-layout allocation

September 16, 2026

## Decision

**Eight additional designs were implemented; seven received complete JMdict and Jitendex import comparisons, and one compiled to identical runtime code. None is promoted to a new optimization PR.** The most promising initial candidate, string-prefix traversal, regressed on both dictionaries in independent confirmation. Allocation savings alone are not a substitute for the requested runtime improvement.

All changes are confined to `verify/import-round8-20260916`. No product/release branch, existing optimization PR, dependency pin, compression setting, worker count, source budget, fixture lock or experimental default was changed or merged. The earlier #41/#44/#45 implementations were not modified. This round starts from develop `b4094a423c20bb0ed424d944238f922c1b36559c`, tree `604c5c2b64b8d217e87895dbd981aa3a30579bcb`, which includes #39/#40. None of the new experiments includes #41/#44/#45.

## Research and implementation review

[Langdale and Lemire's validating JSON parser work](https://arxiv.org/html/1902.08318v7) motivates reducing repeated classification, branching and parsing steps while retaining validation. Its discussion of selective/non-validating parsers is also a reason not to obtain an artificial speedup by ignoring malformed input. [LLVM's language reference](https://llvm.org/docs/LangRef.html#switch-instruction) describes switch control flow and its implementation choices. These are sources for hypotheses, not performance evidence for this repository.

The experiments target different parts of the existing implementation:

| Candidate | Isolated change | Disposition |
| --- | --- | --- |
| `row-cursor` | Avoid a duplicate whitespace skip at the top of row traversal; the first cursor and subsequent field boundaries are already advanced appropriately. | Mixed whole-import results; reject. |
| `row-unrolled` | Specialize the first eight fields into direct parsing/metadata writes instead of repeated field-index dispatch. Preserve optional/short rows, scalar validation, glossary hints, extra-field validation and separators. | No convincing cross-dictionary benefit; reject added code. |
| `state-tables` | Use bounded internal transition tables for nested-container string/value states; invalid transitions retain rejection. | No useful import signal; reject. |
| `scalar-once` | Recognize JSON number/literal grammar and its complete token boundary in one pass rather than scanning then validating. This is not the older score/sequence int32 shortcut. | Mixed/noisy; reject. |
| `string-prefix` | Validate a root array's leading string values without entering the general state dispatcher; mixed arrays resume at the first unconsumed value without rescanning. Preserve whitespace, hints and malformed-tail rejection. | Favorable initial medians did not replicate; reject. |
| `local-hints` | Track pending media, normalization and text-normalization detection in local flags, retaining immediate output writes and exact hint semantics. | Faster initial JMdict but slower Jitendex; reject. |
| `composite-switch` | Express the same punctuation handling with switch dispatch instead of the existing condition chain. | Clang 18 emitted byte-identical WASM. No runtime change to benchmark; reject. |
| `arena` | Reserve fused parser buffers with one native bump allocation and distribute the same eight-byte-aligned spans. Preserve capacities, disabled optional pointers and the final content region's in-place growth capability. | Allocation-call reduction, but no convincing import gain; reject. |

The first seven candidates modify only `ext/js/dictionary/wasm/term-bank-parser.c`. The arena candidate modifies only `ext/js/dictionary/term-bank-wasm-parser.js` and leaves native WASM identical. No experiment replaces the parser grammar with selective parsing, defers required work to lookup, or changes persisted formats.

## All initial whole-import comparisons

Changes are `median(100 * (B_ms / A_ms - 1))` over adjacent matched pairs. **Negative means faster; positive means slower.** Each initial cell has six alternating AB/BA pairs, three interleaved A/A pairs and one excluded complete warmup per arm. Arms run serially on one host; different hosts are not pooled. All outliers remain included.

| Candidate | JMdict | Jitendex | A/A median: JMdict / Jitendex |
| --- | ---: | ---: | ---: |
| Row cursor | -2.263%, 5/6 faster | +1.017%, 1/6 faster | +0.873% / -0.319% |
| Unrolled row fields | -2.021%, 4/6 faster | -0.228%, 3/6 faster | -1.701% / +0.025% |
| Transition tables | +1.160%, 2/6 faster | -0.123%, 3/6 faster | +0.429% / +1.900% |
| Single-pass scalar validation | +0.197%, 3/6 faster | -0.698%, 4/6 faster | -0.811% / -1.934% |
| String-prefix traversal | -1.511%, 5/6 faster | -2.752%, 3/6 faster | -2.376% / +7.657% |
| Local hint flags | -2.745%, 5/6 faster | +0.896%, 2/6 faster | +0.212% / +2.647% |
| Exact-layout arena | -0.938%, 4/6 faster | +0.126%, 3/6 faster | -1.322% / +0.507% |

The switch experiment is deliberately absent from this timing table. The strict package comparison found only the changed C source, not a changed WASM member, and stopped before imports. The workflow's two corresponding failed admission cells are retained; they are not failed dictionary imports or measured slowdowns, and the matrix is not described as entirely green.

## Independent string-prefix confirmation: reject

The follow-up uses unchanged candidate source, new runners, twelve alternating pairs starting BA, six interleaved A/A controls, and excluded complete warmups. It does not select observations from the earlier cohorts.

| Dictionary | Initial median | Independent median | Faster confirmation pairs | Equal-work total | Confirmation A/A median |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | -1.511% | **+1.560%** | **1/12** | +3.740% | +0.006% |
| Jitendex | -2.752% | **+1.706%** | **3/12** | +2.835% | -0.012% |

The initial favorable percentages are not retained speedup claims. Eleven of twelve JMdict and nine of twelve Jitendex imports were slower in confirmation, with nearly flat A/A medians. The +24.441% JMdict and +21.759% Jitendex observations remain included. The paired medians and equal-work totals both favor the unchanged implementation.

The separate two-pair resident parser-plus-completed-lookup checks had +0.735% JMdict and -1.400% Jitendex component medians, with complete output/index equality. Those smaller component boundaries exclude inflation, IPC, compression, persistence and UI. A favorable component result does not override the full-import regression.

## Measurement controls and completed work

There are **356 completed browser imports across 16 complete timing cohorts**: 108 measured A/B pairs (216 observations), 54 A/A pairs (108 observations), and 32 excluded warmups. No completed import was retried, trimmed or discarded. The no-op switch admission cells and regression-test executions are not counted as imports.

CI uses Ubuntu 24.04 x64, Node 24.20.0, Clang 18.1.3 and Chromium 153.0.8010.12. Both extension packages are built at the identical filesystem path. All package members except the intended C source/WASM, or the arena's intended JS file, must agree byte-for-byte. No ZIP member substitution or source-comment normalization is used. Source cleanliness and exact package hashes are checked throughout.

Each observation has a fresh browser profile, real OPFS-SAH-pool persistence, unchanged production batching/concurrency/admission, and `{}` flags. All ten actual worker/effective experiment receipts are false. The measured interval remains file-input change through post-UI import completion. Profiling, traces, screenshots and process sampling are disabled during timing. These are warmed-host, fresh-profile measurements, not a separate cold-OS qualification.

The unchanged fixture lock identifies:

| Fixture | Revision | Rows | ZIP SHA-256 |
| --- | --- | ---: | --- |
| JMdict 2026-09-06 | JMdict.2026-09-06 | 526,942 | `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a` |
| Jitendex 2026.08.11.0 | 2026.08.11.0 | 435,448 | `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc` |

The offline audit independently rereads all 356 raw reports. It verifies complete fixed plans, browser monotonic timing, source/package identities, exact title/revision/row counts, twelve distributed persisted lookup/content probes, OPFS, actual flags, and stable source-byte/bank/group/worker/deduplication accounting. Term-content, record and lookup-index write totals and maximum individual parser-worker heaps agree within each cohort. These worker heaps are not total browser-tree peak memory.

Before timing, each complete cohort passes **571 existing focused tests** and its complete-corpus parse/lookup equality checks. Canonical/prepared-index digests and index byte counts agree across arms. This is not an exhaustive persisted-store byte comparison.

Actual same-path package sizes are recorded in every artifact. The arena retains the 42,936-byte native module and adds 311 bytes to the Chrome-dev archive. The string-prefix candidate grows WASM by 568 bytes and the archive by 301 bytes. The unrolled-row candidate grows WASM by 1,543 bytes. None is accepted merely for changing allocation counts, component timing or code size.

## New regression qualification

The new `test/term-bank-control-flow.test.js` contains **24 distinct tests**, each exercised against the unchanged parent and all seven C variants. It invokes the real ordinary and fused production WASM exports, not a mocked parser, and compares validity with independent JSON parsing plus byte-exact spans and metadata equivalence.

Coverage includes all 16 alignments; JSON number/literal syntax and every ASCII suffix after valid scalar prefixes; missing/extra row fields and defaults; malformed separators and extra fields; logical and physical input ends; every truncated prefix; nested states through the existing depth limit; 1,000 deterministic mutations; string-prefix handoff into mixed/nested arrays; and exact media/normalization hints. Metadata destinations are guarded and result arrays are independently owned.

[Regression matrix run 35087507795](https://github.com/ManabiIO/manabitan/actions/runs/35087507795) completed successfully. Its raw JSON shows **24 passed, zero failed and zero skipped for each of eight compositions**. These are 24 distinct tests repeated across compositions, not 192 distinct new tests. The same run passed new-test ESLint without rewriting and all four strict JavaScript typecheck projects on the parent plus new test. A non-failing inherited bundler warning remains visible. All timed C-source hashes match the corresponding regression-tested source hashes.

Exact test blob: `9a58d0df10d91f0d23217380ea8e640a38585ddf`; SHA-256 `0a8d419db0a7643676acf3447fbbefd19a2da65b90acf4b6f69034b4245ecc35`.

The new direct-WASM tests do not exercise the arena's JS allocation helper. That candidate received the existing 571 focused tests, complete-corpus comparisons and full import/probe checks; it was not subjected to full release qualification after its runtime result failed to justify retention.

Local exploratory runs use Node 22.16.0 and Clang 17, not the CI toolchain. Two earlier broad local runs hit the unrelated mocked idle-worker scheduling assertion; their logs are retained and are not relabeled as full passes. The new test's original formatting diagnostics were corrected before exact CI qualification, without changing candidate source. A local multi-variant test loop reached its execution limit, after which the remaining local test executions were completed separately. None of these local events caused a timed import to be retried or removed.

## Evidence and scope limits

- [First four candidates: eight complete timing cells](https://github.com/ManabiIO/manabitan/actions/runs/35085626620)
- [Glossary/hint candidates and two retained no-op switch admission failures](https://github.com/ManabiIO/manabitan/actions/runs/35086514271)
- [Exact-layout arena: both complete dictionaries](https://github.com/ManabiIO/manabitan/actions/runs/35087107908)
- [Independent string-prefix confirmation](https://github.com/ManabiIO/manabitan/actions/runs/35087190730)
- [Exact-test parent/seven-candidate regression matrix](https://github.com/ManabiIO/manabitan/actions/runs/35087507795)

Every timing artifact retains its executed driver, source generator, candidate patch, plan, source/package identities, all reports and completion marker. The offline evidence bundle also contains both switch admission failures, the full regression artifact, supplemental local logs, exact tests, all candidate source generators, recomputed CSV/JSON and a checksum-verifying audit script. GitHub artifact retention is 30 days.

No new candidate received a claimed full repository unit/options suite or full Chromium lifecycle qualification in this round. Firefox/Safari/ARM performance, total browser-tree memory and exhaustive stored-byte equality are not established. No candidate progressed to testing against the stacked existing PRs because none justified production-baseline retention. The earlier PR evidence remains separate and unchanged.

**Final disposition: retain the negative results and new regression evidence; open no new optimization PR, and merge nothing.**

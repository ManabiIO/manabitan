# Import optimization qualification, November 23, 2026

**Decision: hold the six new performance candidates as drafts.** The complete-import studies, component oracles, phase counters and separate memory observations are retained here. Correct output and reduced component work do not establish a repeatable material complete-import improvement. The acceptance rule remains in the [existing performance handoff](../../../dev/perf/import-experiments-20260914.md).

This report belongs to [PR #814](https://github.com/ManabiIO/manabitan/pull/814), stacked on [the prior qualification report, #805](https://github.com/ManabiIO/manabitan/pull/805). Each runtime PR is independently based on `5e1f8c12f7ff798ba407323aff675cb23b22af02`; the experiments were not combined into an unmeasured runtime stack. No runtime candidate was merged or enabled on the default branch.

## Runtime changes and exact identities

| Candidate | Published runtime commit | Purpose |
| --- | --- | --- |
| [#812 — SIMD inflate copy](https://github.com/ManabiIO/manabitan/pull/812) | `5555f3efd3e0c8baa99e93b4c14e7f1889c30383` | Ordered SIMD match copying |
| [#816 — Lookup initialization](https://github.com/ManabiIO/manabitan/pull/816) | `3a4ef7ed11dd6b0509c12ad495ab8f591b68872b` | Avoid overwritten initialization |
| [#817 — CRC word halves](https://github.com/ManabiIO/manabitan/pull/817) | `4884b4bd93d45f152ec828bcca44990f18976a05` | Replace 64-bit CRC shifts with word halves |
| [#818 — Leading glossary strings](https://github.com/ManabiIO/manabitan/pull/818) | `524b41a112a1ba0b1ac31723da274c97d5525653` | Consume leading strings before generic parsing |
| [#820 — Owned key buffers](https://github.com/ManabiIO/manabitan/pull/820) | `8fe5926cec1396a05ed4ea52be751e48784329b7` | Reuse owned key buffers with cache-retention safeguards |
| [#822 — Record validation](https://github.com/ManabiIO/manabitan/pull/822) | `cf1e18d59d08da729d4b2fe45c7a07021f42360a` | Hoist reference dispatch within a synchronous validation run |

All native artifacts were rebuilt with pinned Clang/LLD 21.1.8. The two JavaScript candidates do not alter WASM. Local and published commits have identical complete Git trees, recorded in [the source ledger](sources.json). The [original runtime blob manifest](published-runtime-blobs.json) and [extended manifest including record validation](published-runtime-blobs-with-record.json) bind package deltas to exact published source blobs. Earlier audits retain the original manifest hash.

The changes preserve existing formats and policies. They do not add parser workers, tune batch or compression thresholds, introduce a new persistence representation, or incorporate other concurrent import PRs.

## Fixed complete-import campaign

All **36 timing cells completed: 1,512 successful full imports, comprising 216 excluded warmups and 1,296 measured imports**. The measured stream contains 432 candidate/parent pairs and 216 same-code control pairs. The separate 24 observer-enabled memory imports and three discovery profiles are not pooled into these timing counts.

Each independent dictionary/direction cell uses six excluded warmups, twelve literal adjacent candidate/parent AB/BA pairs, and six interleaved identical-code AC/CA control pairs. The reverse job runs on another hosted machine and flips the initial candidate and control order. Each observation starts a fresh Chromium process/profile. A and C use the same package; B differs only in the declared source entries. There are no measurement retries, extended plans, removed outliers, pooled-host estimates, or subtraction of control effects.

The boundary is the browser file-input change through the completed import operation after UI work. Node 22.22.0, Playwright 1.63.0 and Chromium 153.0.8010.12 are fixed. Profiling, trace capture, screenshots, process sampling and import-flag overrides are disabled in this timing campaign. The [driver](../../../dev/perf/import-r2-qualification-20261123.py), [configuration](../../../dev/perf/import-r2-qualification-20261123.json), [workflow](../../../.github/workflows/import-r2-qualification-20261123.yml) and eight protocol contracts are retained at each measurement source.

| Campaign | Immutable research source | Workflow |
| --- | --- | --- |
| Inflate | `1788fa1fe889c407d24d0f4b5ca23689946fbcec` | [45119098795](https://github.com/ManabiIO/manabitan/actions/runs/45119098795) |
| Lookup, CRC and flat glossary | `05740992c377629eb3017be35cf8c6064d9ef445` | [45121755673](https://github.com/ManabiIO/manabitan/actions/runs/45121755673) |
| Owned key buffers | `9941723a323c76e8d73a16880e658fa243f17187` | [45123053286](https://github.com/ManabiIO/manabitan/actions/runs/45123053286) |
| Record validation | `c0c2fdc79c9b4364e1a7fdfc915e5fd13ef332bc` | [45124794707](https://github.com/ManabiIO/manabitan/actions/runs/45124794707) |

Every retained import passes exact dictionary title/revision/row-count checks, twelve source-derived persisted-content probes, and full browser restart/readback. Native source work, three parser workers, zero fused/dedup fallbacks, OPFS import-session publication, stored probe digests and persisted write-byte counters agree across arms. JMdict uses four source groups per parser worker; Jitendex and VNDB use three. Browser probes are sampled validation, not exhaustive persisted-database, index or image-payload equality.

| Fixture | Rows | Term banks | Native chunks | Compressed term bytes | Decoded term bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | 526,942 | 53 | 12 | 15,574,114 | 171,092,992 |
| Jitendex | 435,448 | 218 | 22 | 33,696,215 | 537,538,792 |
| VNDB Characters by Bee | 6,648,310 | 665 | 170 | 86,850,424 | 4,267,992,967 |

All fixtures are bound by archive SHA-256 and size in the retained lock and preparation receipts. VNDB is the pinned Bee release 1.0.0, archive SHA-256 `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`, not an unconditional addition to production fixture downloads.

## Complete-import results

Values below are **forward / independent reverse**; negative means faster. Equal work is the ratio of summed candidate durations to summed paired parent durations in that one cell. C/A is unchanged code. The [machine-readable summary](summary.json) retains every paired ratio, descriptive interval, worst pair, work receipt and source identity.

| Candidate | Corpus | B/A median | B/A equal work | C/A median | C/A equal work |
| --- | --- | ---: | ---: | ---: | ---: |
| SIMD inflate copy ([#812](https://github.com/ManabiIO/manabitan/pull/812)) | JMdict | -1.97% / +0.64% | -3.02% / +0.01% | +0.66% / +0.98% | +1.15% / +0.34% |
| SIMD inflate copy ([#812](https://github.com/ManabiIO/manabitan/pull/812)) | Jitendex | -0.65% / +0.90% | -0.29% / +0.81% | +0.85% / +1.26% | +0.72% / +0.81% |
| SIMD inflate copy ([#812](https://github.com/ManabiIO/manabitan/pull/812)) | VNDB | +1.33% / +0.13% | +1.48% / +0.64% | +0.04% / +0.16% | +0.51% / +0.58% |
| Lookup initialization ([#816](https://github.com/ManabiIO/manabitan/pull/816)) | JMdict | +1.62% / -0.03% | +1.27% / -0.10% | +0.13% / -0.60% | +0.18% / -0.15% |
| Lookup initialization ([#816](https://github.com/ManabiIO/manabitan/pull/816)) | Jitendex | -0.13% / -0.57% | +0.56% / -0.49% | +1.60% / +0.25% | +1.29% / -0.46% |
| Lookup initialization ([#816](https://github.com/ManabiIO/manabitan/pull/816)) | VNDB | -0.97% / +0.35% | -0.34% / +1.12% | +0.28% / +0.59% | +0.26% / +1.53% |
| CRC word halves ([#817](https://github.com/ManabiIO/manabitan/pull/817)) | JMdict | -0.70% / -1.04% | -0.67% / -1.21% | +0.01% / -0.53% | +0.55% / -0.95% |
| CRC word halves ([#817](https://github.com/ManabiIO/manabitan/pull/817)) | Jitendex | -0.20% / -0.54% | +0.56% / -0.78% | +0.47% / -2.75% | +0.36% / -1.85% |
| CRC word halves ([#817](https://github.com/ManabiIO/manabitan/pull/817)) | VNDB | -0.26% / -1.33% | -0.79% / -2.96% | -1.04% / +1.34% | -0.80% / +2.20% |
| Leading glossary strings ([#818](https://github.com/ManabiIO/manabitan/pull/818)) | JMdict | -0.24% / +0.39% | -0.22% / +0.13% | -0.38% / +0.55% | -0.45% / -0.45% |
| Leading glossary strings ([#818](https://github.com/ManabiIO/manabitan/pull/818)) | Jitendex | -1.06% / -0.33% | -1.09% / -0.69% | -0.34% / -1.57% | -0.46% / -0.74% |
| Leading glossary strings ([#818](https://github.com/ManabiIO/manabitan/pull/818)) | VNDB | -0.19% / +0.94% | +0.00% / +1.72% | +0.08% / +1.32% | +0.06% / +2.71% |
| Owned key buffers ([#820](https://github.com/ManabiIO/manabitan/pull/820)) | JMdict | -0.50% / +0.53% | +0.11% / +0.93% | -0.37% / +1.09% | -0.87% / +1.07% |
| Owned key buffers ([#820](https://github.com/ManabiIO/manabitan/pull/820)) | Jitendex | +0.37% / +1.73% | +0.22% / +1.60% | -0.53% / +0.66% | -4.26% / +0.99% |
| Owned key buffers ([#820](https://github.com/ManabiIO/manabitan/pull/820)) | VNDB | -1.22% / -0.95% | +0.67% / -1.03% | -0.63% / +0.95% | -0.52% / +0.72% |
| Record validation ([#822](https://github.com/ManabiIO/manabitan/pull/822)) | JMdict | +1.07% / -3.62% | -1.09% / +2.22% | -1.88% / -2.03% | -1.62% / -0.97% |
| Record validation ([#822](https://github.com/ManabiIO/manabitan/pull/822)) | Jitendex | -0.41% / -1.12% | -0.30% / -1.01% | +0.02% / +0.67% | +0.08% / -0.03% |
| Record validation ([#822](https://github.com/ManabiIO/manabitan/pull/822)) | VNDB | -0.02% / -0.87% | +0.38% / -0.92% | +0.98% / -0.14% | +1.45% / +0.22% |

The native candidates do not establish a replicated material whole-import improvement. The favorable CRC/VNDB reverse median interval does not reproduce forward; selecting that one cell among eighteen would overstate the evidence. The original local CRC screen remains incomplete after `02-C` was killed by signal 9 during warmup. Its three completed arms and the environment receipt are preserved; there was no local rerun or gain claim.

Owned key-buffer reuse has lower VNDB median times in both directions, but the forward cell retains +12.05% and +13.07% slower pairs. Its complete equal-work result is +0.67% / −1.03%. JMdict and Jitendex equal-work results are slower in both cells. The candidate remains on hold despite its useful copy and diagnostic memory evidence.

Record validation also remains on **HOLD**. Jitendex improves by only −0.30% / −1.01% on equal work; both candidate median intervals include zero. VNDB is +0.38% / −0.92%, so the favorable reverse interval does not replicate forward. JMdict is −1.09% / +2.22% with a retained +44.27% slower reverse pair and substantial drift. Existing validation-phase counters show a local mechanism, but do not establish a material complete-import gain or directly count use of the new branch.

### Component mechanisms and correctness boundaries

The [component archive](../20261123-r2-components/README.md) retains exact runners, whole-output oracles, dirty-output and malformed-input tests, local fixed screens, build/type/lint receipts, and earlier failed attempts. The [ownership archive](../20261123-transfer-ownership/README.md) separately retains all three exact-committed-source transfer oracles and retained-buffer tests.

- **Inflate, #812:** ordered 16-byte SIMD copies retain the existing overlap and output-guard contract; WASM grows by 62 bytes. Every byte of 5,169,815,579 decoded archive bytes agrees with the parent and independent Node zlib. Eighty-six focused tests pass. Local component timing is inconclusive.
- **Lookup, #816:** initializes only required headers, padding and counters; all payload and hash-link fields are subsequently written. Complete output is unchanged across all three corpora, including dirty-output tests. It avoids 18,489,908 / 18,844,739 / 327,921,810 initialization bytes for JMdict / Jitendex / VNDB. This is write-volume accounting, not allocation or peak memory. WASM grows by 106 bytes.
- **CRC, #817:** loads the same eight-byte word as two 32-bit halves while preserving lane, block, fold and tail semantics. Only one of 44 compiled functions changes; static integer opcodes in the 64-byte braid decrease from 498 to 434 and WASM shrinks by 114 bytes. Seventy-three focused tests and all 5.17 GB of decoded archive comparisons pass. Static instructions are not a measured runtime speedup.
- **Flat glossary, #818:** consumes leading flat strings using the existing bounded validator and continues at the exact first generic token/state when needed. Whole-output oracles for all three corpora and 711 focused tests pass. WASM grows by 1,061 bytes. The intended JMdict parse counter does not improve on equal work.
- **Owned buffers, #820:** a private producer/descriptor identity check permits reusing the native sidecar's key arena and key-length table. Current content remains validated; changed/foreign descriptors and explicit byte-list behavior retain their existing paths. Retained record-cache paths copy a tight key arena to avoid retaining the entire sidecar. Exact whole-corpus output parity passes. Summed copy volume removed is 8,301,780 / 9,706,463 / 202,591,586 bytes. These are neither simultaneous retained bytes nor peak-memory savings.
- **Record validation, #822:** selects owned reference columns once per synchronous validation run and loads each row's index once for both bounds-checked offset and length. Shared, fixed and malformed paths keep the generic helpers; references are reselected after awaits. All 208 focused tests and 23 exact-committed-source serialized sidecar/run/error cases pass. This is separate from the record-field encoding loop in PR #764.

Existing phase counters provide mechanism evidence within their own boundaries. Jitendex lookup-preparation equal-work time decreases 12.38% / 9.41%; VNDB inflate/CRC decreases 1.84% / 2.99%; VNDB result-copy time decreases 7.24% / 6.21%. Record-validation counters decrease 35.57% / 35.92% for Jitendex and 23.54% / 18.18% for VNDB, while JMdict increases 1.05% / 21.10%. There is no dedicated counter proving entry into that new validation branch. Worker durations overlap and cannot be added into claimed critical-path or whole-import savings. Baseline traces from [run 45117772842](https://github.com/ManabiIO/manabitan/actions/runs/45117772842), source `20139d45cfeb9a41e9e6f2b284c753ef81a6d8de`, are discovery evidence only; profile weights include scheduling and blocked-time effects.

## Separate owned-buffer memory campaign

[Run 45124025705](https://github.com/ManabiIO/manabitan/actions/runs/45124025705), research source `a9a90967f1dfc9c9c68d06ae5ad4ad1e999f67b2`, compares the exact #820 runtime against the same baseline. It has four fresh-process imports per dictionary/host, ordered ABBA or BAAB. All 24 imports pass browser verification, but only 22 memory observations and four complete cells qualify. Each qualified cell has two pairs; no host pooling is used below.

| Corpus | Independent order | Qualified memory cell | Median sampled PSS change | Median sampled private-byte change |
| --- | --- | --- | ---: | ---: |
| JMdict | ABBA | No — coverage failure | Withheld | Withheld |
| JMdict | BAAB | No — coverage failure | Withheld | Withheld |
| Jitendex | ABBA | Yes | -0.54% | -0.55% |
| Jitendex | BAAB | Yes | -4.79% | -5.82% |
| VNDB | ABBA | Yes | -2.29% | -2.75% |
| VNDB | BAAB | Yes | -2.52% | -2.88% |

Both JMdict cells contain an unreadable stable **two-thread** zombie leader and correctly fail the frozen single-thread zombie exemption. Their maxima and comparisons are withheld; other successful scans do not rescue the cells. All 2,024 raw process-tree scans and qualification failures remain preserved. No observation was retried and no observer rule was relaxed.

The [memory protocol](../../../dev/perf/import-r2-memory-20261123.md) uses an unchanged observer with SHA-256 `ca6c0f7761062761697a810d4bd0007ff0257bbce69099df45657ffdb7ee8f10`, including PID/start-time/executable identities, stable-tree checks, renderer/browser coverage and PSS/private-byte readings for the complete discovered Chromium descendant tree. Its eleven driver contracts and five compiled process-witness tests pass.

These are maxima of covered, non-atomic samples across browser startup, import, readback and restart. They are not exact import peaks, settled memory, GC-retention or constrained-host OOM qualification. Short-lived or reparented processes may be missed. Observer-run elapsed times are excluded from timing conclusions. All four qualified VNDB pairs have lower sampled PSS/private bytes, but the incomplete JMdict coverage prevents a three-corpus memory-nonregression claim.

## Validation, limitations and preserved failures

All six runtime heads pass their complete executed CI suites, including unit/type/build checks and Chromium/Firefox extension tests. Conditional manual/platform jobs are not counted as executed passes.

| Runtime PR | Exact source | Successful full CI |
| --- | --- | --- |
| [#812](https://github.com/ManabiIO/manabitan/pull/812) | `5555f3efd3e0c8baa99e93b4c14e7f1889c30383` | [45118438710](https://github.com/ManabiIO/manabitan/actions/runs/45118438710) |
| [#816](https://github.com/ManabiIO/manabitan/pull/816) | `3a4ef7ed11dd6b0509c12ad495ab8f591b68872b` | [45120129003](https://github.com/ManabiIO/manabitan/actions/runs/45120129003) |
| [#817](https://github.com/ManabiIO/manabitan/pull/817) | `4884b4bd93d45f152ec828bcca44990f18976a05` | [45120129751](https://github.com/ManabiIO/manabitan/actions/runs/45120129751) |
| [#818](https://github.com/ManabiIO/manabitan/pull/818) | `524b41a112a1ba0b1ac31723da274c97d5525653` | [45120133351](https://github.com/ManabiIO/manabitan/actions/runs/45120133351) |
| [#820](https://github.com/ManabiIO/manabitan/pull/820) | `8fe5926cec1396a05ed4ea52be751e48784329b7` | [45122913657](https://github.com/ManabiIO/manabitan/actions/runs/45122913657) |
| [#822](https://github.com/ManabiIO/manabitan/pull/822) | `cf1e18d59d08da729d4b2fe45c7a07021f42360a` | [45124698611](https://github.com/ManabiIO/manabitan/actions/runs/45124698611) |

The final measurement-source CI and link checker pass at `c0c2fdc79c9b4364e1a7fdfc915e5fd13ef332bc`. The final local JSON check initially lacked generated Handlebars/LinkeDOM libraries; after the normal `build:libs` prerequisite, it passed. [Local validation history](local-validation/history.json) records that setup failure and both subsequent command exits; it does not treat the surrounding shell's initial exit status as a pass. The earlier memory README link-check failure is retained: that new document had zero hyperlinks; adding the immutable observer provenance link fixed the check without changing the observer or measurement protocol. The original full local transfer test-project type process exited 137; the bounded changed-file check and subsequent full hosted type job pass, while the failure remains recorded.

Local component screens are exploratory, serial, production-shaped partitions rather than a proof of exact browser partition membership or quiet-host isolation. Lookup and flat-glossary fixed screens completed but showed substantial control drift. The CRC killed-child screen is incomplete. Local browser launch failed with EPERM; full timing was executed only on the hosted extension-capable environment. Initial lint/type/setup and offline reviewer errors remain archived rather than reclassified as successes.

No candidate has passed all promotion gates. This study does not establish exhaustive persisted-image/database equality, reopened lookup latency, exact peak or settled memory, ARM performance, or cross-browser speed. Those limitations are not filled by correct component output or green functional CI. No extra qualification lane was used to select around a failed complete-import result.

## Evidence integrity and reproduction

The [evidence auditor/packer](../../../dev/perf/import-r2-evidence-20261123.py) independently reconstructs the fixed pair schedule, package/source bindings, raw browser clock, work/readback checks and reported statistics. Eight integrity tests verify preserved binary failure bytes, ZIP transport consistency, corrupt archives, changed indexes, unsafe paths, symlinks, existing-output protection and incomplete browser rosters. Separate reviewers independently recomputed the native, transfer and record results. Read the retained [native review](native-browser-review.txt), [transfer review](transfer-browser-review.txt), [memory review](memory-review.txt) and [record-validation review](record-browser-review.txt). The [final-review history](review-history/manifest.json) also preserves partial offline reads and previous reviewer versions; these are not replacement benchmark observations.

| Bundle | Members | Archive bytes | SHA-256 |
| --- | ---: | ---: | --- |
| [Thirty timing cells, memory and profiles](../20261123-r2-hosted/README.md) | 8,936 | 11,979,924 | `c57ba517630eda731ade2e83a6927417df26c0bfd737ad9d294f06a173812095` |
| [Final six record-validation cells](../20261123-r2-record-hosted/README.md) | 1,696 | 1,627,612 | `e99a655f2e811b9df0329750fb4834854e81fb6c993b5747f87ea628bd1b432f` |
| [Local components and independent reviews](../20261123-r2-components/README.md) | 336 | 530,432 | `fc11072ed64a4667e172267c69ae146101ce828d55455de889e845efcfa4190a` |
| [Owned-buffer component history](../20261123-transfer-ownership/README.md) | 56 | 347,165 | `64aa06c8d554d157bc1dbcc7217ab8ca9878fc4a1b37a47c6291ea28143e40e6` |

Each archive includes a per-member byte-length/SHA-256 inventory. Original GitHub ZIP hashes, sizes and member inventories remain recorded; every expanded member is retained byte-for-byte, while duplicate ZIP containers are omitted from the tar archive. Provider SHA-256 checks were verified before packing. All archive members and indexes were verified after freezing. The freezer refuses to overwrite an existing bundle directory.

From the repository root, verify a frozen archive before extraction:

```sh
python3 test/import-r2-evidence-20261123.test.py
python3 dev/perf/import-r2-evidence-20261123.py verify builds/perf/20261123-r2-hosted
python3 dev/perf/import-r2-evidence-20261123.py verify builds/perf/20261123-r2-record-hosted
python3 dev/perf/import-r2-evidence-20261123.py verify builds/perf/20261123-r2-components
```

Extract the archives into a new evidence directory. Use `audit-browser` with the complete comma-separated case roster and both directions, plus the retained runtime manifest; the original manifest is required to reproduce original audit receipt hashes. For record validation, use `published-runtime-blobs-with-record.json`. The driver and each cell's retained sources document how to reproduce the frozen import study on an extension-capable host. Reproduction is a new cohort, not a replacement for any observation retained here.

The runtime PRs remain drafts with these final HOLD decisions. The independent media-persistence correctness fix [#798](https://github.com/ManabiIO/manabitan/pull/798) and prior evidence report [#805](https://github.com/ManabiIO/manabitan/pull/805) retain their separate review status; this round neither folds them into a new performance claim nor changes their measured boundaries.

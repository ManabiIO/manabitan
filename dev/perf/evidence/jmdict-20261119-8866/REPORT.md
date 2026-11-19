# Manabitan JMdict import investigation

Final evidence snapshot, generated **2026-11-19T20:28:24.619281+00:00**. Baseline: `d829f5b6e6a75ee8859d38d537d224ec33c4930e`.

## Outcome

The completed reusable change is the benchmark harness fix in [draft PR #757](https://github.com/ManabiIO/manabitan/pull/757). It makes the requested candidate source root reach the measured child process and applies production glossary validation. Its recorded checks passed at [`323e3f1369e5dce86fe8cd86e44c2a739f67a2ff`](https://github.com/ManabiIO/manabitan/commit/323e3f1369e5dce86fe8cd86e44c2a739f67a2ff).

**The storage candidate is not a whole-import optimization and remains unpromoted.** Its metadata index phase improves, but the stronger browser confirmation did not produce a repeatable complete-import benefit. The fused storage follow-on also remains parked after its direct confirmation changed direction.

**Parser decision:** HOLD: repeated JMdict whole-import point estimates and parser-phase reductions are promising, but both independent cohort 95% intervals include zero and whole-browser memory, lookup and reliability gates remain incomplete. No runtime PR or promotion.

The investigation retains the failed experiments, unchanged-code controls, invalid initial screen, intermediate source revisions, and every planned observation. Smaller component measurements support choosing experiments; the complete browser import is the relevant performance boundary for this task.

## Complete browser import results

The fixed confirmation protocol uses six independent Linux browser cells: JMdict, JMnedict and Jitendex, each with initial order AB and BA. Each cell contains **12 candidate pairs, four interleaved unchanged-code control pairs, and four predefined warmup observations**. A completed candidate confirmation therefore retains 216 observations: 144 candidate observations, 48 control observations, and 24 warmups. Only the predefined warmups are excluded from statistics. There are no selective retries or discarded slow measurements.

Values below are median paired percent changes. Negative means the second arm is faster. Candidate B/A compares changed code against baseline; control D/C compares two instances of unchanged baseline. AB/BA describes the first pair's order, with subsequent pairs alternating. Phase counters overlap, and worker totals cannot be added to infer elapsed wall time.

### Corrected storage publication

[Completed confirmation run 44603372923](https://github.com/ManabiIO/manabitan/actions/runs/44603372923), source [`88416a0b0403edde1d30e2765c7fb16edbc7f4a0`](https://github.com/ManabiIO/manabitan/commit/88416a0b0403edde1d30e2765c7fb16edbc7f4a0), qualification commit `cf9363ddd01aadb9bc9a9df0b73e514b26c37625`.

| Dictionary / initial order | Candidate B/A | Candidate faster | A/A control D/C | Control faster |
|---|---:|---:|---:|---:|
| jmdict / AB | +0.96% | 4/12 | -1.81% | 4/4 |
| jmdict / BA | +1.40% | 4/12 | +1.60% | 1/4 |
| jmnedict / AB | -1.65% | 7/12 | +0.94% | 1/4 |
| jmnedict / BA | +0.05% | 6/12 | -3.24% | 4/4 |
| jitendex / AB | -0.69% | 7/12 | +3.27% | 1/4 |
| jitendex / BA | -0.27% | 7/12 | -0.28% | 2/4 |

JMdict is slower by approximately **0.96% and 1.40%**, with only 4/12 faster candidate pairs in each ordering. JMnedict changes from −1.65% to +0.05%; Jitendex's small negative medians coexist with appreciable control variation. These results do not qualify a whole-import improvement.

There is a real localized signal worth preserving for later work: JMdict's metadata-index phase **excluding recent-source caching** is lower in **23/24 pairs**, with paired medians of −26.38% and −26.95%. The larger content-metadata publication boundary has approximately −5.11% and −4.15% paired medians. Neither establishes a faster complete import. The candidate reduces repeated metadata work, but that phase occupies only part of the total task.

The earlier four-pair browser pilot is preserved separately in `repo/builds/perf/ci-storage/storage-summary.json`: whole-import medians were +0.342% for JMdict, −4.242% for JMnedict, and −0.0146% for Jitendex, with order dependence. The stronger fixed confirmation controls the conclusion.

### Combined parser

[Confirmation run 44605775330](https://github.com/ManabiIO/manabitan/actions/runs/44605775330), remote source [`49ecfc8fce6688bcad1838a9d0f8083a1eb3d348`](https://github.com/ManabiIO/manabitan/commit/49ecfc8fce6688bcad1838a9d0f8083a1eb3d348), qualification commit `b4611de92fdc2aad7d3086a837b3fae927226043`.

All 216 planned observations validated across six cells.

| Dictionary / initial order | Candidate B/A | Candidate faster | A/A control D/C | Control faster |
|---|---:|---:|---:|---:|
| jmdict / AB | -3.10% | 9/12 | +1.12% | 2/4 |
| jmdict / BA | -2.10% | 7/12 | +1.37% | 1/4 |
| jmnedict / AB | -0.86% | 7/12 | +1.31% | 1/4 |
| jmnedict / BA | -1.42% | 8/12 | +3.87% | 1/4 |
| jitendex / AB | -0.12% | 6/12 | +1.50% | 1/4 |
| jitendex / BA | +0.58% | 5/12 | -1.84% | 4/4 |

JMdict's repeated point estimates, **−3.104% and −2.098%**, are promising, and the native parser phase is lower by approximately **−5.67% and −5.81%**, with 11/12 and 10/12 faster pairs. However, the paired-bootstrap 95% intervals for complete import still include zero in both independent cohorts: **AB [−5.905%, +0.354%]** and **BA [−4.651%, +1.849%]**. These intervals and every pair are retained in `repo/builds/perf/parser-confirmation-uncertainty.json`. Cohorts ran on separate hosts; any pooled calculation is diagnostic and does not qualify promotion. Incomplete whole-browser memory, lookup and reliability gates add further limits. The decision is **HOLD**, with no runtime PR.

The combined source has four narrowly scoped hypotheses: recognize an existing common tag immediately before a closing brace; consume an adjacent comma after a validated child container closes; avoid redundant metadata initialization for strictly validated eight-field rows; and recognize the exact literal structured-content type pair while preserving fallback parsing and ordinary required-field validation. Each change was first built independently. Their combination was declared before its browser comparison; independent component timings are not used to predict an additive speedup.

## Correctness and source identity

The frozen combined local commit is **`87f4a024dcf8199f043774b99ab931828c048f07`**, tree **`f0c4587e7b747506127672d2b01d80680a2997a4`**. The remote product commit has the same tree. Relative to baseline, the complete diff is seven files: parser C source, generated WASM and manifest, two modified parser tests, and two new parser tests. The tracked worktree, committed blobs, and frozen evidence WASM were checked for equality. There is no storage change in this parser candidate.

The parser WASM is 53,509 bytes, SHA-256 **`ffd8611377f5266713462c6f8594ee9a5a76f24dffa7726e6ff6a14d43b216e6`**. Its C source SHA-256 is `6e86d0a9103b31b7c1fdef20c6b54c174e7a669cf6ccaabb46a16ab4a1c0b823`; the manifest is `43fe18f6659201c2c75866c1d547fdef8bc98ef770a105aa4c3cf818153672da`. Builds used pinned LLVM/linker **21.1.8**. All individual identities and test scopes are in the detailed index; the unchanged canonical scanner is separately hashed.

The combined parser passed **533 focused tests across eight suites**, plus scoped lint. Its deterministic direct-WASM checker used seed **886619**, **4,096 cases**, **16,384 candidate comparisons**, and **23,726 successful metadata-row comparisons**. It compared all 17 metadata fields, acceptance and rejection, plain and media-hint exports, strict and permissive modes, logical EOF with physical trailing bytes, alignment, poisoned/reused metadata, legacy rows, escapes, duplicate keys/types, required fields, and mutated inputs. All comparisons passed. The separate five-component mutation cohort passed 81,920 comparisons and 118,630 successful metadata-row comparisons; these runs overlap and should not be added as unique input coverage.

The completed whole-corpus checks compare baseline and combined outputs four times per dictionary, in A/B then B/A order, with production glossary validation enabled:

| Dictionary | Fixture rows | Constructed index bytes | Full passes | Result |
|---|---:|---:|---:|---|
| jmdict | 526,942 | 19,446,728 | 4 | Equal full and supplemental digests |
| jmnedict | 667,942 | 26,292,164 | 4 | Equal full and supplemental digests |
| jitendex | 435,448 | 20,031,116 | 4 | Equal full and supplemental digests |

That covers **1,630,332 fixture rows** and **6,521,328 row-pass visits**. This does not imply unique definitions across dictionaries. The reports explicitly set `authoritativeTiming: false`; their incidental elapsed fields are not performance evidence. The initially incorrect C-snapshot path failed before parsing and its log is retained.

Browser qualification independently verifies fixture locks, package-entry identities, expected source changes, full row/count and write-byte parity, and a **12-query sampled persisted-content digest with restart**. This is not a full hash of every persisted OPFS content, record and index file. The direct parser oracle is broader over constructed parser/index outputs but does not prove complete persisted database identity. These distinct correctness scopes are recorded without conflating them.

## Earlier experiments and measurement corrections

The first apparent tag A/B comparison was actually **A/A**: all eight observations loaded the baseline WASM because the parent screen ignored the supplied source root. Its approximately +21.9% difference is evidence of noise and a harness defect, not a tag regression. The first CPU profile also omitted `validateGlossaryTypes`, unlike production. It remains a diagnostic hotspot map only. Two later source-root smoke runs verify identities, validation mode, and output equality; their timings are excluded.

Local explicit-WASM warm, group and native controls showed material schedule/JIT/GC variation. One identical-binary native control pinned to CPU 0 still showed −9.97% median current-thread CPU difference. All full raw measurements and equal-work summaries remain archived; these results did not qualify any parser component.

The earliest metadata publication prototype improved its index-only phase in 16/16 pairs, but its full-boundary confirmation fell to −1.15%, and review then found four source-alias failures. The correction is retained in the candidate lineage and passed focused tests. Corrected local publication cohorts showed larger component reductions, including a 48 MiB cache-pressure run with 835 simulated source reads per arm. The browser confirmation above supersedes those component measurements for the whole-import decision. The fused follow-on moved from −20.39% against corrected storage in AB to +12.44% in BA, so it was parked.

The strict-row initialization assembly diagnostic shows six baseline WASM stores versus three stores plus a mode branch. It avoids 52 logical initialized bytes per row, about 27.4 million across JMdict. That is a concrete mechanism, not measured DRAM traffic or an established runtime saving.

## Build and validation limits

The corrected storage source originally froze at local `676808f375170e55552682a797c9189439910e3f`, database SHA-256 `b163391e6b34678d0eed61d66da57f4bf1545dc918c03c2bef45e358f512176d`. It passed 158 focused tests plus 13 overlapping post-lint tests; fused storage passed 184 plus 39 overlapping post-lint tests. Product source identity is recorded independently from subsequent test-only corrections.

The final local test-only correction is `fb7bc7d0f1bdb5951d94bf3bcf4ebe3b266f998d`, tree `981565a0e7ba9d0291d30de6924a2a4db05a4d76`. It fixes unchecked access in a collision assertion; the runtime source hash is unchanged and the measured remote product commit was untouched. The final changed test file passed 13 tests and lint. The terminal validation receipt records every attempt and source identity.

| Preserved gate log | Status | Scope or limitation |
|---|---|---|
| `storage-original-full-unit.log` | interrupted-incomplete | The original process session became unavailable. There is no final Vitest summary or recoverable exit code; this is not a pass. |
| `storage-original-full-build.log` | failed | Initial build encountered an ext/lib symlink; preserved before the environment correction. |
| `storage-original-full-build-real-libs.log` | passed | Build retry passed after ext/lib became an isolated regular directory. |
| `storage-original-types-main.log` | passed | Main TypeScript check. |
| `storage-original-types-dev.log` | passed | Development TypeScript check. |
| `storage-original-types-test.log` | failed | TS2532 in the added collision assertion; corrected by final test-only commit. Runtime unchanged; later full test-project retry passed. |
| `storage-original-types-test-fixed.log` | resource-failed | Complete test-project retry was killed; this attempt is not a pass. The later 1920 MiB retry passed. |
| `storage-original-types-test-fixed-1920.log` | passed | Complete corrected test TypeScript project passed with a 1920 MiB heap cap. Product source unchanged. |
| `storage-original-types-bench.log` | passed | Complete benchmark TypeScript project passed with a 1920 MiB heap cap. |
| `storage-original-test-typefix-tests.log` | passed | Final changed collision test file: 13 focused tests passed; overlapping earlier coverage. |
| `storage-original-test-typefix-eslint.log` | passed | Final changed test file lint passed. |

The interrupted full unit run is explicitly **not a pass**. No complete all-unit-test verdict was recovered. Scoped tests and the successful build cannot substitute for that missing gate. Browser runs were Linux-only; this investigation supplies no cross-runtime or macOS performance qualification, complete peak process-tree memory qualification, or comprehensive cancellation/update/reimport gate.

The harness PR's recorded [Linux CI](https://github.com/ManabiIO/manabitan/actions/runs/44598783611), [restart interruption](https://github.com/ManabiIO/manabitan/actions/runs/44598783535), [link check](https://github.com/ManabiIO/manabitan/actions/runs/44598783642), [workflow lint](https://github.com/ManabiIO/manabitan/actions/runs/44598783685), [CodeQL](https://github.com/ManabiIO/manabitan/actions/runs/44598783536), and [dependency review](https://github.com/ManabiIO/manabitan/actions/runs/44598783643) passed at the cited head. Those checks qualify that harness revision, not every local product experiment.

## Zstd dictionary reuse: a future investigation

Non-timing probes used **native system Zstd 1.5.7**, one real first content block of approximately 4 MiB, and the 16 KiB dictionary. Plain `usingCDict` at level −1 produced the same 432,776 compressed bytes and exact compressed hash as `usingDict`, with exact round trips, while retaining an additional 47,680-byte dictionary object. Inspection of the [pinned upstream implementation](https://github.com/meta/zstd/blob/82d322c4973d9e2968d94047a40892bc6d9a9bdf/lib/compress/zstd_compress.c) explains why: for this known input size, ordinary dictionary creation does not take the precomputed reset path.

An explicit size-matched parameter probe activates that path. Both outputs round-trip every byte; compressed size changes from 432,776 to 432,672 bytes, a 104-byte difference, and frames differ. The context retains the same 549,912 bytes, plus a separate 64,064-byte prepared dictionary. This establishes API feasibility only. There is no timing result, shipped-WASM build, whole-corpus verification, peak-memory or lifecycle qualification. The C/Python/JavaScript probes, library/compiler identities and upstream source context are preserved; reconstructible dictionary-content input and the native executable are excluded.

## Reproduction and evidence integrity

The separately accessible `README.md`, `evidence-index.json`, `archive-inventory.json`, and `ARCHIVE-SHA256SUMS` describe the package. The main compressed archive contains every completed local raw report and CI observation/receipt, exact experiment drivers, source identities, test logs, frozen WASMs, C sources, manifests, and a Git bundle of local experiment heads requiring baseline `d829f5b6e6a75ee8859d38d537d224ec33c4930e`. The optional trace archive overlays large trace files at their original relative paths. Gzip and xz variants represent identical payloads. Downloaded CI transfer ZIPs are omitted only after every extracted member matches; wrapper hashes and verified member counts remain recorded.

After extraction, run `sha256sum -c SHA256SUMS_MAIN`, and `sha256sum -c SHA256SUMS_TRACES` if traces were extracted. The exact restore map translates original absolute paths into a fresh checkout. Verify the Git bundle against a clone containing the baseline before fetching its heads. Dictionary fixture hashes and lock data are included; fixture ZIPs, dependencies, browser profiles, and extension packages are not.

`repo/builds/perf/investigation-draft.md` and its original index are preserved historical snapshots. The updated top-level report and index supersede their provisional decisions. All raw files remain verbatim. Commands in the index use new output names to avoid overwriting evidence. The bundled qualification workflows retain the fixed order, source/package checks, and complete observation schedule needed to repeat the browser cohorts. Repeating a diagnostic does not change its stated limitations or turn a correctness-only run into timing evidence.

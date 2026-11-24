# Canonical local counters: evidence index

## Frozen source

Draft PR [#864](https://github.com/ManabiIO/manabitan/pull/864) publishes commit `d147a60fc4845e898d98d8924968d6094b417007`. Its tree `e3b9546229ac4118cc3e539678522446d74cff1d` exactly matches local final head `0eb65e80712eb31037792cc831f10b24b827ac7c`. Runtime was frozen in its parent `5d35b544a7bb2c74384df470e2f43faad52dde6e`; the follow-up only changes test punctuation. Base is `d24b4e56ceb1fe14ad96ef3853f4d397efa6fa26`.

The kernel keeps journal progress publication, its barrier, and all authoritative mutations in their existing order. Other counters remain local until a return or explicit trap boundary. The private ABI, seven-word header, journal layout, output layout, and JavaScript owner are unchanged.

| Artifact | Baseline | Candidate |
| --- | --- | --- |
| Canonical WASM bytes | 1,624 | 1,760 |
| Canonical WASM SHA-256 | `40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af` | `04fdb51271a20d9152b8655f33b3e6fa36a4048380ba69010a5288761143c9f0` |
| Parser WASM SHA-256 | `25149bac5db0dda3bba85fe8e133fb06d51881a822f27565e4587ba223dde41c` | unchanged |

The canonical binary grows by 136 bytes. This is not evidence of a speed or memory improvement. Both source-bound artifacts reproduce with pinned Clang and LLD 21.1.8.

## Correctness evidence

The focused suites pass 59 tests. The new native suite contains 32 complete-state comparisons against the exact source-bound baseline fixture. It covers normal returns; all negative return classes; invalid configuration; first, middle, and late row/identity/span failures; pending, published, and already-resolved cases; dense/probe exhaustion; the 4,096-exact-candidate return before a later invalid row; maximum-size input; and first/middle/late explicit traps. Every comparison includes all seven header words, configuration bytes, and every byte from the metadata prefix through the end of memory, including complete output columns, journal tails, exact descriptors, and authoritative tables. The compiler's private stack is excluded.

The existing owner differential suite now includes 64 controls, adding an AbortError from the exact-content read followed by rollback and retry. Existing controls retain pending collisions, arena growth, traps, late failures, and complete record/index-byte comparison.

Independent peer review of the frozen final tree checked each return and trap boundary, the exact-batch continuation, all journal/mutation ordering, bounded native memory accesses, and the absence of asynchronous observation during the call. It found no blocker. The root reviewer separately inspected the complete-state oracle and retained the same conclusion.

The complete locked Jitendex component oracle parses all 219 term banks and 436,555 rows. The four-bank component partitions yield 363,281 canonical unique rows, 363,243 pending rows, 38 exact hits, 55 native calls, and zero fallback groups. Each native input is captured from the production owner and replayed into independent baseline and candidate memory. Complete header/configuration/journal/output/arena bytes match for all 55 calls. Source ZIP size, SHA-256, local headers, per-bank CRC, and independently decoded row counts are checked.

For those successful calls, the frozen C statements and observed headers imply 1,089,805 baseline stores to header counters h[1] through h[5], versus 275 candidate boundary stores. The seven initial header stores per call and every h[0] journal-progress store are unchanged and excluded from that comparison. This is a deterministic source-derived reduction of repeated counter publication, not a hardware instruction or latency measurement.

This oracle does not run a browser or persist compressed content. It proves complete native-state parity on the real parsed corpus; browser import, storage, restart, lookup, and media checks are separate.

## Exploratory component screen

`canonical-local-counters-corpus.mjs bench jitendex` retains two declared warmup rounds followed by twelve balanced A/B/C replay rounds for each of the same 55 native inputs. A and C instantiate the exact same baseline module; B uses the candidate. Input copying, parsing, exact-content reads, and owner work are outside each native timing. All recorded measured rounds are retained, including two unusually slow A round totals. The shared local host was running other validation; these results are exploratory.

| Clock | B/A paired median | B/C paired median | Same-code C/A paired median |
| --- | ---: | ---: | ---: |
| Wall time | -5.5434% | -0.1902% | -6.4385% |
| Process CPU | -5.6558% | -0.7727% | -5.5781% |

No native performance gain is established: B is nearly equal to unchanged control C, while A and C themselves drift substantially. The process CPU measurements may also contain background work. The aggregate native wall-time medians are 49.6022 ms (A), 45.9795 ms (B), and 46.1904 ms (C). These are kernel totals under component partitions, not full-import latencies or a measurement of the entire canonical phase.

The analysis JSON retains every aggregate round, paired ratio, CPU measurement, and descriptive bootstrap interval. Those intervals describe local repeated native calls; they are not independent whole-import confidence intervals. The separately hosted matched browser screens will determine whether any complete-import gain is supported. No cross-device or memory claim is made.

## Files and reproduction

- `canonical-local-counters-corpus.mjs`: exact native replay harness; derived from the earlier journal experiment at commit `8282d596809d76ca2960f926719d94877925489e`, changed to the unchanged v1 ABI and full journal-byte equality.
- `canonical-local-counters-parity-jitendex.json` and `.log`: complete corpus parity, all calls and source hashes.
- `canonical-local-counters-bench-jitendex.json` and `.log`: retained component screen and exact-parity assertions.
- `canonical-local-counters-analyze.py`, `canonical-local-counters-bench-jitendex-analysis.json`, and `canonical-local-counters-analysis.log`: deterministic analysis of the retained screen.
- `canonical-local-counters-build-wasm.log` and `canonical-local-counters-wasm-check.log`: source regeneration and exact pinned rebuild check.
- `canonical-local-counters-focused.log` and `canonical-local-counters-focused-final.log`: initial and final focused green runs.
- `canonical-local-counters-types-test.log`: successful test TypeScript check.
- `canonical-local-counters-eslint.log`: retained initial formatting-only lint failure; no runtime diagnostic.
- `canonical-local-counters-eslint-fix.log`, `canonical-local-counters-eslint-final.log`, and `canonical-local-counters-eslint-style-final.log`: formatting repair and passing final lint, including the final punctuation-only commit.
- `canonical-local-counters-build.log`: passing dry build across all targets.
- `canonical-local-counters-full-unit.log`: required full suite passes on its first attempt under the pinned compiler environment with one worker: 642 files, 14,437 passing tests, 47 skipped; 472.47 seconds. Expected failure-fixture diagnostics and existing source-map warnings remain in the original log.

The harness takes `parity` or `bench` followed by dictionary names. Environment variables `MANABITAN_COMPONENT_CANDIDATE`, `MANABITAN_COMPONENT_BASELINE`, `MANABITAN_COMPONENT_CACHE`, and `MANABITAN_COMPONENT_WORKSPACE` override local paths. The baseline checkout must be at the exact d24 commit. The candidate source hashes are frozen at start and checked again after all corpus rows. Run `python canonical-local-counters-analyze.py <bench-json>` to reproduce the summary. Dictionary ZIPs, build outputs, dependencies, and expiring URLs are excluded from this evidence set.

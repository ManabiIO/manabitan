# Interned-key copy coalescing — September 9, 2026

## Decision

**Draft #30: tested allocation reduction, not a demonstrated general whole-import speedup. Nothing merged.**

This is a new production optimization on #24, separate from #26's verification-only work. The favorable preliminary three-pair JMnedict observation did not repeat in the six-pair local confirmation. Do not advertise the early 10.6% paired-median result as a confirmed improvement or treat this as resolution of #24's JMnedict gate.

## Exact source and change

Baseline: `ff9cbf2e848a86d6bbfd281179a6d753349e52f4`, tree `dc3098b9acc761caf193952537d568652196dc76`.

Candidate source/test commit: `3ef73a422410d2f0ac0be00fb8e618a4c7949416`, tree `75d9ba432ad37413b720ff2677a1dd8e6006040d`. Later documentation does not change measured code.

`compactTermRecordPreinternedPlan` previously created a subarray view and performed a typed-array copy for every referenced expression/reading key. It now copies adjacent source ranges together, preserving first-reference order and flushing on gaps or reordered nonempty keys. Zero-length keys retain metadata without empty copies. Output remains an independent, exact-sized arena; no parser slab is borrowed.

Lengths, offsets, hashes, row remaps, scratch cleanup, and full structural validation remain unchanged. No parser/WASM/ZIP, persistent format, compression level, source budget, cache bound, global worker setting, or UI change is included. The 4,096-key contiguous regression fixture needs one source view instead of 4,096; this is not a claim that every real dictionary is one contiguous run.

Both local packaged builds differ in exactly one payload: `js/dictionary/term-record-preinterned-plan.js`. Local reconstructed Git commits have synthetic IDs but match the exact remote trees. Independent jobs check out the actual remote commits, require clean sources, verify the sole packaged difference, and freeze package hashes before and after timing.

## Complete confirmation results inspected so far

Negative change means faster. Paired change is the median of within-pair ratios; aggregate change compares total time across equal work. Neither is the ratio of the separate median durations.

| Environment | Dictionary | Pairs | Paired change | Aggregate change | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: |
| Local | JMnedict | 6 | +1.47% | +1.82% | 2/6 |
| Local | JMdict | 6 | +1.43% | +0.92% | 2/6 |
| Local | Jitendex | 6 | -0.97% | -0.28% | 4/6 |
| Independent higher-memory | JMnedict | 4 | -1.71% | -1.36% | 3/4 |
| Independent higher-memory | JMdict | 4 | -2.15% | -2.02% | 3/4 |
| Independent higher-memory | Jitendex | 4 | -0.37% | -0.23% | 3/4 |

Every cell's exploratory paired-median percentile interval includes zero. Same-build A/A and B/B controls in the independent lanes vary by up to approximately 4%, comparable to these candidate effects. These small shared-host comparisons do not establish universal performance or non-regression. Runners and exploratory/confirmation samples are never pooled.

Local confirmation has 36 measured imports and six excluded warmups. Each independent complete lane has eight A/B imports, two excluded warmups and four same-build-control imports. Fixed adjacent AB/BA order, fresh browser profiles, pinned dictionaries, unchanged production defaults, no outlier removal, no import retries. The unchanged schema-3 timing runs from the browser file-input change event through post-UI import completion. Tracing, phase profiling, screenshots and process sampling are disabled during timing.

The local median sum of reported compaction-phase wall times falls from 170.85 to 125.0 ms for JMnedict and 195.05 to 141.1 ms for Jitendex. These overlapping internal phase counters are not active CPU time or quantities to subtract from total elapsed time. Faster compaction did not produce a consistent whole-import improvement.

Runtime: Node 24.20.0, Playwright 1.63, Chromium 153.0.8010.12. Local cgroup: 4 GiB and four-core quota, clang 17. A separate post-timing native page/worker check reports deviceMemory=4 and 168 exposed hardware threads; the latter is not the CPU quota. Independent higher-memory preflights report deviceMemory=16 and four hardware threads. No browser memory value was overridden. Constrained lanes are kept separate and are not included in this table without complete reports.

## Correctness

Two inspected independent validations of the exact source/test tree pass **5,495 unit tests, 46 existing skips, 159 files; 25 options tests; all four strict TypeScript projects; new-test lint; all-target dry builds; and strict Chromium integration with 86 phases and no skipped verification**. Local full units/types/options/builds also pass, with the final 17 new tests repeated after test-only lint cleanup.

The new tests cover contiguous, gapped, reversed, repeated, omitted, empty and maximum-length keys; nonzero byte offsets; SharedArrayBuffer inputs; independent output ownership; equality masks; optional offsets/hashes; malformed unreferenced metadata; and 1,000 seeded uneven plans compared with an independent per-key-copy oracle.

All **84 reports** in the complete local and higher-memory confirmation plans were re-audited for exact locked title/revision/row counts, 12 persisted-content readability probes each, no import/settings errors or fallback storage, complete bank counts and compressed/decoded source bytes, and identical deduplication counters within pairs. Independent report source SHAs match their pinned identities. These are sampled content probes and accounting checks, not exhaustive database byte equivalence.

Firefox, ARM/Android, smaller-memory systems, and repository-wide lint are not newly qualified. Inherited #24/#23/#20 release gates remain separate.

## Verification failures and evidence

Earlier runs [34337033172](https://github.com/ManabiIO/manabitan/actions/runs/34337033172) and [34337652717](https://github.com/ManabiIO/manabitan/actions/runs/34337652717) did not complete their performance plans. The inspected failed JMnedict artifacts show an audit-script fixture-schema error after a warmup: it treated the lock's keyed mapping as a list and expected `title` instead of `expectedTitle`. This was verification code, not importer failure. Initial suspicion about dependency-symlink cleanliness was not supported by those downloaded failure reports. The corrected audit was exercised against all 42 local confirmation reports. Final comparison workspaces use ordinary locked dependency directories and retain clean-tree and single-payload-difference gates.

[Final independent verification 34338285732](https://github.com/ManabiIO/manabitan/actions/runs/34338285732) uses verification-only commit `3b123cb294c3e8bc74bdecbe953e6bf787f64ac2`, while pinning product source to `3ef73a4...`. Earlier failed/incomplete matrices are not presented as green, and no incomplete lane receives an effect estimate.

Inspected final higher-memory artifacts: JMnedict `10098712452`, JMdict `10098728991`, Jitendex `10098724685`; exact-source correctness `10098781680` and earlier `10098289326`. Downloaded final artifacts were SHA-256 checked against GitHub's artifact digests. Full pairs, interval calculations, re-audit records, local reports, inspected independent artifacts, source/test patch and setup failures are preserved in the delivered evidence archive without fonts, dictionary ZIPs, dependencies, browser runtimes or generated extension binaries.

Keep this PR draft until the benefit justifies promotion. Do not merge on the preliminary sample or component counters alone. No older PR, release branch, or Reader vendor pointer was modified.

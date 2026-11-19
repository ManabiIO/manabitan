# JMdict import iteration — 2026-11-19

## Status

Twelve independent candidates completed browser qualification. Bulk publication of resolved content columns showed a small, repeated JMdict reduction across three cohorts and is ready for review in [PR #759](https://github.com/ManabiIO/manabitan/pull/759). Its full CI checks passed. It is the only candidate selected for review. The experiment set is complete; no production change has been merged.

The complete evidence contains 600 timed imports, 300 baseline/candidate pairs, and 51 dictionary jobs across 17 workflow runs. All retained import and restart checks passed, with zero protocol or content-validation failures. Small exploratory differences were frequently comparable to same-code control variation, so the remaining candidates were not promoted on their initial percentages alone.

## Scope and baseline

This round targets complete JMdict import time while preserving dictionary semantics, exact content comparison, OPFS persistence, restart behavior, and production import settings. Jitendex and JMnedict are cross-checks. Worker counts, cache limits, compression settings, fixture versions, and the measurement harness are held constant. Each candidate starts independently from the same source.

- Repository: `ManabiIO/manabitan`, `develop` baseline `d829f5b6e6a75ee8859d38d537d224ec33c4930e`.
- Baseline tree: `841406cd33f6871ab24aee771c1a7881d9e465f0`.
- Native compiler/linker: pinned Clang/LLD 21.1.8. The baseline recipe reproduced both checked-in WASM assets byte-for-byte before any native edits.
- Browser timing: Chromium 153.0.8010.12, release `chrome` packages, Node 22.22.0, Ubuntu 26.04, four logical CPUs. CPU models differ between jobs and are recorded with every cohort; comparisons are within each job, not between absolute times on different hosts.
- The [fixture lock](../../test/perf/dictionaries.lock.json) is unchanged: JMdict 526,942 rows, JMnedict 667,942 rows, Jitendex 435,448 rows.

Local timing was excluded from end-to-end conclusions. The local host was shared and noisy, and its normal Chromium launch was blocked by the environment. Independent Linux qualification branches supplied the real-browser measurements.

## Measurement contract

Both release packages are built before timing. Every observation starts a fresh Node child and Chromium profile. The authoritative timer runs from the browser file-input change event to the current import's post-UI completion signal. Preparation, archive hashing, package extraction, content probes, restart verification, and browser cleanup are outside the timer.

Initial cohorts contain four pairs in the fixed order `A1 B1 B2 A2 B3 A3 A4 B4`. The first confirmation cohorts contain twelve pairs, alternating `B1 A1`, `A2 B2`, through `A12 B12`. Publication's predeclared final replicate reverses that starting order: `A1 B1`, `B2 A2`, through `B12 A12`. A is the frozen baseline; B is one unchanged candidate. Identical-code controls use the same protocol. No slow observation, first run, or failed observation is silently removed, and there are no retries selected for a favorable result. No further publication timing follows its final replicate.

Profiling, screenshots, and process sampling are off during timing. A separate trace follows a complete successful cohort. Trace samples and overlapping worker/phase counters identify work; they are not additional wall-clock savings and are never added together.

Each qualification commit has exactly one parent—the product source commit—and changes only the isolated Linux workflow. Receipts bind every observation to its source, built package, unchanged harness, pinned archives, browser version, production flags, and OPFS mode. Every import must pass title/revision/row-count checks, twelve content probes, and post-restart reads. These browser probes are sampled verification, not an exhaustive content comparison.

Native candidates additionally undergo full-fixture parser content, score/sequence, and lookup-index format byte digests. Numeric fusion, escape witnesses, common keys, metadata-object shortcuts, and copy/hash fusion matched the baseline for every row of all three fixtures; adjacent-headword reuse matched the full JMdict fixture. These in-memory encoder-output digests do not hash every reopened OPFS byte.

## Initial browser screens

Negative percentages mean faster. Values are medians of the paired `100 × (B/A − 1)` changes, not ratios of unrelated host medians. Four pairs per cell are exploratory; the raw observations and equal-work totals remain part of the decision.

| Independent candidate                                                                               |  JMdict | JMnedict | Jitendex |
| --------------------------------------------------------------------------------------------------- | ------: | -------: | -------: |
| [Adjacent expression/reading reuse](https://github.com/ManabiIO/manabitan/actions/runs/44593578961) |  -2.93% |   -1.22% |   +9.37% |
| [Content-reference resolution](https://github.com/ManabiIO/manabitan/actions/runs/44593707694)      |  +0.50% |   -1.76% |   +3.62% |
| [Integer scan/decode fusion](https://github.com/ManabiIO/manabitan/actions/runs/44594400114)        |  +0.51% |   +3.71% |   +9.87% |
| [Cache source origins](https://github.com/ManabiIO/manabitan/actions/runs/44594801655)              |  -1.86% |   +0.24% |   +1.67% |
| [Key escape witnesses](https://github.com/ManabiIO/manabitan/actions/runs/44596274111)              | +10.28% |   -1.39% |   +5.65% |
| [Explicit owned copy with set](https://github.com/ManabiIO/manabitan/actions/runs/44596871509)      |  +6.53% |   +2.29% |   +1.39% |
| [Bulk plan publication](https://github.com/ManabiIO/manabitan/actions/runs/44597489128)             |  -1.91% |   +9.03% |   +2.06% |
| [Common structured keys](https://github.com/ManabiIO/manabitan/actions/runs/44598191500)            |  -3.22% |   +2.11% |   -1.82% |
| [Aligned shared-source copy](https://github.com/ManabiIO/manabitan/actions/runs/44598824398)        |  -0.59% |   +1.46% |   -2.43% |
| [Exact neutral metadata objects](https://github.com/ManabiIO/manabitan/actions/runs/44601088973)    |  +3.59% |   -3.03% |   -1.88% |
| [Raw glossary copy/hash fusion](https://github.com/ManabiIO/manabitan/actions/runs/44605762930)     |  +2.70% |   +0.33% |   +1.77% |
| [Terminal source retention](https://github.com/ManabiIO/manabitan/actions/runs/44609131088)         |  +6.23% |   -5.72% |   +4.62% |

The [four-pair identical-code control](https://github.com/ManabiIO/manabitan/actions/runs/44593573057) produced −3.47%, +2.45%, and −6.32% respectively. The [twelve-pair reversed-start control](https://github.com/ManabiIO/manabitan/actions/runs/44595631146) produced +1.20%, −1.63%, and +1.63%. Consequently, a small initial negative percentage alone does not establish an improvement.

The adjacent-key draft [PR #756](https://github.com/ManabiIO/manabitan/pull/756) was closed after its JMdict difference failed to separate from control variation and all four initial Jitendex pairs were slower. Its correctness results and all measurements remain available; the observed Jitendex screen is not asserted to be a universal regression.

## Confirmation and selected review candidate

Each confirmation below contains twelve pairs per dictionary. Parentheses show how many pairs were faster. Equal-work change is `100 × (sum(B) / sum(A) − 1)`; it retains the contribution of slow observations rather than summarizing only the middle of the distribution.

| Candidate and cohort                                                                                     | JMdict paired median | JMdict equal-work | JMnedict paired median |     Jitendex paired median |
| -------------------------------------------------------------------------------------------------------- | -------------------: | ----------------: | ---------------------: | -------------------------: |
| [Bulk publication, reversed start](https://github.com/ManabiIO/manabitan/actions/runs/44599069331)       |        -1.97% (7/12) |            -0.42% |          -0.20% (6/12) |              -0.72% (7/12) |
| [Bulk publication, final opposite start](https://github.com/ManabiIO/manabitan/actions/runs/44601513444) |        -3.01% (9/12) |            -4.65% |          -0.40% (6/12) |              -0.57% (7/12) |
| [Common structured keys, reversed start](https://github.com/ManabiIO/manabitan/actions/runs/44599352797) |        -0.33% (6/12) |            +0.24% |          -1.97% (7/12) | approximately 0.00% (6/12) |

Bulk publication's three JMdict cohort medians are -1.91%, -1.97%, and -3.01%; their equal-work changes are -2.39%, -0.42%, and -4.65%. This repeated direction supports a reviewable implementation, with 16 of 24 confirmation pairs faster. It does not establish a universal improvement or cleanly separate a small effect from all host variation.

The final JMdict replicate also contains two slower baseline observations: A2/B2 were 1,208.7/981.6 ms and A12/B12 were 1,222.2/991.5 ms. Most of those gaps occurred inside the bank pipeline, rather than finalization. They remain in the medians and equal-work totals; their full differences are not attributed to the changed publication helper.

Cross-dictionary tails remain material. Publication's JMnedict equal-work changes are +10.70%, +0.67%, and +5.48%; Jitendex changes are +21.09%, +0.63%, and +1.48%. The final JMnedict cohort retains B1 at 1,595.0 ms versus A1 at 964.6 ms. A negative median does not erase these observations. No claim of a cross-dictionary speedup follows from this round.

The common-key candidate's initial -3.22% JMdict median did not repeat in confirmation: its median was -0.33%, with six faster and six slower pairs and slightly worse equal-work time. It remains an unpromoted experiment.

## Mechanisms investigated

**Parser work.** Adjacent-key reuse, early integer decoding, and carrying an escape witness each remove identifiable work, but their initial whole-import measurements did not establish a gain. The common-key candidate recognizes complete literal `data`, `lang`, `style`, `href`, and `title` tokens while retaining general parsing for escaped spellings, near matches, malformed input, and every value. It leaves existing `content` and `tag` paths short. A full corpus walk found 1,870,747 newly recognized key occurrences in JMdict and 5,032,838 in Jitendex; these are opportunity counts before existing glossary reuse, not measured savings.

**Metadata publication.** The pinned JMdict contains 360,859 newly published canonical definitions across twelve production-sized groups. Their pending indexes form 3,863 consecutive runs; 99.967% of definitions belong to runs longer than one entry. The bulk-publication candidate handles a uniform codec once and copies offset/length/flag columns by run. Aliases, mixed codecs, incomplete columns, and out-of-range private inputs retain the scalar behavior. The initial JMdict result justified a separate twelve-pair confirmation; its initial cross-dictionary changes remain included.

The metadata-object parser experiment recognizes only two complete neutral shapes, `"data":{"content":"glossary"}` and `"style":{"listStyleType":"circle"}`, with the existing optional-space semantics. Other keys, additional fields, escaped spellings, malformed input, and depth limits retain general parsing. Although these shapes occur 717,914 times in the pinned JMdict before existing reuse, the observed whole-import JMdict change was +3.59%; no gain was established.

**Owned source copies.** Retained cache entries need owned bytes because the parser reuses its borrowed memory. The source remains an exact owned copy in every experiment. The pinned V8 [slice](https://github.com/v8/v8/blob/0b60d2b01800d7ba2c6eeb5e51ecd95f6dab44c7/src/builtins/typed-array-slice.tq) and [set](https://github.com/v8/v8/blob/0b60d2b01800d7ba2c6eeb5e51ecd95f6dab44c7/src/builtins/typed-array-set.tq) shared-buffer paths reach the same relaxed-copy routine. Merely replacing slice with set did not establish an import gain.

The [relaxed-copy implementation](https://github.com/v8/v8/blob/0b60d2b01800d7ba2c6eeb5e51ecd95f6dab44c7/src/base/atomicops.h) uses word copies only when source and destination alignment permit them. A separate local, fully hash-checked mechanism test found matching alignment useful and rejected a slower DataView word loop. The production candidate pads the owned destination by at most seven bytes and charges the entire backing allocation to the existing budget. WASM source allocations are already aligned: only two pinned JMdict groups have unaligned first pending offsets, 46 and 671. Only two groups are eligible, limiting the opportunity independently of the inconclusive import screen. The microbenchmark does not establish an import speedup.

Cache-selection statistics were collected without changing policy. Only 1,054 of 4,010 cross-group canonical matches (26.28%) referred to definitions that had repeated in their original group. This classifies potential matches; it is not a cache simulation including packing and eviction. A repeat-only cache policy was not implemented. Cache capacities and dictionary-specific thresholds remain unchanged.

**Owned-buffer reuse.** An additional untimed simulation reconstructed all twelve retained JMdict spans, totaling 100,724,405 copied bytes, and matched the browser's retained-byte receipt. At the current 96 MiB high-memory cache budget, pooling avoids zero allocations: the only eviction occurs for the final 9,320,869-byte span, while the evicted buffer holds only 8,478,566 bytes. No later group exists to reuse it. At 48 MiB, best-fit reuse could avoid six allocations and 47,227,574 newly allocated bytes, but it still copies every retained source byte and larger reused capacities change subsequent FIFO retention. That narrower policy tradeoff was not implemented or timed.

**Copy and hash versus grammar.** The ordinary MBR6 encoder does not run a second glossary grammar parser. After validation, it copies the source glossary and computes both xxh32 hashes in one traversal of the finished record. A complete JMdict JSON walk found 404,975 `type` occurrences, all `structured-content`, and no `type:text` occurrence; this fixture therefore does not enter the exceptional text-normalization rescan. The copy/hash candidate fuses the post-validation raw glossary copy with both hashes. It preserves the existing prefix, stages the single crossing block and short tail, and uses each full glossary block load for the output store and both hash accumulators. The existing 64–512-byte SIMD admission, scalar arithmetic, normalization branch, capacity retries, and exact duplicate rollback are unchanged. Assembly confirmed the shared load; the parser binary grows by 1,528 bytes. Its nine focused files passed 1,476 tests, including every prefix remainder, long prefixes, short crossing gaps, hash-length thresholds, source immutability, failed-growth guards, and reset. Pinned rebuild and all three full-fixture byte digests also passed. Its [fixed browser screen](https://github.com/ManabiIO/manabitan/actions/runs/44605762930) showed +2.70% paired median for JMdict, with only one of four pairs faster and +1.59% equal-work time; JMnedict was +0.33% and Jitendex +1.77%. The candidate is not being promoted.

Avoiding copies while retaining cache coverage for later groups would require independently owned, immutable parser output regions. Keeping a JavaScript view of the existing shared WASM buffer does not keep its bytes immutable after the next heap reset. Delaying the worker's existing release callback until cache eviction can stall all workers before enough new groups arrive to trigger eviction. A revised output arena and ownership protocol would need bounded capacity, separate storage/cache readers, cancellation, rollback, and reclamation rules. This is future architectural work, not a measured speedup.

A separate ownership audit found that the final pinned JMdict group retains 9,320,869 source bytes with no later cache consumer before reset: 9.25% of copied byte volume. Deduplication finishes before that cache entry is published, media collection does not insert another term chunk, and each dictionary finalizes and clears its own bulk-session cache. A narrow candidate implements an importer-owned terminal-batch plus exact final-chunk hint to suppress only that unused retention. Its 150 focused tests, changed-file lint, main/test TypeScript, and two independent source reviews passed. It preserves fallback, in-flight storage readers, source-release joins, and persistence. These byte counts do not estimate elapsed-time savings.

The [terminal-retention browser screen](https://github.com/ManabiIO/manabitan/actions/runs/44609131088) confirmed the mechanism in every observation: JMdict cached-source bytes fell from 100,724,405 to 91,403,536, while JMnedict fell from 22,788,302 to 20,575,813 and Jitendex remained zero. Nevertheless, JMdict's paired median was +6.23%, with zero of four pairs faster and +8.13% equal-work time. JMnedict was -5.72% paired median and -1.60% equal-work; Jitendex was +4.62% and +5.55%. This candidate is archived without a PR. The byte prediction was checked separately from protocol/content validity and could not remove observations from the timing record. Reduced copied work did not establish an elapsed-time improvement.

## Variation and validation limits

Several large Jitendex delays came from finalization and SQLite commit. For example, the publication candidate's B2 finalization took 1,045 ms versus A2's 146 ms with the same written byte counts. The identical-code control also had a slow A2 finalization, 672 ms versus B2's 132 ms. These observations support runtime/storage variation as a possible contributor; they do not prove a cause or justify deleting observations.

A separate code audit found no B-label-specific package, profile, timer, or lifecycle path. It did identify that the harness's ten-second cleanup wrapper does not explicitly report when its timeout wins. Playwright separately waits for shutdown and applies close-or-kill cleanup. There is no observed evidence that leaked processes caused these cohorts, and the frozen harness was not changed.

Focused correctness suites, lint, TypeScript where relevant, and full-fixture byte oracles are recorded per candidate. PR #756 also passed full CI, interruption/restart testing, and actual Chromium and Firefox functional verification with no skipped checks. Those results do not automatically qualify a different candidate or a different source revision.

The publication candidate has 140 focused publication/dedup tests, changed-file ESLint, main TypeScript, and diff checks passing. Its new cases cover empty input, untouched slots, sparse/reordered/repeated destinations, codec promotion, incomplete columns, aliases, and rollback. [Full PR CI](https://github.com/ManabiIO/manabitan/actions/runs/44602926523) passed on a merge tree identical to the measured source: unit suites, lint, all TypeScript scopes, pinned WASM reproduction, builds, and actual Chromium/Firefox extension checks. Chromium reported 90 phases and Firefox 63; both reported success with `skippedVerification=false` and actual OPFS storage. [Controlled interruption/restart](https://github.com/ManabiIO/manabitan/actions/runs/44602926771) also passed. Across eight PR workflows, 22 jobs passed and four existing conditional Edge/Android/release-upgrade jobs were skipped. The abandoned reference-resolution prototype required a later comment-placement lint correction; that local comment-only follow-up was not the source measured in its initial cohort.

## Source catalog

Every product commit below starts from the frozen baseline. Qualification commits add only the isolated workflow; their complete identities, parent relationships, package entry manifests, and run links are in the portable evidence.

| Candidate                         | Product commit                                                                                          | Disposition                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Adjacent expression/reading reuse | [`1937d0a8acb6`](https://github.com/ManabiIO/manabitan/commit/1937d0a8acb624f4daba7596633395848512f622) | PR #756 closed                           |
| Content-reference resolution      | [`10881e563b26`](https://github.com/ManabiIO/manabitan/commit/10881e563b26e6cfa8ee6741e6d7ccfbe88c7c21) | Archived experiment; not promoted        |
| Integer scan/decode fusion        | [`990ed1620c7e`](https://github.com/ManabiIO/manabitan/commit/990ed1620c7eeacbf31f83225c5bcf872f676896) | Archived experiment; not promoted        |
| Cache source origins              | [`e93f74dc949f`](https://github.com/ManabiIO/manabitan/commit/e93f74dc949f0144d0730018f43d1ae6620ee190) | Archived experiment; not promoted        |
| Key escape witnesses              | [`cdd0274ee934`](https://github.com/ManabiIO/manabitan/commit/cdd0274ee93452c9ae5a896c3a3b4d07a8f5e8bc) | Archived experiment; not promoted        |
| Explicit owned copy with set      | [`a651ddfa0da7`](https://github.com/ManabiIO/manabitan/commit/a651ddfa0da71565ee46bc4f831adfbfff542aaf) | Archived experiment; not promoted        |
| Bulk plan publication             | [`e6ff4894016e`](https://github.com/ManabiIO/manabitan/commit/e6ff4894016eac1a728dc65b7f3ac98212cb0881) | PR #759 ready for review; full CI passed |
| Common structured keys            | [`9abff9bdc8dc`](https://github.com/ManabiIO/manabitan/commit/9abff9bdc8dc92c4017b9b4a08566659da152658) | Archived experiment; not promoted        |
| Aligned shared-source copy        | [`e1ae33f04bbd`](https://github.com/ManabiIO/manabitan/commit/e1ae33f04bbd9db633c56b7848c79b68faf1e962) | Archived experiment; not promoted        |
| Exact neutral metadata objects    | [`c8acce266911`](https://github.com/ManabiIO/manabitan/commit/c8acce2669112ef1493da3f80f4b7001a1f331dd) | Archived experiment; not promoted        |
| Raw glossary copy/hash fusion     | [`7ac62861701a`](https://github.com/ManabiIO/manabitan/commit/7ac62861701ad726331f46b39eace466437c77ac) | Archived experiment; not promoted        |
| Terminal source retention         | [`19ff052517df`](https://github.com/ManabiIO/manabitan/commit/19ff052517df786e9589ad36602436aebfc45a65) | Archived experiment; not promoted        |

## Retained evidence

The accompanying [evidence directory](jmdict-iteration-20261119/) keeps the complete numeric record independently of GitHub Actions artifact retention:

- [Cohort summary](jmdict-iteration-20261119/cohort-summary.csv), [all paired timings](jmdict-iteration-20261119/raw-paired-timings.csv), and [all timed observations](jmdict-iteration-20261119/raw-observations.csv).
- [Portable qualification receipt](jmdict-iteration-20261119/qualification-evidence.json.gz): source and qualifier relationships, package entry hashes, fixture identities, browser/settings snapshots, every observation, phase counters, restart checks, and the original artifact/report hashes. Repeated manifests are stored once, with exact package deltas.
- [Publication CI receipt](jmdict-iteration-20261119/publication-ci.json): all workflow/job conclusions, actual browser results, source-tree binding, interruption/recovery evidence, and instrumentation limitations.
- [Component evidence](jmdict-iteration-20261119/component-evidence.json.gz): original UTF-8 file contents and SHA-256 hashes for local byte oracles, shape diagnostics, failed and successful test receipts, assembly, diagnostic scripts, and architecture/review notes. Local timings in this archive are not authoritative import measurements.
- [Independent verifier](jmdict-iteration-20261119/verify-evidence.py), its [verification result](jmdict-iteration-20261119/verification.json), and [file checksums](jmdict-iteration-20261119/SHA256SUMS).

The separately delivered `jmdict-import-evidence-20261119.tar.gz` contains all 51 original timing artifact ZIPs and the complete reanalysis inputs. It is 55,710,014 bytes with SHA-256 `956786fc5412c2d6cd95f6f82ce02a3335d3c1d4a9f7dd8ef46ae609999425f4`. Its 81 manifest-listed files were read back and checked against their recorded hashes and sizes. The compact repository evidence above remains usable without that larger archive or live Actions artifacts.

The verifier recomputes paired medians and equal-work totals from browser timestamps, checks complete adjacent-pair order, validates manifest hashes and source/package/fixture links, and checks retained browser and restart outcomes. It also rejects the tested cases of missing observations, changed source hashes, conflicting archives, nonadjacent pairs, and altered arithmetic. This verifies retained receipts; it does not re-execute a browser or turn sampled persisted checks into an exhaustive dictionary proof.

## Reproduction

The archived evidence can be checked offline from the repository root:

```sh
python dev/perf/jmdict-iteration-20261119/verify-evidence.py
```

For an in-memory full-fixture byte oracle, use the unchanged component driver in the selected source checkout; repeat for each pinned dictionary and compare `digest`, `rows`, and `indexBytes` with the recorded baseline. Its local elapsed time is not a browser-import result:

```sh
node --expose-gc dev/perf/import-lookup-screen.js jmdict --child --flags '{}'
```

The isolated qualification commits linked from the evidence are the executable cohort plans. They preserve exact source and package identities and upload every observation, including failures. For a single already-built arm, the unchanged wrapper is:

```sh
node ./dev/perf/import-benchmark.js jmdict --runs 1 --no-build --build-target chrome --output builds/perf/reproduction-jmdict
```

Prepare both arms with the locked dependencies, `npm run build:libs`, `npm run license-report:html`, `npm run build -- --target chrome`, and `node ./dev/perf/prepare-dictionaries.js` before beginning a fixed cohort. Keep the browser version and production defaults identical. A successful component benchmark or sampled browser check must not be relabeled as an exhaustive whole-import correctness or performance proof.

# Round five: compression setup and worker initialization — September 16, 2026

## Disposition

**No new optimization PR is warranted by this round.** Three new candidates were implemented and tested on complete JMdict and Jitendex imports. The prepared-dictionary candidate received an additional independent comparison against the actual production codec. None established a repeatable whole-import improvement sufficient to retain the added runtime code.

The earlier allocation-only PRs [#42](https://github.com/ManabiIO/manabitan/pull/42) and [#43](https://github.com/ManabiIO/manabitan/pull/43) were already closed unmerged when this review began. Their closed state was rechecked; they were not reopened, newly closed, or merged by this work. Their allocation reductions do not establish the import-runtime gains the user now requires.

[#41](https://github.com/ManabiIO/manabitan/pull/41) remains open and unchanged: its earlier libdeflate comparison had replicated whole-import gains. This new round does not add timing evidence to #41, change its source, or merge it. #39 and #40 were already merged into the baseline.

All prototypes and workflow changes are confined to this verification branch. No product branch, release ref, Reader vendor pointer, dictionary fixture lock, compression level, worker count or experimental default was changed.

## Research and implemented hypotheses

### 1. Prepare a Zstd compression dictionary once per live context

The [official Zstd manual](https://facebook.github.io/zstd/zstd_manual.html), whose public page labels itself version 1.5.1, describes the repeated setup cost of the simple dictionary API and recommends a prepared CDict for repeated dictionary compression. This is guidance for an optimization hypothesis, not evidence of a gain in Manabitan. The repository's existing Zstd source pin, `82d322c4973d9e2968d94047a40892bc6d9a9bdf`, was preserved.

The prototype adds `ZSTD_createCDict`, `ZSTD_freeCDict` and `ZSTD_compress_usingCDict` exports. It retains one owned dictionary snapshot/prepared object per live compression context, checks exact bytes plus level, rebuilds on mutation, frees the object with its context, and guards prepared-span lifetimes using record identity rather than a recyclable native pointer. Both direct and gathered-span compression paths use the new API. No larger cache history is retained.

A prepared dictionary fixes parameters at creation time, so the output need not be byte-identical to the original source-size-aware API. Candidate output was cross-decoded and actual content-write totals were audited; compression levels and dictionary bytes stayed fixed.

### 2. Share compiled WASM code with compression workers

[Google's WebAssembly performance article](https://web.dev/articles/webassembly-performance-patterns-for-web-apps) describes compiling a WebAssembly.Module once and passing it to workers for independent instantiation. [Emscripten's Module documentation](https://emscripten.org/docs/api_reference/module.html#Module.instantiateWasm) supplies the custom instantiation hook.

The prototype compiles the Zstd module once, supplies it and copied dictionary bytes to the existing compression workers, and adds an explicit initialization/ready handshake. Each worker keeps independent mutable native memory. The worker count and compression APIs/bytes remain unchanged. This candidate is rejected because its whole-import result was mixed.

### 3. Overlap independent initialization

A separate minimal candidate runs the existing Zstd initializer and dictionary fetch together instead of serially. This tests independent startup work without combining it with module sharing or changing pool admission. It was slightly slower by paired median on both dictionaries and is rejected.

## Completed full-import comparisons

Percentages are `median(100 * (B_ms / A_ms - 1))` over adjacent pairs. **Negative means faster; positive means slower.** They are not ratios of separately computed medians, confidence intervals or noise-adjusted estimates. Different hosts and controls are not pooled.

Initial cells have six alternating AB/BA pairs, three interleaved A/A pairs and an excluded complete warmup per arm. The prepared-dictionary confirmation has twelve alternating pairs starting BA, six interleaved A/A pairs and two excluded warmups.

| Candidate and cohort | JMdict | Jitendex | A/A median: JMdict / Jitendex |
| --- | ---: | ---: | ---: |
| Shared compiled WASM, six-pair production comparison | -0.388%, 5/6 faster | +0.838%, 2/6 faster | -2.721% / -0.293% |
| Overlapped initialization, six-pair production comparison | +0.778%, 3/6 faster | +0.217%, 3/6 faster | -0.735% / +1.083% |
| Prepared dictionaries, six-pair compiler-matched control | -4.027%, 5/6 faster | +0.970%, 3/6 faster | -2.087% / -1.101% |
| Prepared dictionaries, independent twelve-pair production comparison | **+1.494%, 3/12 faster** | **-0.219%, 7/12 faster** | +0.095% / -0.940% |

### The important control distinction

The first prepared-dictionary comparison rebuilt the native module with the three new exports and gave that exact same module and loader to both arms. A retained the old adapter/API, while B reused CDicts. This isolates API reuse from incidental compiler/export changes, but **A is not the shipped production codec**. The -4.027% JMdict screen is not a direct production speedup claim.

The independent comparison keeps A at unmodified production commit `b4094a423c20bb0ed424d944238f922c1b36559c`, with its original native binary, and compares the complete candidate against it. That check did not confirm a useful improvement: JMdict's paired median was 1.494% slower and only 3/12 pairs were faster. Jitendex's 0.219% lower median was smaller than its same-binary control variation. Equal-work totals were also unfavorable: +0.255% JMdict and +0.553% Jitendex. All outliers remain in the results.

**Reject the CDict prototype, rather than selecting the favorable initial screen or the near-zero Jitendex median.** Correctness tests passing does not override the performance evidence.

## Corpus, timing and storage controls

There are **196 completed imports across eight complete cohorts**: 60 measured A/B pairs (120 observations), 30 A/A pairs (60 observations), and 16 excluded full warmups. No completed import was retried, trimmed or removed.

Baseline: `b4094a423c20bb0ed424d944238f922c1b36559c`, tree `604c5c2b64b8d217e87895dbd981aa3a30579bcb`.

| Locked fixture | Revision | Term rows | ZIP SHA-256 |
| --- | --- | ---: | --- |
| JMdict 2026-09-06 | JMdict.2026-09-06 | 526,942 | `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a` |
| Jitendex 2026.08.11.0 | 2026.08.11.0 | 435,448 | `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc` |

CI: Ubuntu 24.04 x64, Node 24.20.0, Clang 18.1.3 for unchanged parser assets, Chromium 153.0.8010.12, and Emscripten 4.0.10 for the CDict native rebuild. The Zstd module grows from 433,631 to 440,200 bytes; this is not an installed-extension package-size estimate.

Original Zstd WASM SHA-256: `ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc`.
Expanded-export candidate SHA-256: `26e457ed3abbf9ab33bbf81f2351bae61c9ca8f71a57ef451b125cd3ed5024ff`.

The accepted A and B packages were actually built at the identical filesystem path. All unrelated ZIP members must agree byte-for-byte; no benchmark package member or source comment was substituted to achieve admission. The only allowed differences are the intended adapter/worker files and, for the stock-baseline CDict comparison, the rebuilt Zstd loader, maps and WASM. Parser WASM, fixture lock and benchmark harness remain identical within each cohort.

Each observation uses a fresh browser profile, real OPFS-SAH-pool persistence, production source budgets/concurrency, and `{}` flags. All ten actual worker/effective experiment receipts are checked as false. The timer remains browser file-input change through post-UI import completion. Traces, phase profiling, screenshots and process sampling are disabled. These are warmed-host, fresh-profile measurements, not separate cold-OS and warm-OS qualification.

All 196 raw reports were reread independently against their fixed plans, source/package hashes, exact dictionary title/revision/row count, twelve distributed persisted content probes, storage mode and actual browser timing. The audit also checks unchanged source bytes, bank/group/worker accounting, deduplication work and individual parser-worker maximum heaps.

Stored term-content write totals for CDict were **19,483,066 bytes in both JMdict arms** and **38,215,079 → 38,215,001 bytes for Jitendex**, a 78-byte reduction. Startup-only candidates had identical write totals. Lookup-index and record-write sizes are unchanged. This is not an exhaustive stored-byte comparison or a total-process peak-memory measurement; retained CDict memory would require separate qualification before promotion.

## Correctness tests and limits

Before timing, every complete cohort passes 114 existing focused compression-pool, content-block-store and content-deduplication tests. Each also passes a 154-case actual-codec conformance traversal covering source lengths through 262,144 characters, repeated/irregular input, three compression levels, prefix/envelope output, cross-decoding, gathered shared-buffer spans, source release after gathering, dictionary mutation/level changes, owning result buffers and invalid spans. These are repeated traversals of the same test cases, not 1,232 distinct new tests.

The startup candidates preserve all 90 compared compressed frames. CDict produces 71/90 identical frames on the synthetic traversal, while all candidate frames decode correctly. Its synthetic aggregate changes from 1,298,645 to 1,298,583 bytes; those synthetic totals are not used as corpus-storage estimates.

Ten new supplemental fake-module cache-lifetime regressions fail on the old adapter and pass on the candidate. They verify reuse, exact-byte mutation detection, changed levels/lengths, bounded shared views, context isolation, native preparation/compression failures, cleanup and native-pointer reuse. They are retained with local RED/GREEN JSON and logs in the offline evidence. Local runs use Node 22.16.0 and the earlier source workspace; they are not relabeled as current-base full CI qualification.

A local typecheck attempt completed main/dev checks but hit the 45-second execution limit during the test project. Its partial log is preserved; no complete typecheck pass is claimed. Full repository unit/options suites, full Chromium lifecycle qualification, Firefox/Safari/ARM runtime and total browser-tree memory were not established for these rejected prototypes. No prototype is represented as merge-ready merely because focused tests pass.

## Setup failures are retained, not performance observations

The first two workflow attempts stopped before timing because separate worktrees changed generated esbuild path-dependent code, not merely comments. The final protocol uses identical build paths instead. A CDict-only admission failure came from the action-installed `emsdk-cache/` directory; its exact untracked status was recorded and only that tool directory was excluded. The first production-baseline attempt omitted the two rebuilt loader members from its explicit allowed list and therefore stopped before imports; the corrected list admits those intended files, not arbitrary differences.

These failures were benchmark setup errors, not measured candidate slowdowns or failed imports. They are not counted among the 196 completed imports. Original failure artifacts and run links remain available. A non-fatal compiler cleanup warning about moving its temporary directory to Trash is retained in the build logs.

## Reproduction and exact runs

- [Initial separate-worktree setup attempt](https://github.com/ManabiIO/manabitan/actions/runs/35055991663)
- [Second setup attempt, rejected executable mismatch](https://github.com/ManabiIO/manabitan/actions/runs/35056112752)
- [Actual same-path startup comparisons; CDict tool-directory admission failure also retained](https://github.com/ManabiIO/manabitan/actions/runs/35056287338)
- [Completed compiler-matched CDict comparisons](https://github.com/ManabiIO/manabitan/actions/runs/35056500927)
- [First stock-baseline admission attempt](https://github.com/ManabiIO/manabitan/actions/runs/35056885231)
- [Completed independent stock-baseline confirmation](https://github.com/ManabiIO/manabitan/actions/runs/35057269457)

The immutable input/driver revisions are linked through each workflow. Accepted artifacts include the executed driver inputs, exact source patch, fixed plan, source and package identities, every raw report and a completion marker. CDict artifacts also preserve the exact candidate codec. Artifact retention is 30 days. The offline bundle contains all eight complete artifacts, representative setup failures, supplemental tests, research links and an audit script that reconstructs every result from raw reports.

**Final result: leave #42/#43 closed, retain #41 unchanged, and open no new optimization PR from this round.**

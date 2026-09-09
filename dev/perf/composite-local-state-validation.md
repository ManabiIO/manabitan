# Composite local-state parser experiment: not accepted

Do not merge this branch as a general import-speed optimization. Product source commit `ef879f0c5bbe0e57670ddbed579a69c8435ae21c` is preserved for review, but the corrected local comparison shows a repeatable JMdict regression. No release promotion was performed.

Baseline: PR #20, `394d8eb799dd1eb5e194cee11472a4beab915080`. Candidate C/test tree before this report: `7861e3696323cef9dd0f26c1ab798ea8b1c52fca`. Only `parse_composite_span_impl` and its new regression tests change; ZIP, hash functions, compression, cache admission, and storage formats do not.

## Completed full-import comparisons

Negative paired change means faster. Percentages are medians of `(candidate / baseline - 1) * 100` for adjacent pairs, not ratios of separate medians. Hosts are not pooled and no outliers are removed.

| Host | Dictionary | Pairs | Baseline median ms | Candidate median ms | Median paired change | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Independent GitHub runner | JMdict | 8 | 1592.75 | 1599.85 | +0.66% | 2/8 |
| Independent GitHub runner | JMnedict | 8 | 1457.25 | 1450.20 | +0.08% | 4/8 |
| Independent GitHub runner | Jitendex | 8 | 2856.15 | 2793.75 | -2.05% | 8/8 |
| Strict local 4 GiB container | JMdict | 6 | 1787.65 | 1906.30 | +6.30% | 0/6 |
| Strict local 4 GiB container | JMnedict | 6 | 1536.80 | 1482.25 | -2.67% | 3/6 |
| Strict local 4 GiB container | Jitendex | 6 | 3921.50 | 4074.25 | +2.93% | 3/6 |

Each host used one separately excluded warmup pair per dictionary, fresh browser profiles, the locked JMdict/JMnedict/Jitendex archives, production defaults, and the unchanged schema-3 browser file-input-change to post-UI-completion timer. Tracing and process/phase profiling were disabled during measurements. The CI result is a narrow Jitendex improvement, not a cross-host general win.

CI run: https://github.com/ManabiIO/manabitan/actions/runs/34293672171 . Artifact `composite-state-verification`, ID `10082594331`, SHA-256 `c9549837f5717cf4a78a048ac9ecfb70e7334da2f178faece2ce327eab0a5112`. It contains 48 measured imports and six excluded warmups. The later strict local run contains 36 measured imports and six excluded warmups.

The runner used clang 18.1.3, Node 24.20.0 and Chromium 153.0.8010.12 on an AMD EPYC 7763 with four logical CPUs and about 16 GiB RAM. The local run used clang 17, the same Node/Chromium versions, an AMD EPYC 9V74 host, four-core cgroup quota and 4 GiB cgroup memory limit. Production selected different ZIP inflation routes on these hosts; no policy override was used.

## Build-isolation correction

An earlier local comparison had physical dependencies inside the baseline worktree and a symlink in the candidate. Esbuild consequently embedded different dependency paths into 20 packaged library payloads. That run was stopped between invocations, marked invalid, and excluded in full, including its 28 completed measured rows and six warmup rows. Its raw reports remain preserved for audit. The no-snapshot screening experiment had the same setup issue and is not clean quantitative evidence either.

Both worktrees were then rebuilt against the same external dependency directory. Before the strict comparison, every ZIP member and file payload was compared. Exactly two packaged files differed: `lib/term-bank-parser.wasm` and `js/dictionary/wasm/term-bank-parser.c`. Their SHA-256 values were recorded and the archive hash was checked before every invocation. No source or package changed during the completed comparison.

Local parser WASM: baseline `f734104d5933719059406387dd07de2148c8612a7ae02f2bd5bb92eef80cfc56`; candidate `4a2cb86f9274db2efd3b9fc5e9e7c7d0ea4810c380662b55500466b35694aeb2`.

## Correctness

The independently completed workflow passed 5,441 unit tests with 46 skips, 25 options tests, all four strict TypeScript projects, and strict Chromium E2E with 83 successful phases and no skipped verification. All measured CI imports passed exact title, revision, row-count and 12 persisted-content probes. All 24 CI pairs also match exact parser/dedup outcome counters. Persisted-content probes are sampled, not exhaustive database equality.

A local exhaustive differential matched all 1,630,332 rows across 338 term-bank files: raw parser metadata with and without hints, encoded content bytes, canonical mappings/signatures, strings, lookup-index bytes, and media data. Another 59,890 generated mutation comparisons matched acceptance and metadata. The first differential harness mistakenly hashed unused WASM heap bytes; correcting it to hash the logical copied output ranges eliminated that test-harness mismatch without product changes.

The new test file contains 52 cases covering container transitions, escaping, literals, 256-level depth handling, hints after restoring parents, and 1,800 deterministic JSON-validity comparisons. These correctness results do not override the measured performance regression. Firefox was not rerun; PR #20's existing sign-off limitations remain separate.

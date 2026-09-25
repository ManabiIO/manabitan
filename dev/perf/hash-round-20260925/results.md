# Further import benchmarking — SIMD content hashes

## Decision

Hold the SIMD candidate in research. No new production PR, default change or merge is made in this round. This work did not modify PR #291.

The hash kernel is substantially faster in isolation and correctness checks pass. Complete-import measurements suggest small JMdict and WTY improvements, but they are close to ordinary unchanged-code variation. This is not evidence that the effect is exactly zero; it is insufficient evidence to advertise a strong or general import improvement.

## Exact candidate

Product baseline: `76362775484661b3cd8b9d2c84b228802c023a76`.

The candidate replaces only the 16-byte stripe loop in `hash_content_xxh32_pair` with two four-lane vectors. The two seeds share the loaded/multiplied stripe, retaining the same lane reduction, tail and hash finalization. The production build already uses `-msimd128`. No cache, feature flag, worker count, batch threshold, compression level, dependency, persistence format or dictionary-specific heuristic is added.

- Baseline C SHA-256: `b65eebac1d7a83eeb6ae14969069afc376a0084ddb0f6ffa01a84d1266dde108`
- Candidate C SHA-256: `b9896a9f98e4d018d2b7431818be2ab63f76a87f8bfea49190ac1b9e56f37e7e`
- Remote baseline Wasm: 42,324 bytes; SHA-256 `1fabe63bd6cdf98ba987f9b5c6848e48a08bd526e44f3d0332868ee49d8b6ee5`
- Remote candidate Wasm: 42,813 bytes; SHA-256 `954f684244f9f3e965bc31e43cb60c290c7c5a6cad5dfc16f8cb1204c3c373ce`

`prepare.py` in this directory reconstructs both exact C sources with SHA checks. The proposed product patch and all raw artifacts are also retained in the downloadable session evidence.

## Independent complete-import confirmation

Twelve adjacent paired imports per row, alternating order, with fixed excluded warmups and bracketing/interleaved A/A controls. Negative is faster. Percentages are medians of per-pair changes, not ratios of arm medians. Each row has its own host; absolute times and percentages must not be combined across hosts or flags.

| Dictionary | Configuration in both arms | Baseline median ms | Candidate median ms | Median paired change | Faster pairs | Median absolute A/A change |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | Pinned production defaults | 1388.05 | 1371.15 | -1.363% | 10/12 | 1.662% |
| JMnedict | Pinned production defaults | 1201.15 | 1204.70 | -0.206% | 6/12 | 2.270% |
| Jitendex | Pinned production defaults | 2473.20 | 2470.35 | +0.314% | 5/12 | 0.955% |
| WTY English | Pinned production defaults | 7627.75 | 7546.45 | -0.986% | 10/12 | 0.790% |
| JMnedict | Generic shared-span compression on | 1138.25 | 1133.80 | +0.371% | 5/12 | 2.702% |
| WTY English | Generic shared-span compression on | 5225.40 | 5120.15 | -1.649% | 7/12 | 1.154% |

A/A is unchanged baseline code in both arms. Its median absolute change is a description of observed variation, not a confidence interval or a formal significance threshold. No subtraction of A/A noise, trimming, cross-host pooling or retries replacing unfavorable timings was performed.

The earlier six-pair screen measured JMdict -3.886% (5/6 faster), Jitendex -1.543% (4/6), JMnedict -0.024% (3/6), and WTY -0.590% (5/6). The independent confirmation narrows the initial result. Jitendex and JMnedict do not establish a useful gain here; WTY's composition result is small and inconsistent. The implementation remains available for review without adding another weakly qualified product PR.

## Scope and audit

There are 336 successful complete browser timing observations: 96 screening and 240 confirmation. They include 20 excluded warmups, 192 candidate/baseline measurement observations and 124 unchanged-baseline control observations.

Every import starts a fresh Chromium profile, uses pinned archives and real OPFS-SAH-pool storage, and measures the browser's monotonic file-input-change event through import/UI completion. Builds, downloads and post-import probes are outside timing. Tracing, profiling, screenshots and process sampling are disabled. Both arms are rebuilt at the same path from their SHA-checked C and Wasm. Actual worker-flag receipts, complete dictionary row counts, twelve persisted-content probes and package hashes are recorded.

The checked audit finds identical stable work in every pair and control: source/encoded bytes, row/chunk/group/worker counts, parser fallbacks/discarded rows, deduplication counts, content/index write totals and parser Wasm heap highwater. Worktree dirty bits accurately distinguish restored scalar source, candidate changes and benchmark-only WTY harness changes.

Off-clock full-corpus verification matches every canonical parsed content record/hash and prepared lookup-index digest across 3,273,372 rows in the four distinct pinned dictionaries, including separately labeled composition configurations. Every archive/lock identity matches. Package-member checks find only the C source and parser Wasm differ. This is exhaustive at the parser/lookup preparation boundary, not an exhaustive comparison of all persisted database records.

## Correctness

Final isolated product validation passes:

- 7,355 unit tests, with 46 existing skips; 27 options tests.
- All four TypeScript projects, changed-file ESLint and the full build.
- All seven newly added hash cases also pass on the unchanged scalar baseline.

The new cases cover the actual 15-byte empty payload, all vector-tail residues, large payloads, Unicode/escapes/control characters, structured content, duplicates, multiple banks and repeated invocations. Final test blob: `0964896757af6caa5dd413c52cb68f12fcf1af2f`; SHA-256 `4d1c650535f76b78bca67b2c7f45e1e3784903c460f4ba233be3285955d71c26`.

Both Chromium lifecycle configurations pass all 86 phases: pinned defaults and generic shared-span compression enabled. Initial import receipts confirm the chosen compression flag; later lifecycle scenarios deliberately reset or supply their own settings. Both use the exact benchmarked candidate C/Wasm. No Firefox, Safari, ARM or whole-browser peak-memory improvement is claimed.

Local actual-Wasm differential testing additionally passes 100,113 cases, including 90,113 comparisons against the scalar JavaScript hash oracle and 8,193 inputs ending at the Wasm memory boundary. A preceding extracted-function sweep checks 65,536 length/alignment/seed combinations. The kernel microbenchmark is roughly 28–53% faster for the tested full-stripe input sizes, but that is not a complete-import speedup.

## Other candidate and retained failures

A native system-libzstd 1.5.7 prepared-dictionary pilot reduced small-block overhead but was effectively flat at larger tested sizes: approximately 0.222/0.220 ms at 256 KiB and 0.983/0.980 ms at 1 MiB. The 1 KiB case also changed compressed bytes. This native-only result does not qualify a Wasm/browser optimization; no new compression-context ownership/cache is promoted.

The first SIMD setup had two incorrect test expectations: a tagged empty glossary string occupies 18 encoded bytes, not fewer than 16. Those assertions were corrected without changing the scalar hash oracle or product C; actual 15-byte payload cases were added separately. No browser timings ran during that failed setup. The initial new-test array-push lint failure is also retained; it was fixed without changing fixtures. Final validation is green.

## Reproduction and retained runs

- Initial failed setup: https://github.com/ManabiIO/manabitan/actions/runs/36166511877
- Four-dictionary screen: https://github.com/ManabiIO/manabitan/actions/runs/36166677793
- Twelve-pair independent confirmation/composition: https://github.com/ManabiIO/manabitan/actions/runs/36167089154
- Initial full tests: https://github.com/ManabiIO/manabitan/actions/runs/36166746908
- Both complete Chromium lifecycles: https://github.com/ManabiIO/manabitan/actions/runs/36167473371
- Final full suite, lint, types, build and scalar baseline: https://github.com/ManabiIO/manabitan/actions/runs/36168574809

Immutable screening input: `74872bfa8ef94ded749dcf0a5ae862eacb3ce3f0`. Confirmation input: `68a01320869e091a90344df7e9f992329b7e8eec`. Final validation input: `4c86f1e33bd3087cfaf7db7f40b9ae663da95c83`, which isolates only the proposed C/test changes from the research tools. No product C changes occurred after benchmarking began.

WTY's benchmark-only fixture pin and two larger off-clock probe buffers are applied equally to both arms. All other fixtures use the committed lock. Existing #291 timings are not pooled into this experiment. Raw artifacts, audit code and a proposed two-file patch are supplied with the session; no font files or full extension packages are included.

# Native content copy/hash experiment — 2026-11-23

**These results do not establish a browser import improvement.** The native candidate improved the isolated Node Jitendex component screen, but neither the three browser screens nor the independent Jitendex regression assessment established an elapsed-time benefit. The browser point estimates in the independent assessment lean slightly slower. All observations are retained, including the first candidate tails.

The source experiment is [PR #840](https://github.com/ManabiIO/manabitan/pull/840). This evidence does not support describing it as a browser import optimization or claiming non-regression at a prespecified margin.

## Frozen source and protocol

| Role                          | Commit                                     |
| ----------------------------- | ------------------------------------------ |
| A and C: current baseline     | `467067650653c37c1f7d6b05d6737d070e1259cd` |
| B: native copy/hash candidate | `44686ef6ebaafa624e6d228494719bbed4cb8ef4` |

C uses the exact A worktree and built release archive. Package entry differences are limited to `js/dictionary/wasm/term-bank-parser.c` and `lib/term-bank-parser.wasm`. The candidate WASM SHA-256 is `76d5ff90500bbe10482be44b19fe6d33773b5caa0e84ca5d1c99e5b7860b43ba`, matching the isolated component artifact.

The browser studies use release `chrome`, Chromium `153.0.8010.12`, Node `22.22.0` orchestration, full locked source archives, fresh harness processes/profiles, production defaults, and no import flags. Tracing, phase profiling, screenshots and process sampling are disabled. Native harness and lock hashes must match across frozen arms; no harness overlay is applied.

Each six-block screen uses `ABC, CBA, BAC, CAB, BCA, ACB`. The independent 12-block assessment appends those six orders in reverse order. Every timed observation includes post-import verification and deterministic media sampling. Separate exhaustive A/B media runs follow the fixed cohort. There are no excluded warmups, retries, tail exclusions or optional stopping.

## Six-block browser screens

Each dictionary runs on its own hosted runner. Negative percentages favor B. Intervals are descriptive 95% percentile bootstrap bounds for the median of block-paired percentage changes: 10,000 resamples, seed `20261123`, without multiple-comparison correction. Six pairs provide limited precision.

| Dictionary | B/A paired median, interval | B/C paired median, interval | Identical-product C/A, interval |
| ---------- | --------------------------- | --------------------------- | ------------------------------- |
| JMdict     | −0.08% [−1.86, +3.32]       | +0.30% [−8.01, +2.55]       | −1.03% [−2.38, +11.49]          |
| Jitendex   | −1.53% [−4.81, +9.32]       | +2.04% [−5.20, +12.26]      | −2.55% [−4.83, +1.85]           |
| VNDB       | −0.60% [−5.62, +15.50]      | +0.82% [−1.22, +20.67]      | −4.09% [−6.68, +1.17]           |

| Dictionary | A median   | B median   | C median   | Equal-work B/A | Equal-work B/C |
| ---------- | ---------- | ---------- | ---------- | -------------- | -------------- |
| JMdict     | 696.10 ms  | 696.70 ms  | 698.15 ms  | +0.43%         | −2.07%         |
| Jitendex   | 1550.35 ms | 1524.90 ms | 1506.85 ms | +0.88%         | +2.79%         |
| VNDB       | 6096.40 ms | 5903.85 ms | 5902.85 ms | +3.33%         | +6.88%         |

Equal-work change is the ratio of summed candidate and baseline durations minus one. It differs from both the paired median and the ratio of arm medians. These screens are inconclusive; the apparent gains against A are not corroborated against C.

Source: [screen run 45217337782](https://github.com/ManabiIO/manabitan/actions/runs/45217337782), tooling `e7deeaad9c125d9ca64f2a30b86f5d920223aafa`; complete `analysis.json`, observations and raw reports are in the three `screen-*.json.gz` bundles.

## Independent Jitendex regression assessment

The later 12-block cohort was commissioned to assess browser regression uncertainty after the inconclusive screen. It does not represent a passed favorable-screen gate, and its observations are not pooled with the screen.

| Comparison  | Paired median | Descriptive 95% interval | Equal-work change | Faster B pairs |
| ----------- | ------------- | ------------------------ | ----------------- | -------------- |
| B/A         | +1.14%        | [−0.12%, +1.76%]         | +0.58%            | 4/12           |
| B/C         | +1.06%        | [−1.74%, +2.07%]         | +0.40%            | 4/12           |
| C/A control | +0.52%        | [−2.10%, +2.46%]         | +0.18%            | —              |

Arm medians are A **1319.80 ms**, B **1335.85 ms**, C **1329.85 ms**. This independent cohort does not show a benefit; its intervals still include zero. No non-inferiority margin was prespecified. Absolute timings from different hosted jobs must not be treated as before/after measurements.

Source: [regression-assessment run 45219732604](https://github.com/ManabiIO/manabitan/actions/runs/45219732604), tooling `882a77df53eb2684108b54383d13bcb0156dfa9b`; complete evidence is in `regression-jitendex.json.gz`.

## Component and phase limits

The isolated four-pair Jitendex parser/lookup screen used **Node `24.22.3`**, the same complete archive and WASM identities, and matching full output digests. Its paired median was **−8.51%**, with equal-work **−10.60%** and 4/4 faster pairs. That engine and execution context differ from Chromium. The raw receipt is preserved in `analysis-support.json.gz` as `component-jitendex.json`.

In the independent browser cohort, median accumulated `parserParseBankMs` is A/B/C **1031.5/1034.0/1014.5 ms**. This counter brackets native parse-and-encode plus CRC verification. Inflation happens before that call and is recorded separately. Parser and worker counters accumulate elapsed work across groups; buffer setup encloses parsing, and worker, dispatch and storage scopes overlap. They are not CPU measurements or additive wall-time components. Full phase values are preserved without synthesizing a wall-time budget.

## First-candidate tails

The first B observations in the screens were **1779.7 ms** for Jitendex and **8144.2 ms** for VNDB. Both remain in every reported statistic. The audit found no demonstrated harness/setup asymmetry: all 20 observations per dictionary have distinct startup extension origins, empty startup dictionary/OPFS inventories, matching controls, and the same parser route. These facts support the frozen implementation's fresh-profile setup.

The cause remains unidentified. For VNDB, first-B native parse was **6147 ms**, below the later five B observations' median **6955 ms**, while importer sink elapsed was **6172 ms** versus **3776 ms**. Those overlapping counters do not identify cold compilation or another specific cause. Reports lack PID/profile-path receipts, and bounded cleanup waits plus an absence of warnings do not prove every child exited or exclude external contention. `first-b-audit.json` inside the support bundle preserves the selectors, per-observation values and limitations.

## Correctness and retained evidence

All **98 browser observations** completed: 90 timed imports and eight separate exhaustive diagnostics. Checks include locked archive identity, full row inventory, strict OPFS, restart, 12 fixed production lookup probes over six passes, matching lookup/media receipts and logical storage size. Row counts are JMdict **528,299**, Jitendex **436,555**, VNDB **6,648,310**. Exhaustive checks cover every referenced image: Jitendex **236 files / 4,992,155 bytes**, VNDB **146,570 files / 188,131,284 bytes**. These checks do not claim to decode every persisted term after each browser import.

Separate native byte-oracle receipts cover all **7,613,164 rows / 937 term banks** across the three dictionaries, with matching parser/content/index digests and index byte counts. The JMdict and VNDB passes are correctness-only; their elapsed counters are not performance comparisons. The complete local unit rerun passed **641 suites / 14,377 tests**, with **47 skipped**. The initial run failed two suites because a supported WASM compiler was unavailable; both logs remain in `native-validation.json.gz`, alongside the all-target build dry-run, test typecheck, generated-WASM check and both oracle runners. Its metadata maps the local candidate commit to the identical published tree.

[index.json.gz](index.json.gz) records bundle hashes, original artifact IDs/digests and source identities. The four source bundles preserve all **782 original artifact files**, including raw JSON/HTML reports, command logs, protocol, workflow/runner bytes and source/package receipts. Every original ZIP size and SHA-256 was verified on retrieval. Every embedded file has a byte length, encoding and SHA-256, and was checked after gzip round-trip. Only this README is uncompressed.

- [screen-jmdict.json.gz](screen-jmdict.json.gz)
- [screen-jitendex.json.gz](screen-jitendex.json.gz)
- [screen-vndb.json.gz](screen-vndb.json.gz)
- [regression-jitendex.json.gz](regression-jitendex.json.gz)
- [analysis-support.json.gz](analysis-support.json.gz): component receipt, independent verification, phase comparisons and first-B audit
- [native-validation.json.gz](native-validation.json.gz): complete native parity receipts, oracle sources and local validation logs

Each bundle is a gzip-compressed JSON object with a `files` array. Decode each entry's `content` using its `encoding` (`utf8` or `base64`) and verify its `sizeBytes` and `sha256`. The original Actions artifacts expire; these bundles retain their complete file contents without depending on live artifact availability.

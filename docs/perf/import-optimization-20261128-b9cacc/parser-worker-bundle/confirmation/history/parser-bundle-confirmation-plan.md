# Proposed parser-bundle confirmation and browser reliability plan

Status: prepared before the initial six-pair results; **not launched or published**. Promotion remains the parent's decision after the fixed initial cohort. No runtime change is proposed.

## Frozen identity

- Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
- Candidate: [`9da7dedd17535b4a0f8edb97e56756049bbad7a7`](https://github.com/ManabiIO/manabitan/commit/9da7dedd17535b4a0f8edb97e56756049bbad7a7), tree `ee65e5a994b4017a443893dc7b0b268900538e94`.
- Changed existing package member: `js/dictionary/term-bank-wasm-parser.js`; sole added member: `js/dictionary/term-bank-wasm-parser-worker.bundle.js`; no removals.
- Generated bundle: 174,314 bytes, SHA-256 `f6c0c2b6c19f686d1280cc0c456357a944208a2e9f56a588788a8da58e4611a6`.
- [Initial qualification run](https://github.com/ManabiIO/manabitan/actions/runs/46104747758) remains intact, including every failure. The confirmation workflow must use explicit candidate and harness refs above, not its own new workflow commit as the runtime ref.

## 1. Independent JMdict confirmation

Use the candidate's unchanged `dev/perf/import-qualification-20261125-a7f7.py` in two fresh hosted jobs, one initial AB and one BA, with `--pairs 12`. Reuse the initial workflow's exact setup, Chromium installation, archive lock, strict runtime, source/package validation, always-run evidence printing and uploads. Production flags stay `{}`; do not force worker counts or allow headed fallback.

Each host therefore runs the existing two warmup pairs, 12 alternating candidate pairs, and four interleaved A/C identical-code control pairs. Every browser observation uses a fresh profile. A and C remain byte-identical. After timing, run the existing exhaustive verification and separate four-observation memory schedule (ABBA on the AB host, BAAB on the BA host). Retain the existing whole-tree PSS/private-memory gates: median paired increase at most 5%, no pair over 10%, every observation qualified.

Register both schedules and exact source/package/fixture/harness identities before observation. Stop on the first failed observation and keep all evidence; do not replace bad samples, pool hosts, or tune the plan after seeing results. Audit raw summaries, receipts, source identities and sampled-memory coverage independently, as for the initial cells. Report both host medians, equal-work ratios, all 12 pair ratios, worst pairs, faster-pair counts, the unchanged descriptive bootstrap intervals, and the A/C controls. Inspect confirmation separately from the initial screen; do not pool them into a larger apparently independent sample.

The parent registered these **prospective review criteria before any initial bundle timing existed**. Each independent 12-pair host must satisfy all of them:

- Median paired time improvement at least 3%: `100 * (1 - median(B_i / A_i)) >= 3`.
- Median paired absolute saving at least 20 ms: `median(A_i - B_i) >= 20`.
- Equal-work improvement: `sum(B_i) / sum(A_i) < 1`.
- At least 10 of 12 pairs faster.
- The existing descriptive 95% bootstrap interval for the paired median percent change lies wholly below zero, using its unchanged 10,000 resamples and seed 897.
- The median paired percent gain exceeds the absolute A/C identical-code control median drift; do not subtract control drift from the candidate result.

These are review thresholds for this small build change, not a universal statistical claim. A failed review criterion does not truncate or invalidate an otherwise successful acquisition: preserve the complete registered cohort and report the failure. Acquisition still stops only for the existing observation/protocol failures. All semantic, package, media, memory and reliability gates remain mandatory. The initial Jitendex and VNDB cells stay separate; any repeated material regression blocks promotion pending resolution.

## 2. Actual Firefox extension smoke

Reuse [`test/firefox/extension-two-dictionary-import.e2e.js`](https://github.com/ManabiIO/manabitan/blob/9da7dedd17535b4a0f8edb97e56756049bbad7a7/test/firefox/extension-two-dictionary-import.e2e.js) and the existing Firefox workflow's Firefox Developer Edition/WebDriver setup. Build `firefox-dev` from the exact candidate, copy its ZIP to XPI, verify the generated member's fixed hash, and record XPI hash, source/tree, browser version/binary hash, Node version and harness hash before launch. Prepopulate all three cache names using `loadDictionaryFixtures()` and `ensureFixtureFile()` from `dev/perf/dictionary-fixtures.js`; the Firefox harness eagerly ensures Jitendex, JMdict and JMnedict even in the focused mode. This prevents unpinned recommended-feed downloads.

Use a fresh temporary Firefox profile, `MANABITAN_E2E_STRICT_RUNTIME=1`, `MANABITAN_FIREFOX_HEADLESS=0`, `MANABITAN_FIREFOX_RECOMMENDED_SECONDARY=JMdict`, and the existing `MANABITAN_FIREFOX_FOCUSED_BASELINE_ONLY=1` option under Xvfb. This route performs real Jitendex and JMdict recommended-UI imports, concurrent lookup, and backend content-integrity verification, then omits unrelated update/hover stress. It does not change parser/storage behavior.

Add only a post-run evidence assertion: require report `status === 'success'`, no skipped verification/reason, OPFS SAH-pool diagnostics, successful result, zero import/settings errors and no fallback storage for **both** import-debug objects already retained in the resource-profile phase details. Require a `term-file-fast-path:` phase with positive integer `parserParallelWorkerCount`, positive group count and no parallel skip reason. This prevents success through the serial fallback from masquerading as bundle coverage. Exact package identity plus the only production Worker URL pointing to the bundle makes this a real `moz-extension:` module/CSP/WASM-resource smoke. Retain the JSON/HTML report, geckodriver log, live report and crash artifacts. The existing workflow permits some unsupported-runtime skips; this qualification must reject them. No product or harness overlay is needed.

## 3. Existing Chromium restart/interruption campaign

Run the exact candidate's [`chromium-restart-interruption.yml`](https://github.com/ManabiIO/manabitan/blob/9da7dedd17535b4a0f8edb97e56756049bbad7a7/.github/workflows/chromium-restart-interruption.yml) steps and full existing report enforcement: stable-key `chrome-playwright` build, process-tree selector test, fresh evidence directory, witnessed authoritative payload write, owned-process SIGKILL, strict OPFS recovery, all-or-nothing old/new generation oracle, and completed 350,001-term update oracle. Keep the current timeout, hook and witness requirements unchanged; preserve failed evidence.

Record and verify the same bundle digest before and after the existing test-only storage observer is installed. The original package and instrumented extracted tree have distinct identities already captured by the harness. This campaign is reliability evidence, never import timing. Its current large fixture has one term bank, so it does **not** establish parallel-parser cancellation coverage; native startup-cancellation units and the real multi-bank Firefox/ordinary Chromium imports cover different risks. Do not overstate this test's scope.

## Decision boundary

Launch only after parent review of the fixed six-pair JMdict/Jitendex/VNDB cells and this registration. All validation, exact package checks, semantic/media receipts, unchanged memory gates and both browser reliability jobs must pass before a PR is proposed. Firefox or interruption skips/failures remain blockers to the corresponding reliability claim. Keep the source-constant trim separate; bundling already removes those worker-only unused imports.

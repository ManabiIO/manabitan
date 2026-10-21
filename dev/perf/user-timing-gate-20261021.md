# User Timing retention and browser qualification — 2026-10-21

Every ordinary lookup and rendered result previously created persistent User Timing marks/measures. The wrapper never cleared these entries. Its upstream history still contains the original unconditional implementation (`yomidevs/yomitan` safe-performance commits `b39bd51ea78987f0ce60c934a2a80a1f000cfd7c` and copyright-only updates through `6b93c538e80208011ac6bd081ef1ccde09235320`). This is a focused fork-local instrumentation change.

The candidate requires explicit boolean `globalThis.manabitanPerformanceInstrumentationEnabled = true` to emit marks/measures. It preserves `now()`, operation health timings, production algorithms, storage formats and dictionary semantics. Explicit browser profiling opts in. Production contexts avoid persistent instrumentation allocation; no speedup is assumed.

A Node 22.22.0 retention check ran 2,000 pairs of marks plus one measure: baseline retained 6,000 entries, candidate default retained zero, candidate profiling retained 6,000. This is retention correctness evidence, not browser latency or a memory-byte measurement. Focused runtime, lookup-availability and render-ownership suites passed 45 tests. Local timing was excluded because the host load was roughly 550–590 on ten logical CPUs.

## Browser experiment contract

- Compare the candidate with `a2ef0f168c26553cba01cf363faf319eabdbeb05`, which includes the independently qualified runtime fixes.
- Target eliminated work: persistent User Timing allocation on scanner/translator/render paths. No import flags, dedupe, caches, worker counts or buffers change.
- Build both arms before timing. Use the same candidate measurement harness and import tools, `chrome` release packages, pinned source ZIPs and Playwright browser, fresh profiles, OPFS, production import settings, and disabled profiling/screenshots/process sampling.
- Run A1 B1 B2 A2 on a separate runner for each of JMdict import, Jitendex import and full lookup lifecycle. Preserve host snapshots before/after, package/harness identities, all raw results and failures.
- Import acceptance: exact title/revision/term count, twelve first/middle/last content probes, no fallback/errors/skips, durable post-UI completion. Existing full functional browser checks cover additional content/lifecycle semantics; sampled probes do not establish exhaustive content equality.
- Lookup guardrails: strict full lifecycle, request-fresh visible results, first and repeated hover samples and their scanner/popup timings. Lifecycle first hover follows production prewarm readiness; automation totals include pointer motion and setup and are not pure intent-to-visible latency.
- Reject a latency claim if bracketed deltas are small or opposite-signed, correctness differs, or any runtime verification is skipped. Retention correctness can justify the small gate independently; do not claim an import or visible-hover speedup from a microbenchmark.

## Reviewed browser results

The release-package [ABBA run](https://github.com/ManabiIO/manabitan/actions/runs/39533806321), [reversed BAAB run](https://github.com/ManabiIO/manabitan/actions/runs/39534453226) and [same-code control](https://github.com/ManabiIO/manabitan/actions/runs/39534451381) all completed. Every source import used the locked source ZIP, dedupe and OPFS, matched title/revision/row counts and twelve readable content probes, and reported no skipped verification. Traces ran separately after timing and are diagnostic only.

Browser was Chromium 153.0.8010.12 on four AMD EPYC 7763 vCPUs with Node 22.22.0. Per-observation host snapshots, archive identities, full reports and package-entry hashes are in the artifacts. Baseline and candidate package contents differ only in `js/core/safe-performance.js`; the same-code control has zero entry differences.

| Import, visible completion in ms |     A1 |     B1 |     B2 |     A2 |
| -------------------------------- | -----: | -----: | -----: | -----: |
| JMdict, ABBA                     | 1379.5 | 1689.0 | 1403.1 | 1377.6 |
| Jitendex, ABBA                   | 2360.3 | 3041.0 | 2875.5 | 2367.8 |

| Import, visible completion in ms |     B1 |     A1 |     A2 |     B2 |
| -------------------------------- | -----: | -----: | -----: | -----: |
| JMdict, BAAB                     | 1268.4 | 1342.0 | 1313.6 | 1302.1 |
| Jitendex, BAAB                   | 2792.7 | 3078.4 | 2442.9 | 2498.4 |
| JMdict, identical-code control   | 1329.4 | 1361.7 | 1383.0 | 1324.9 |
| Jitendex, identical-code control | 2006.2 | 2807.2 | 1848.4 | 1863.3 |

The initial bracket suggested a Jitendex regression, so it was retained and investigated rather than discarded. Reversing order produced opposite-signed deltas. Identical code itself varied by 28.5% in one paired Jitendex observation. These runs do not establish an import speedup or a repeatable import regression; import latency is **inconclusive under runner variation**. No parser, buffering or worker experiment is promoted from these timings.

All four release-package lookup lifecycles completed (88–89 phases each) without skips. First automation-observed hover was 842.6/842.0/845.2/847.5 ms for A1/B1/B2/A2; repeated median was 512.6/511.0/512.0/513.1 ms. These totals include deliberate pointer movement and setup. Scanner medians were 8/7/7/8 ms, with p95 55/23/22/62 ms; popup-show medians were 35/32/34/34 ms. This is **phase-local/directional** evidence, not a verified whole-path latency win or a cold-backend claim.

The gate is retained as **correctness-only retention hardening**: it prevents unbounded ordinary-context instrumentation entries while preserving opt-in profiling, monotonic timing and successful real-browser lookup/import behavior. No end-to-end speedup is claimed. A single type annotation and workflow-only control improvements followed the timed source; package-entry hashes verify unchanged product bytes for the comparison.

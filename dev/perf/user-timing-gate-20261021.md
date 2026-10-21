# User Timing retention and browser qualification — 2026-10-21

Every ordinary lookup and rendered result previously created persistent User Timing marks/measures. The wrapper never cleared these entries. Its upstream history still contains the original unconditional implementation (`yomidevs/yomitan` safe-performance commits `b39bd51ea78987f0ce60c934a2a80a1f000cfd7c` and copyright-only updates through `6b93c538e80208011ac6bd081ef1ccde09235320`). This is a focused fork-local instrumentation change.

The candidate requires explicit boolean `globalThis.manabitanPerformanceInstrumentationEnabled = true` to emit marks/measures. It preserves `now()`, operation health timings, production algorithms, storage formats and dictionary semantics. Explicit browser profiling opts in. Production contexts avoid persistent instrumentation allocation; no speedup is assumed.

A Node 22.22.0 retention check ran 2,000 pairs of marks plus one measure: baseline retained 6,000 entries, candidate default retained zero, candidate profiling retained 6,000. This is retention correctness evidence, not browser latency or a memory-byte measurement. Focused runtime, lookup-availability and render-ownership suites passed 45 tests. Local timing was excluded because the host load was roughly 550–590 on ten logical CPUs.

## Browser experiment contract

- Compare the candidate with `a2ef0f168c26553cba01cf363faf319eabdbeb05`, which includes the independently qualified runtime fixes.
- Target eliminated work: persistent User Timing allocation on scanner/translator/render paths. No import flags, dedupe, caches, worker counts or buffers change.
- Build both arms before timing. Use the same candidate measurement harness, pinned source ZIPs and Playwright browser, fresh profiles, OPFS, production import settings, and disabled profiling/screenshots/process sampling.
- Run A1 B1 B2 A2 on a separate runner for each of JMdict import, Jitendex import and full lookup lifecycle. Preserve host snapshots before/after, package/harness identities, all raw results and failures.
- Import acceptance: exact title/revision/term count, twelve first/middle/last content probes, no fallback/errors/skips, durable post-UI completion. Existing full functional browser checks cover additional content/lifecycle semantics; sampled probes do not establish exhaustive content equality.
- Lookup guardrails: strict full lifecycle, request-fresh visible results, first and repeated hover samples and their scanner/popup timings. Lifecycle first hover follows production prewarm readiness; automation totals include pointer motion and setup and are not pure intent-to-visible latency.
- Reject a latency claim if bracketed deltas are small or opposite-signed, correctness differs, or any runtime verification is skipped. Retention correctness can justify the small gate independently; do not claim an import or visible-hover speedup from a microbenchmark.

Browser comparison results remain pending until raw artifacts are reviewed.

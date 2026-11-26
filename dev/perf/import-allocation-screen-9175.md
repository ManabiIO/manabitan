# Import allocation regression screen, 2026-11-26

This is a bounded safety screen for two independent allocation changes against
`0143e9596cd8f790d5e166d4ba6a2425fbc57f14`:

- PR #942: defer content-resolution scratch until storage admission,
  `400d4375a89cdf93805cc9566da2068a741dc059`.
- PR #935: preserve compact ZIP entries during speculative media deferral,
  `bdb9c74874e2612fbb8741f4d36ed4397e4eaf57`.

Each candidate is compared independently with the baseline for pinned JMdict,
Jitendex and VNDB. Each job uses Node 22.22.0, the lockfile's Playwright Chromium,
release `chrome` packages and unchanged production import defaults. Package
member hashes must differ only in the candidate's declared runtime files.
Native modules, source archives, dependency locks and measurement code must
match across arms.

The four fresh-profile observations are frozen as A1, B1, B2, A2. Every import
uses the existing browser-monotonic file-input-to-post-UI completion boundary,
then performs restart, sampled term-content and lookup validation and exhaustive
media readback. Cross-arm receipts must match for all 72 lookup observations,
sampled content digests and complete media bytes. Counts alone do not establish
complete term-content equivalence; the separate corpus replay addresses parser
output equality.

This short, single-host bracket can expose gross regressions. It cannot qualify
a speedup, a browser peak-memory reduction or a cross-device improvement. All
observations and failures remain in the artifact; failed runs are not replaced
to improve a result. There are no tracing, phase screenshots or process-memory
samplers in the timed observations.

The VNDB media job also runs the standalone catalog component screen after the
browser observations. Its retained Node allocations and materialization counts
are distinct from full-import latency and browser memory.

The workflow triggers only on this evidence branch when its workflow or runner
changes. Documentation and archived evidence updates do not reacquire a cohort.

## Supplementary full VNDB parser replay

A separate one-job workflow completes the VNDB component replay that exceeded
the local execution environment's memory limit. It uses the final parser source
`01d0eb7164385828c97efae1b319ccc1c4fe92f9` and the same baseline, archive and native
module. The final helper differs from the frozen browser candidate only in its
required license header and equivalent nonzero typed-array length checks.

This job checks every emitted row, content, key, media and lookup payload across
fixed groups of four term banks, after initializing the deferred columns. It
records cumulative deferred bytes and exact source/runner provenance. It does
not measure import time or peak memory. Its separate workflow trigger leaves
the original browser observations and their source identities intact.

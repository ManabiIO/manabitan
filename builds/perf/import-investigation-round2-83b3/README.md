# Import investigation: second pass

This checkpoint preserves raw experiments and validation from the continuation requested on 2026-11-28. The archive hashes and byte sizes are in [manifest.json](manifest.json). Earlier evidence remains unchanged elsewhere on this branch.

## Shared ready-codec worker for index writes

The candidate at `1d6803caf249fa02ea5eea652731e5b9953ce7d9` lets a small import borrow an already-ready codec worker through a private MessagePort for index file I/O. It creates no additional worker and keeps the existing dedicated-worker path for large imports. The local validation archive retains the actual-worker tests, type/lint/build output, the complete quiet full-suite pass (673 files, 15,158 passed tests, 47 existing skips), and the earlier failed environment/setup attempts.

The original and candidate passed real Chrome JMdict smoke imports, with identical canonical receipts and index-worker file count changing from 0 to 1. Candidate Jitendex and VNDB smoke imports also passed all-media, restart, lookup and storage checks. These are correctness and admission observations only. No shared-codec timing cohort has started at this checkpoint, so this archive establishes no speed or peak-memory improvement.

## Native hypotheses

The native recovery archive includes the frozen 32/64-byte JSON string-mask experiment, raw child observations and independent differential tests. Both variants passed 45,046 boundary cases and full JMdict output parity, but neither met the predeclared screen. The 64-byte variant was faster in the observed component medians, while its win-count gate and the A/C control-drift gate failed. The result is inconclusive; no retry, threshold relaxation or product PR followed.

A separate untimed DEFLATE-provenance census found 9,105,015 additional glossary bytes eligible for the proposed reuse (6.71% of all glossary bytes), before the cost of more than four million match/run events. It did not justify implementation. The archive also contains one profiled current-develop import at `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`, exact output parity, raw profiles and the native function map. Profiler occupancy is not a removable-wall-time estimate.

## Existing #830 qualification: first JMdict host

The unchanged independent reader verified all 36 scheduled ordinary observations, source and package identities, all-media receipts and separate raw memory observations for the JMdict AB host. The paired median whole-import change was +0.0315%, with a descriptive 95% interval of [−1.048%, +0.468%] and 5/12 faster pairs. This host provides no worthwhile whole-import gain. The original direct-registration component improvement must not be represented as an end-to-end speedup.

The other #830 cells completed and are being retained separately, including failed memory coverage observations and control drift. There are no replacement runs or revised gates.

## Reproduction boundaries

Each archive contains the source identities, manifests and raw outputs associated with its own experiment. The native screen and #830 use the frozen earlier baseline; the newer diagnostic profile uses current develop. Those identities must not be mixed. Component timings exclude browser storage unless their protocol says otherwise. Compressed evidence is stored here for recovery; product changes remain on their separate research/PR branches.

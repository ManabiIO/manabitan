# Import investigation: second pass

This checkpoint preserves raw experiments and validation from the continuation requested on 2026-11-28. The archive hashes and byte sizes are in [manifest.json](manifest.json). Earlier evidence remains unchanged elsewhere on this branch.

## Shared ready-codec worker for index writes

The candidate at `1d6803caf249fa02ea5eea652731e5b9953ce7d9` lets a small import borrow an already-ready codec worker through a private MessagePort for index file I/O. It creates no additional worker and keeps the existing dedicated-worker path for large imports. The local validation archive retains the actual-worker tests, type/lint/build output, the complete quiet full-suite pass (673 files, 15,158 passed tests, 47 existing skips), and the earlier failed environment/setup attempts.

The original and candidate passed real Chrome JMdict smoke imports, with identical canonical receipts and index-worker file count changing from 0 to 1. Candidate Jitendex and VNDB smoke imports also passed all-media, restart, lookup and storage checks. These are correctness and admission observations only. No shared-codec timing cohort has started at this checkpoint, so this archive establishes no speed or peak-memory improvement.

## Native hypotheses

The native recovery archive includes the frozen 32/64-byte JSON string-mask experiment, raw child observations and independent differential tests. Both variants passed 45,046 boundary cases and full JMdict output parity, but neither met the predeclared screen. The 64-byte variant was faster in the observed component medians, while its win-count gate and the A/C control-drift gate failed. The result is inconclusive; no retry, threshold relaxation or product PR followed.

A separate untimed DEFLATE-provenance census found 9,105,015 additional glossary bytes eligible for the proposed reuse (6.71% of all glossary bytes), before the cost of more than four million match/run events. It did not justify implementation. The archive also contains one profiled current-develop import at `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`, exact output parity, raw profiles and the native function map. Profiler occupancy is not a removable-wall-time estimate.

## Existing #830 qualification: all four cells complete

The unchanged independent reader verified all scheduled ordinary observations, source and package identities, corpus/restart/lookup receipts and exhaustive media checks. The [compact machine-readable summary](browser-830-summary.json) retains each cell's independent statistics, memory audit and failures. All four complete raw cell archives are retained beside this file.

| Independent cell | Paired median whole-import change | Descriptive 95% interval | Memory screen |
| --- | ---: | ---: | --- |
| JMdict AB, 12 pairs | +0.0315% | [−1.0483%, +0.4675%] | Passed |
| JMdict BA, 12 pairs | −1.0596% | [−1.8216%, +0.9234%] | Failed coverage |
| Jitendex AB, 6 pairs | +0.5312% | [−1.6203%, +4.9466%] | Failed coverage |
| VNDB AB, 6 pairs | +3.0604% | [−0.8067%, +6.1889%] | Passed |

No worthwhile whole-import JMdict gain is established. Jitendex also has −5.9504% median unchanged-code control drift. Failed scan coverage is not a measured memory regression. Every slow tail and failed memory observation is retained. There are no replacement cohorts, control subtraction, pooled hosts or revised gates. The earlier direct-registration component improvement remains limited to that component.

## Additional row-tail admission census

The separate native-tail-admission archive contains the one-pass current-JMdict census, observer source, 12 small controls and exact output/lookup parity. All 53 banks and 528,299 rows completed. The existing adjacent-tail mechanism admitted no rows; an additive current-sequence probe made 507,323 probes, with 634 prefilter passes and zero full-tail matches. Both models retain the original 54,641 glossary witnesses and 16,529,724 reused bytes. There is no eligible work to remove on this fixture, so the proposed addition was not implemented.

## VNDB media-study preparation hold

The existing #907 projected-media change was ported to current develop without altering its product intent. Its exact product tree is published at `66ae01d41e3abdb546873f62f8db9ff35bd4ebbb`. A final production-setup audit found that the direct component harness omitted exact lookup route preparation. The queued acquisition was cancelled before a runner or any step started: run 46128570908, job 140928524543, empty step list. The [hold commit](https://github.com/ManabiIO/manabitan/commit/29ae2936452c1dc38ebf01cd82d250dff921e3c7) preserves that defect and executes no benchmark. No timing from that harness exists. A corrected setup must be reviewed and frozen before acquisition.

## Reproduction boundaries

Each archive contains the source identities, manifests and raw outputs associated with its own experiment. The native screen and #830 use the frozen earlier baseline; the newer diagnostic profile uses current develop. Those identities must not be mixed. Component timings exclude browser storage unless their protocol says otherwise. Compressed evidence is stored here for recovery; product changes remain on their separate research/PR branches.

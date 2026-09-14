# Composite-state JSON parser: measured review candidate

Keep active composite state local and save only suspended parents. No changes to JSON grammar, media hints, nesting limits, ZIP, cache policy, or persistent storage format.

Baseline: PR20 commit `394d8eb799dd1eb5e194cee11472a4beab915080`. Source-only tree: `7861e3696323cef9dd0f26c1ab798ea8b1c52fca`.
This is a draft review candidate, not a release merge or universal speedup claim.

| Runner | Dictionary | Baseline ms | Candidate ms | Paired change | Faster pairs |
|---|---|---:|---:|---:|---:|
| composite-1 | jmdict | 1581.6 | 1569.8 | -0.58% | 8/12 |
| composite-1 | jmnedict | 1410.4 | 1427.6 | +0.42% | 5/12 |
| composite-1 | jitendex | 2849.5 | 2787.9 | -1.97% | 11/12 |
| composite-2 | jmdict | 1573.0 | 1535.2 | -1.92% | 11/12 |
| composite-2 | jmnedict | 1375.6 | 1389.6 | -0.14% | 6/12 |
| composite-2 | jitendex | 2791.4 | 2748.0 | -1.49% | 10/12 |

Negative means less whole-import time. These are medians of adjacent paired ratios; independent hosts are not pooled. Each host ran 72 measured fresh-profile imports plus six excluded warmups with immutable fixtures and unchanged browser event-to-completion timing.

Additional direct composite grammar differential: 154861 cases, zero baseline/candidate mismatches. This is correctness instrumentation, not a timing benchmark or a claim of new UTF-8 validation.

Full unit, options, strict TypeScript, all-target dry builds and strict Chromium E2E passed on each completed replication. Existing PR20 Firefox and repository-wide lint limitations remain separate. No rejected cache, ZIP, dense-table, or reservation changes are included.

Exact paired values and source fingerprints are retained on verification branch `perf-import-deep-replication-20260908` under `dev/perf/deep-import-replication-20260908/`, plus the workflow artifacts.

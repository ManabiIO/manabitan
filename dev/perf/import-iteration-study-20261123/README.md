# Frozen import comparison: second iteration

This branch qualifies four isolated, immutable source candidates against their own exact parents. `candidates.json` records each commit and the only package entries allowed to differ. Both arms receive the same five pinned benchmark-harness files from this branch. The overlay does not modify extension runtime files.

Each candidate and dictionary has two independent GitHub-hosted Chromium jobs. Each job performs two excluded warmups, two baseline A/A pairs, eight alternating A/B or B/A pairs, then two more A/A pairs. Replication 2 reverses the initial warmup and comparison order. Every observation uses a fresh browser profile; pinned title, revision, term/media counts, sampled content and restart readback must pass. No observation is trimmed or selectively repeated. Failed jobs retain their partial evidence.

The authoritative timing boundary remains the existing file-input change event through post-UI import completion. Tracing, phase profiling, screenshots and process sampling are disabled for these observations. Concurrent parser/storage phase counters are diagnostic and are not summed as elapsed time.

Only after all timing observations finish, the owned-shared candidate runs four additional A/B/B/A or B/A/A/B observations with external process-tree PSS sampling. Their times are excluded from the timing results. PSS is read from Linux `/proc` for discovered Chromium descendants; PID sets are checked before and after every scan. These maxima are sampled, non-atomic observations across startup, import, readback and restart. Short-lived processes between scans may be missed. They are not exact peak-RSS measurements.

The native CRC candidate remains an unqualified experiment. Both original local screens are retained separately; their noisy and mixed results do not justify a production speed claim. The independent browser results will determine whether it merits a production PR. The other candidates have measured reductions in repeated validation or diagnostic decoding, or remove an identified packing copy; complete-import speed claims still require the browser evidence.

## Reproduction

Use Node 22, `npm ci`, the repository setup/build prerequisites, and the pinned Playwright Chromium release. Fetch every immutable source revision in `candidates.json`, then run from this checkout:

```sh
PERF_CANDIDATE=content-validation PERF_DICTIONARY=vndb PERF_REPLICATION=1 RUNNER_TEMP=/path/to/empty/staging python3 dev/perf/import-iteration-study-20261123/run.py
```

The runner refuses pre-existing evidence/staging directories. The workflow matrix runs every candidate with JMdict, Jitendex and VNDB in both replications. Its maximum parallelism is six jobs; each paired comparison runs alone in its GitHub-hosted job. Artifacts retain complete per-observation reports, package-member hashes, source identities, schedules, control observations and failures for 30 days. Compact original receipts and the resulting analysis will also be committed to a separate evidence branch.

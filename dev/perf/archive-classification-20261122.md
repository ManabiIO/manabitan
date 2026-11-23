# Archive bank classification

This change avoids testing every image filename against all six bank patterns.
It filters candidate names only for archives with at least 1,024 entries and
only when all query tuples are the importer's built-in objects. Small archives
and arbitrary queries retain the original iteration and sorting. No ZIP
validation, term data, media payload, worker policy, or storage format changes.

## Scope and reproduction

The benchmark measures resident ZIP metadata through complete bank
classification and sorting. ZIP reads, term parsing, compression, storage, and
UI completion are outside the boundary. It is not a whole-import benchmark.
Every arm must return the same entries in the same order. Reports retain raw
wall and main-thread CPU observations, source and fixture hashes, and failures.

Prepare the baseline checkout at `5e1f8c12f7ff798ba407323aff675cb23b22af02`
and this checkout with identical dependencies and generated libraries. Then:

```sh
node --expose-gc dev/perf/archive-classification-benchmark.js \
  --baseline-root /path/to/baseline --pairs 12 \
  --out builds/perf/archive-classification.json \
  /path/to/JMdict.zip /path/to/jitendex-yomitan.zip \
  /path/to/vndb_characters_by_bee.zip
```

The final plan is twelve alternating AB/BA pairs per archive, three excluded
warmups per arm, and explicit GC outside each interval. Each observation
averages two classifications for archives with at least 1,024 entries, or 100
for smaller archives. The plan is fixed before measurement.

## Preliminary screening

An earlier ungated candidate reduced VNDB classification's median main-thread
CPU time from 50.93 ms to 3.29 ms over twelve pairs. A simpler generic iterator
prototype took 30.46 ms. Jitendex's ungated result was 0.515 ms versus 0.559 ms;
this small overhead motivated retaining the old route for small archives.
Those measurements precede the final gate and are not final-source results.
Wall measurements were affected by heavy host contention and are not pooled.

## Final gated source

The fixed cohort completed all 36 pairs on Node 24.22.3. All entry and order
comparisons passed; both importer source hashes remained unchanged throughout.
[Raw observations](archive-classification-results-20261122.json) retain every
sample and the runner, source, and archive hashes.

| Archive         | Entries | Baseline CPU, ms | Candidate CPU, ms | Baseline wall, ms | Candidate wall, ms |
| --------------- | ------: | ---------------: | ----------------: | ----------------: | -----------------: |
| JMdict          |      55 |           0.0558 |            0.0805 |            0.0765 |             0.0953 |
| Jitendex        |     474 |           0.4033 |            0.4482 |            0.4173 |             0.4855 |
| VNDB Characters | 147,237 |          35.3750 |            2.4008 |           36.3958 |             2.8480 |

These are arm medians. VNDB improved in all twelve pairs; its median paired
change was -92.73% CPU and -92.06% wall time for classification alone. JMdict
and Jitendex retain the original iteration path. Their sub-millisecond results
show no demonstrated improvement or tight non-regression bound. Do not pool
these results with the ungated screen or claim an equivalent import speedup.

The measured importer SHA-256 is
`315b98dd0a065cde9320e94c41367805951bbedbbef09b8472f8fa94a570b1d3`.
The final gated source passed 85 focused importer tests across five files.
Exact-head lint, types, full unit, build, and browser qualification remain
separate gates; no browser import timing was collected by this runner.

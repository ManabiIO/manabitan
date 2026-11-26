# Deferred content resolution evidence

[Draft PR #942](https://github.com/ManabiIO/manabitan/pull/942) moves the three
content-resolution columns from parser-result creation to first admission by
the ordered storage sink. Native parsing, compression, lookup indexes and
persisted formats do not change.

## Completed component result

The original paired replay used frozen develop
`0143e9596cd8f790d5e166d4ba6a2425fbc57f14` and the runtime in local candidate
`8bf1174ed5dc85455a9bc1032a04753693da5087`. Its equivalent published commit is
`400d4375a89cdf93805cc9566da2068a741dc059`. It checksum-verifies the locked archive,
reads its compressed entries through the production raw ZIP reader, and feeds
fixed groups of four banks through actual native inflation, parsing and owned
result copying in both sources.

| Corpus   |    Rows | Banks / groups | Unique content entries, summed | Resolution bytes deferred, summed | Largest group |
| -------- | ------: | -------------: | -----------------------------: | --------------------------------: | ------------: |
| JMdict   | 528,299 |        53 / 14 |                        366,253 |                       4,761,289 B |     421,772 B |
| Jitendex | 436,555 |       219 / 55 |                        363,281 |                       4,722,653 B |     102,414 B |

All completed group digests match for the entire emitted content, media,
lookup, key and row-column payload after initializing the candidate's deferred
columns. The digest excludes only the new state marker and lookup encoding
duration. Candidate worker-result columns are checked to be empty before
initialization. Each unique content entry defers one flag byte, one 64-bit
offset and one 32-bit length: **13 bytes**, still allocated later at the sink.

These are cumulative scratch-allocation and transferable-payload bytes removed
from queued worker results. They are not total allocation savings, simultaneous
resident memory, peak memory or elapsed-time improvements. Fixed four-bank
groups are a component screen, not production browser scheduling.

The original combined replay was killed with exit 137 before completing a
second corpus. A subsequent Jitendex invocation using the portable runner in
its own process passed all 55 groups against the same frozen runtime; it ran
before the style correction described below. The two completed corpus receipts
cover **964,854 rows and 9,483,942 deferred bytes**.

A separate VNDB invocation, with no other heavy local task running, was also
killed with exit 137 before a completed receipt. It provides no completed VNDB
parity or allocation-byte result. The original partial receipt, later Jitendex
receipt, scripts and execution outcomes are retained without filling in results.

## Local validation

- The final focused run passed all 24 tests. It used one worker and a
  command-only 30-second timeout; source test timeouts and assertions were not
  weakened. Actual test execution took 1.20 seconds.
- Cases cover native and JavaScript canonical resolution, generic fallback,
  populated eager plans, split publication with shared plan identity, all three
  allocation failure points and retry, malformed deferred states, and actual
  Node worker transfer and reuse followed by native storage resolution.
- The first invocation had two test-oracle failures because it compared
  nondeterministic duration counters. The oracle now compares semantic fields
  and explicitly asserts native bulk resolution. A subsequent invocation had
  one existing five-second test timeout during host contention; the successful
  command-only timeout rerun and both earlier logs are retained.
- The larger scoped lint attempt was killed with exit 137. It did not establish
  a lint pass or a source diagnostic. A bounded two-file invocation later
  identified repository header and formatting requirements, retained in
  `new-files-lint-before-correction.log`.
- Local commit `737d0ff990eeb4336e4f31b4f794a4245d9bef8c` fixes those style
  requirements. The runtime helper receives the repository's full GPL header
  and expresses nonzero typed-array length checks as `length > 0` instead of
  `length !== 0`. Tests receive formatting and an equivalent relative URL.
  These changes preserve the behavior of the frozen runtime. The unsuccessful
  VNDB invocation used this style-corrected source.
- The corrected helper and test passed scoped ESLint. The focused suite then
  passed all 24 tests again on the style-corrected source, with the same
  command-only 30-second timeout; actual test execution took 339 milliseconds.
  Both successful logs are retained.

Hosted validation remains authoritative for the complete suite, types, builds
and actual browser imports. Frozen browser reports retain their original source
identities; the style correction does not replace or relabel those samples.

## Reproduction

`corpus-parity.mjs.txt` is the exact original script, including its original
workspace-relative paths. `replay-portable.mjs.txt` provides the same comparison
with explicit paths and an additional archive-size check. It produced the
separate Jitendex receipt; the original partial JMdict result belongs to the
original script.

For the portable runner, install dependencies in the candidate checkout and
provide the three checksum-verified archives from `test/perf/dictionaries.lock.json`.
Run each dictionary in a separate process to bound retained native heaps:

```sh
cp dev/perf/deferred-resolution-20261126/replay-portable.mjs.txt /tmp/replay-resolution.mjs
node /tmp/replay-resolution.mjs BASELINE_ROOT CANDIDATE_ROOT CACHE_ROOT OUTPUT_DIRECTORY jmdict
```

Replace the final argument with `jitendex` or `vndb` in separate invocations.
The runner writes `corpus-parity.json` under the supplied output directory.
`manifest.json.txt` identifies the fixture, runtime, native artifact, runner and
retained evidence hashes. Frozen complete browser timing and process memory
qualification are separate from this deterministic component check.

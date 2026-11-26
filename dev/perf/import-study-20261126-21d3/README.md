# Current-source import qualification

This is a prospective qualification of current production imports. The runner
and semantic validator are copies of the frozen a7f7 versions with the narrow
policy changes described below. The original files, cohorts, schedules,
process observer, memory auditor, and historical results remain unchanged.

## Baseline and package identity

The runner requires baseline `439a1c9b6d40452061cda094b0727005553c1d1d`,
12 candidate pairs, the existing three-worker production policy, and no debug
flags. That baseline adds only the reviewed benchmark receipt-policy fix to
product source `0143e9596cd8f790d5e166d4ba6a2425fbc57f14`.

`policy.json` freezes both dependency/fixture locks and all 552 packaged member
hashes from the original baseline profile. All three independent baseline
builds had identical member maps. The new runner checks that entire map before
starting an observation. Candidate packages must change exactly the explicitly
registered members; every other packaged byte and the complete source/harness
manifest must match the control.

## Exact storage admission

The frozen a7f7 helper expects a VNDB SQLite SAH allocation of 129–131 active
pages. It rejects the preserved current-source baseline report, which contains
one 37-page active SAH file and seven 4096-byte empty files. The original
profile verified all 6,648,310 rows and all 146,570 media files, readback,
lookup digests, and restart. The raw report and artifact hashes are in
`policy.json`; `prior-cohort.json` retains the old cohort and offline rejection.

The historical range is an empirical qualification bound, not a database
schema requirement. The current profile does not preserve the raw SQLite
file, so this study does not attribute the allocation difference to a specific
allocator or storage change.

The new validator requires **exactly 37 active pages** for this pinned study.
It retains every product path, every actual logical file size, the complete
inventory, and the original exact cross-observation comparison. A different
page count, including 36, 38, or the old 129–131 range, fails. This is not a
storage reduction claim. Any deviation in the new cohort remains a failed
qualification; the policy is not widened after observing results.

## Unchanged acquisition and comparisons

The fixed plan retains four warmups, 12 alternating A/B pairs, four interleaved
identical-code A/C pairs, and a separate opposite-order host replication.
Every timed observation starts a fresh browser profile. Exhaustive media and
four process-memory observations run separately after timing. No traced or
memory-observed duration is used as timing evidence. Failed attempts remain
in their original cohort and are never replaced by later observations.

Content, lookup, media, storage, source/package/browser identity, raw-report
binding, and all original memory coverage and regression checks remain in
force. The only semantic-validator change is the exact current-study VNDB
page admission. The runner also records hashes of its policy, implementation,
and semantic helper in the registered plan.

## Checks

```sh
python3 -m unittest discover -s dev/perf/import-study-20261126-21d3 -p 'test_*.py' -v
```

The mutation suite preserves the historical digest, raw binding, inventory,
lookup, browser, source, and package checks. New cases reject neighboring and
historical SAH allocations, and reject changed baseline, flags, pair count,
or worker policy before creating evidence or opening a browser.

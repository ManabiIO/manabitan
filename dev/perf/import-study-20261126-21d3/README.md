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

## Original cohort outcome

The original cohort `45863377198` subsequently started and both jobs stopped
at their first warmup, exactly at the preserved 129–131-page admission check.
The A-first job and B-first job each recorded the same 37-page active SQLite
allocation and 609,176,779 bytes of total logical storage.

`historical-failure.tar.gz` preserves all original text artifacts, including the
unchanged raw first-warmup reports, native summaries, logs, registered plans,
source/package member identities, and runtime identities. The two reproducible
package ZIPs from each job are omitted from this small bundle; their hashes and
full member maps remain recorded and the original Actions artifacts retain them.
`historical-failure-audit.json.txt` records both original artifact hashes and
every preserved raw-member hash.

A retrospective check with the new prospective validator accepts both unchanged
semantic receipts and finds identical content, lookup, sampled-media and exact
storage results. This is a correctness diagnostic only. Both original jobs
remain failed, and their timing values are not admitted to the new cohort.
Neither job completed a paired timing, exhaustive-media, or memory cohort.

## Native package registration correction

All six native cells of cohort `45865811773` stopped during package preflight,
before a warmup or any timing or memory observation. The normal extension
build already ships `js/dictionary/wasm/term-bank-parser.c`. The native
candidate changes that source as well as the two parser JavaScript files and
compiled WASM, but the original registration listed only three members.

The preserved packages were independently checked against every recorded
member hash and the frozen A/B Git sources. All 552 member paths are the same;
exactly these four members differ:

- `js/dictionary/term-bank-source-crc.js`
- `js/dictionary/term-bank-wasm-parser.js`
- `js/dictionary/wasm/term-bank-parser.c`
- `lib/term-bank-parser.wasm`

The baseline C source has SHA-256
`70254ab4ff0a63a1e0a98a6cf466a641611af08ac68cc65eb1cc964a1872c65e`;
the candidate has
`5163749097217498995725950ca2329a2d3701cb5021aac03ab347f8d6198b34`.
Both match their exact packaged bytes and Git blobs.

`native-preflight-audit.json.txt` binds all six failed artifacts and source
maps. `native-preflight-failures.tar.gz` preserves all 96 original text
members, including build logs and complete package identities. Reproducible
package ZIPs remain in the original Actions artifacts and are represented by
exact hashes here. No failed cell contributed an accepted observation.

The new `native-qualification-v2` registration adds only the exact verified C
path. The original strict package-set equality, source refs, default flags,
12-pair schedule, opposite-order replications, semantic checks, exhaustive
media checks and separate memory gates remain unchanged. The original native
and media-v2 jobs are pinned to their original `f44e6f3` workflow commit. The
existing media cohort continues under its original registration; this update
starts only the six corrected native cells.

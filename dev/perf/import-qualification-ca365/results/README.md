# Current-base import qualification — results

## Decision

**Do not promote the metadata-witness candidate (#831) as a speed improvement.**
It is slower on both Jitendex target hosts: paired medians range from +2.3852%
to +3.6411% against the two unchanged controls. JMdict also has small slowdowns.
Removing repeated metadata validation did not improve complete-import time.

**Native media projection (#875) does not pass this complete frozen qualification.** VNDB is directionally faster
on both independent hosts, with paired medians from −3.6665% to −5.6507%.
Both VNDB memory hosts pass. The complete frozen qualification still fails:
neither timing host meets the minimum 5% gain against both controls, one
Jitendex host exceeds the non-target 3% regression bound, and one Jitendex
memory observation lacks required coverage. These are separate findings;
no earlier passing host replaces a failed observation in this campaign.

GitHub reports that #875 was independently merged on 2026-11-25 at 16:35:13 UTC,
at merge commit `696f8247a79c29bcd71565e4fceb1deca2da2af4`, while this campaign
was still running. That merge was outside this qualification work. This report
preserves its failed screens; it does not represent a passing promotion decision
or a qualification of the combined branch after the merge.

Both product PRs have passing full source CI. All **312 complete browser imports**
in the new campaign pass their content, lookup, restart and media validation:
264 timing-study observations plus 48 separately instrumented memory observations.
The 264 include 216 timed imports, 36 excluded warmups and 12 separate exhaustive
media validations. There were no outcome-dependent exclusions or reruns.

## Frozen identities and methods

| Role                          | Commit                                     |
| ----------------------------- | ------------------------------------------ |
| Baseline                      | `7d1643e6147a10cb2165e9744cf0e63b59e46632` |
| Metadata witnesses / #831     | `11bf4550a26e98ccc3df1579da7444244fe1e861` |
| Native projection / #875      | `5afd2e97ec2707b150acfde61115aee688547a78` |
| Original acquisition workflow | `7b021ebe3e7625a56ab9dde346ae72f3cd39b770` |

[Timing run 45647030745](https://github.com/ManabiIO/manabitan/actions/runs/45647030745)
and [memory run 45647030792](https://github.com/ManabiIO/manabitan/actions/runs/45647030792)
are the only acquisitions summarized as the new campaign here. Both are attempt 1.
Node 22.22.0, Chromium 153.0.8010.12, fixture hashes, production defaults, exact
source/package identities, schedules and decision thresholds were fixed in the
[original protocol](../../import-qualification-ca365.json) before acquisition.

Each timing host has six A/B/C permutations, after one excluded warmup per arm.
A/C are byte-identical baseline releases. Every observation uses a fresh browser
profile; the second host reverses the cohort sequence. The interval runs from
the browser file-input change event to visible import completion. Target
promotion requires at least 5% median paired reduction against both controls on
both hosts and at least five of six faster pairs per control per host. Non-target
corpora permit at most 3% median regression against either control on either host.

Negative timing percentages mean faster. Each median is computed from six paired
ratios on its own host; hosts and controls are not pooled. An acquisition job's
success indicates valid complete data, independently of its numerical screen.

## Metadata-witness timing

| Corpus   | Host | B/A paired median | B/C paired median | Faster pairs A / C | Frozen screen   |
| -------- | ---: | ----------------: | ----------------: | ------------------ | --------------- |
| jmdict   |    0 |          +1.6001% |          +2.3115% | 1/6 / 2/6          | non-target pass |
| jmdict   |    1 |          +0.6874% |          +0.4328% | 2/6 / 2/6          | non-target pass |
| jitendex |    0 |          +2.6135% |          +2.3852% | 0/6 / 2/6          | target FAIL     |
| jitendex |    1 |          +3.6411% |          +3.1482% | 0/6 / 0/6          | target FAIL     |
| vndb     |    0 |          -2.2060% |          -0.3777% | 4/6 / 3/6          | non-target pass |
| vndb     |    1 |          +0.8018% |          -0.7484% | 2/6 / 4/6          | non-target pass |

[Complete metadata timing audit](metadata-timing.json).
The optimization activated in every candidate observation. Jitendex reports
1,447,817 metadata reuses / 42,246,078 reused bytes per import. That reduction in
repeated work coexists with slower complete imports. Local parser-only parity
over all 7,613,164 rows remains valid but is not a substitute for these timings.

## Native-projection timing

| Corpus   | Host | B/A paired median | B/C paired median | Faster pairs A / C | Frozen screen   |
| -------- | ---: | ----------------: | ----------------: | ------------------ | --------------- |
| jmdict   |    0 |          -0.5455% |          -0.0418% | 4/6 / 3/6          | non-target pass |
| jmdict   |    1 |          +0.7808% |          +0.5509% | 1/6 / 2/6          | non-target pass |
| jitendex |    0 |          -0.9815% |          +2.7873% | 4/6 / 2/6          | non-target pass |
| jitendex |    1 |          +0.5773% |          +3.8180% | 2/6 / 2/6          | non-target FAIL |
| vndb     |    0 |          -3.6665% |          -5.6507% | 6/6 / 6/6          | target FAIL     |
| vndb     |    1 |          -4.4850% |          -4.4071% | 5/6 / 5/6          | target FAIL     |

[Complete native timing audit](native-timing.json).
Both VNDB hosts have at least five of six faster pairs against each control, but
their median reductions do not meet the declared threshold against every control.
Jitendex host 1 also fails its non-target screen at +3.8180% against C.

Do not claim identical total OPFS size across this native-projection campaign.
VNDB host 1, cohort 1, arm B records 609,561,803 bytes; the other 43 VNDB
observations record 609,553,611 bytes. The 8,192-byte difference is entirely the
active SQLite SAH file (536,576 versus 528,384 bytes). All other term/media file sizes
and the seven 4,096-byte SAH file sizes match. This additive diagnostic changes no
predeclared screen or production validation. Exact file-level receipts are retained.

## Separately instrumented memory

All 48 observations are acquired and semantically valid; 42 meet memory coverage.
Independent replay recomputes all **4,985 raw scans** and reproduces every frozen
auditor receipt. Eight cells pass and four fail coverage. No qualified pair
exceeds the +10% individual limit; every fully qualified cell also meets the
+5% median limit. Both complete candidate qualifications remain false because
every scheduled observation must qualify.

These are non-atomic sampled Chromium process-tree PSS/private maxima in the
marked import window, not exact peaks or latency evidence. Startup, exhaustive
readback and restart remain outside the memory maxima. Memory host numbers are
separate runner identities from the timing host numbers. The current memory
campaign verifies every referenced media payload after each import window.

| Candidate         | Corpus   | Memory host | Qualified observations | PSS median / maximum pair | Private median / maximum pair | Outcome          |
| ----------------- | -------- | ----------: | ---------------------- | ------------------------- | ----------------------------- | ---------------- |
| metadata-witness  | jmdict   |           1 | 3/4                    | null / null               | null / null                   | coverage failure |
| metadata-witness  | jmdict   |           2 | 4/4                    | -0.0329% / +0.0740%       | +0.0483% / +0.2759%           | pass             |
| metadata-witness  | jitendex |           1 | 4/4                    | -2.1588% / +0.2418%       | -2.5900% / +0.5872%           | pass             |
| metadata-witness  | jitendex |           2 | 4/4                    | +1.9376% / +2.0425%       | +2.4008% / +3.0464%           | pass             |
| metadata-witness  | vndb     |           1 | 3/4                    | null / null               | null / null                   | coverage failure |
| metadata-witness  | vndb     |           2 | 1/4                    | null / null               | null / null                   | coverage failure |
| native-projection | jmdict   |           1 | 4/4                    | +1.1353% / +2.2217%       | +1.2362% / +2.5104%           | pass             |
| native-projection | jmdict   |           2 | 4/4                    | +0.3443% / +3.4388%       | -0.0081% / +3.7743%           | pass             |
| native-projection | jitendex |           1 | 4/4                    | -0.4893% / +1.5488%       | -0.6430% / +1.9446%           | pass             |
| native-projection | jitendex |           2 | 3/4                    | null / null               | null / null                   | coverage failure |
| native-projection | vndb     |           1 | 4/4                    | +0.7246% / +2.0424%       | +0.6674% / +1.9974%           | pass             |
| native-projection | vndb     |           2 | 4/4                    | +0.0874% / +3.0737%       | +0.1745% / +3.6710%           | pass             |

[Complete memory audit](memory.json), including every pair, raw-scan coverage,
source/package binding, full-media receipts and explicit nulls.

### Coverage failures retained

The maximum permitted gap between covered import scans is 250 ms. The following
six observations fail it. Their sampled maxima, affected pairs and dependent
aggregate metrics remain null. Across these observations there are 19 violating
intervals; every interval and position is retained in the full JSON.

| Candidate         | Corpus   | Memory host | Observation | Maximum covered-scan gap |
| ----------------- | -------- | ----------: | ----------- | -----------------------: |
| metadata-witness  | jmdict   |           1 | A1          |            287.424968 ms |
| metadata-witness  | vndb     |           1 | B2          |            256.097518 ms |
| metadata-witness  | vndb     |           2 | B1          |            285.403263 ms |
| metadata-witness  | vndb     |           2 | A1          |            284.049876 ms |
| metadata-witness  | vndb     |           2 | A2          |            285.083894 ms |
| native-projection | jitendex |           2 | A2          |            250.151437 ms |

Coverage failure does not establish a measured memory regression. It prevents
the scheduled qualification from passing. No rounding exception, wider interval,
substituted host or discarded failed observation was used.

## Source CI and prior studies

[Source CI receipts](source-ci.json) bind the exact product heads to their passing
CI runs. #831 passes 14,596 unit tests across 647 files, and #875 passes 14,609
across 647 files; each run has 47 skipped tests. Options tests, all TypeScript
projects, lint/format validation, pinned native rebuilds, build targets and full
Chromium/Firefox extension E2E also pass. Source trees are unchanged by this archive.

The separate earlier [native screen 45642169759](https://github.com/ManabiIO/manabitan/actions/runs/45642169759)
was independently reopened: all 69 reports and calculations reconcile. It binds
the same baseline to `7a8b25a44a3fe165107ed816377cc72bb0fac67d`, whose product bytes
match the current test-only follow-up. Its VNDB paired medians are −5.0427% and
−4.0169%. [Prior timing audit](prior-native-timing.json).

The separate earlier [memory run 45642179064](https://github.com/ManabiIO/manabitan/actions/runs/45642179064)
also reproduces all 16 observations / 1,504 raw scans. Its Jitendex hosts pass;
both VNDB hosts fail coverage. That study used 64-file sampled media readback,
with exhaustive verification handled separately. [Prior memory audit](prior-native-memory.json).
Neither earlier cohort is pooled into the new results or used to replace a failed slot.

## Retained evidence and archive-only changes

The adjacent archives preserve exact raw reports, observer sources, original
protocols/workflows, all failures, package/member proofs, fixture identities,
lookup/media/restart receipts, independent audit programs and final provenance.
Their [manifest](archives/archive-manifest.json) records archive and member hashes.
Current campaign artifact ZIPs and their release ZIPs were independently digest/member
verified before local removal; their GitHub artifact identifiers and hashes remain.
The prior native timing artifacts contain no release ZIPs. That separate audit
verifies receipts and critical source-bound member hashes instead, without claiming
a fresh hash of unavailable release archives.
Original uploaded package ZIPs retain their workflow's 14-day retention period.
No retained-byte claim is made for a package ZIP absent from these Git archives.

Current and prior studies have separate archive names and path prefixes. Duplicate
independent-replay symlink aliases are omitted and recorded in the manifest;
their canonical target bytes and all regular replay results remain preserved.

The initial diagnostic branch's JSON CI check failed because 16 new evidence and
protocol files had not been registered in `test/data/json.json`. Registering them
fixes that bookkeeping failure; the final JSON suite, including the final report
records, passes 177/177 tests. This does not change any
candidate, frozen protocol, runner, observer, threshold or observation.

The evidence follow-up pins workflow execution to the original acquisition head,
so archiving cannot launch replacement timing or memory cohorts. The original
workflow bytes and every original result remain available under their immutable
acquisition commit and retained artifacts. This measurement-only PR is not intended
to merge into the product.

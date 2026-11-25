# Independent import qualification, 2026-11-25

This branch qualifies existing runtime PRs and retains independent source,
package, corpus and browser evidence. It does not duplicate their runtime
patches. All results remain tied to their frozen revisions and configuration.

## Frozen JMdict cohort

- Baseline: `7d1643e6147a10cb2165e9744cf0e63b59e46632`.
- Candidate: PR #897, `475d351ff07c1b5cfc5651d7f59c624629e4fdc5`.
- Corpus: the unchanged `test/perf/dictionaries.lock.json` JMdict archive.
- Runtime: Node 22.22.0 and the repository-pinned Playwright Chromium.
- Configuration: existing `experimentalParserWorkers3: false`; each observation
  must report exactly two parser workers. This is a configuration result, not
  a claim about default three-worker imports or two-core hardware.
- Only changed package member: `js/dictionary/term-record-opfs-store.js`.

Two independent hosted jobs start with opposite A/B orders. Each has four
excluded warmup observations, twelve alternating adjacent A/B pairs, and four
interleaved alternating A/C control pairs. C uses the exact A source, package,
runtime and flags. Every observation imports into a fresh profile, uses the
unchanged complete-import boundary through UI completion, then verifies lookup,
restart, content, storage and sampled media. No tracing, phase profiling or
process observer runs during authoritative timing.

Paired medians, equal-work ratios, faster-pair counts and descriptive 95%
percentile bootstrap intervals are reported separately per host. The bootstrap
uses 10,000 complete-pair resamples and seed 897. Hosts are never pooled. These
are descriptive statistics; passing correctness or memory is not evidence of
a latency improvement.

After timing, two independent exhaustive-media observations must match the
timed content and storage receipts and one another's full-media receipts.
Separate four-observation ABBA/BAAB memory cohorts use the existing complete
Chromium-process-tree observer, with unchanged coverage and regression gates.
Actual package ZIPs, per-entry hashes, raw summaries/reports, semantic receipts,
original/instrumented test harnesses and raw memory scans are retained.

A timed verification failure stops that cell and retains its evidence. Every
prescribed memory slot is attempted, including after an acquisition failure.
No failed slot is retried, replaced or excluded. Memory coverage and thresholds
are documented in `import-memory-20261125-a7f7/README.md`; failed audits cannot
become passing qualifications.

## Other dictionaries

PR #875's current-source native media projection is being qualified by its
existing fixed cohort. This branch independently audits that cohort and its
integration instead of acquiring duplicate observations. The original older
baseline's memory failure remains separate and is not overwritten.

Fresh baseline diagnostic profiles and complete corpus replays informed the
investigation of JMdict, Jitendex and VNDB. Single diagnostic timings and
component byte savings are not used as complete-import speedup claims.

## Completed outcome

The frozen JMdict run `45646399468` completed both original jobs successfully.
Independent audits passed all 84 import receipts, all 72 timed/warmup/control
observations, and all 571 raw scans from eight separate memory imports. Both
hosts pass correctness and the unchanged sampled-memory qualification.

Latency remains inconclusive: paired medians are +0.136% and -0.707%, with
descriptive 95% intervals [-2.953%, +2.078%] and [-5.507%, +13.123%]. Equal-work
changes are +0.774% and +2.709%. All observations, including slow candidate
pairs and noisy identical-code controls, remain included. No whole-import
speedup is claimed. The conditional component-copy saving remains separate.

[The complete evidence index](import-qualification-evidence-20261125-a7f7/README.md)
contains raw observations, independent audits, current-source VNDB findings,
the unchanged memory hold, and withheld Jitendex experiments. No observations
were reacquired or substituted, and evidence commits do not rerun the cohort.

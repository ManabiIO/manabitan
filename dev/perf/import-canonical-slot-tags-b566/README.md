# Canonical slot tags

## Change

Canonical hash-table probes currently read the separate full-hash columns for
every occupied slot. The candidate caches a rejection tag in unused high bits of
the existing slot word. A different tag avoids those random reads; a matching tag
still requires both original hashes and the existing exact-byte comparison.

The low bits retain the dense index plus one. Each arena owns an immutable index
mask. Growth that changes this mask rehashes the slots, even if slot capacity is
unchanged. JavaScript and native insertion, lookup, rehash, and rollback use the
same representation. Native capability negotiation happens before mutation;
older modules fall back to the packed-aware JavaScript implementation.

No typed-buffer capacity, persisted format, dictionary ordering, worker policy,
compression setting, or experiment default changes. Canonical WASM grows from
1,624 to 1,755 bytes. The parser module is unchanged.

## Evidence and limits

Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
Measured production checkpoint: `ea3cb4418b0163e3c7b1b5b5e1ad43c72171823a`.
The PR's later support-file commit has the same runtime source bytes; acquisition
records its actual complete commit and package identities.

The complete production resolver was measured on actual initial, middle, and
final JMdict inputs. The fixed schedule used 12 alternating AB/BA pairs per group,
32 calls per arm, and four interleaved identical-code controls. All 3,096 calls
passed count and native-route checks. All 120 observations passed the complete
result and metadata checks after each batch, including the four full preflights
per variant and group.

| Actual JMdict group       | Baseline median ms/call | Candidate median ms/call | Median paired change |
| ------------------------- | ----------------------: | -----------------------: | -------------------: |
| 0: initial misses         |                   1.777 |                    1.489 |              -14.82% |
| 5: middle, 463 exact hits |                   5.166 |                    4.721 |               -9.40% |
| 11: final, 695 exact hits |                   6.026 |                    5.178 |              -15.06% |

The pooled median over 36 group pairs is -13.89%. These are scoped component
observations, not whole-import speedups. Identical-code controls also drifted
favorably (-8.70% for the block-sum resolver statistic), the thread-CPU interval
includes zero, and the earlier same-arena native-kernel replication was
inconclusive. Independent production arenas may introduce placement effects.
All observations, including outliers and less favorable runs, are retained.

An independent untimed simulation of the exact probe loop matched both unchanged
native modules and their complete result/metadata bytes. In these three inputs,
tags reject 29,343 of 29,347 wrong hash pairs, leaving four tag false positives
and retaining all 1,158 true matches. Logical first-hash checks fall from 30,505
to 1,162. Conditional second-hash checks remain 1,158 in both versions. These
are source-level checks, not measured hardware loads or latency.
[`mechanism-audit.tar.gz`](mechanism-audit.tar.gz) contains the frozen runner,
complete results, and reproduction note; SHA-256
`dfcb568b0b5773aa87f51c7c195395e69db9abfabfdc47e9334e63d90eb11d7f`.

Fresh source-to-sink runs matched every record, content, and descriptor digest
against develop, with 612 successful content readbacks:

| Corpus   |      Rows | Readbacks | Live slots validated |
| -------- | --------: | --------: | -------------------: |
| JMdict   |   528,299 |        36 |              362,032 |
| Jitendex |   436,555 |        66 |              363,243 |
| VNDB     | 6,648,310 |       510 |              157,150 |

All three activated the native scanner in the first group, without prewarming
or fallback. These runs use the actual source planner, parser and compression
workers, resolver, and record encoder. They exclude SQLite, OPFS, UI, media
processing, and finalization, so browser correctness and timing are separate
gates.

## Reproduce the local evidence

[`local-evidence.tar.gz`](local-evidence.tar.gz) contains the complete raw
observations, analyzers, frozen capture and replay tools, fixture identities,
full-corpus correctness reports, source/build receipts, and explicit negative
experiment index. Its SHA-256 is
`204babf872f4cde9eef2f50c09cd11d985ae14f7a2202f46cad90f4272c1a28f`.

Extract it and follow `canonical-tags-review-bundle/README.md`. The manifest
identifies all 98 files. The 16 MiB of capture data is omitted; the exact original
generator recreates it from the pinned JMdict archive. A binary source patch can
reconstruct the measured checkpoint from the baseline. Capture-run timings
include snapshot work and are not used as performance evidence.

Use Node 22.22.0, unique output paths, and serial benchmark ownership. Preserve
all first observations, excluded warmups, controls, failures, and raw results.

## Local validation

The all-target dry build, all four TypeScript projects, and all 32 qualification
helper tests pass. Canonical scan, deduplication, growth, collision, stale-module,
rollback, and packed-slot tests pass on the measured runtime source.

The initial full unit process reports 669 of 670 files passing, 15,149 passing
tests and 47 skipped tests, then fails on one unexplained worker exit. The
identified compression-dispatch suite passes all 13 cases when run alone on
both candidate and develop. This completes the missing suite's coverage but
does not turn the original full process into a successful run.

The earlier focused lint checks passed after correcting test formatting. Later
full, split, and final changed-file lint processes were killed without rule
diagnostics; full lint remains unqualified locally. Hosted CI must clear these
full-suite and lint gates before merge.

[`local-validation.tar.gz`](local-validation.tar.gz) preserves every original
failure, isolated follow-up, log, cache, and source identity. Its SHA-256 is
`3dc80660e85a854730e50afedd05b28e28b0ca818e302abd2272531b1757c7b1`.

## Browser qualification

The scoped `import-canonical-slot-tags-b566.yml` workflow runs the existing
qualification script against exact PR-head and baseline commits. It starts six
independent jobs: JMdict, Jitendex, and VNDB, each with AB and BA initial orders.
Each job prescribes 12 timed pairs, interleaved same-code controls, separate
all-media checks, and separate memory observations.

The workflow freezes current helper hashes and verifies exactly five changed
package members. It uses production defaults, fresh browser profiles, strict
OPFS and restart/content checks, and the current VNDB allocation bound of 37
4,096-byte units. It retains failures without substituting observations.
Evidence-only follow-ups do not acquire replacement cohorts.

Browser results must be assessed per host alongside its same-code controls.
Local component percentages must not be presented as browser import gains.

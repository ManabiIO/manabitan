# Final owned shared-buffer memory study

Run https://github.com/ManabiIO/manabitan/actions/runs/45116158450 used the
separately frozen observer commit
`00da5cb2ec28211dd6d09d938dc6cf1e3a4334c9` (tree
`4d03a978213da80b70dd80bf07ad2c479712346b`). It compares baseline
`1e235059a4c05c2509e8757fccba43a2d60222df` with owned shared-buffer candidate
`51f095912b11ddd158ac173698eb322e2be99d12`.

**This study does not establish memory nonregression.** Both qualified
Jitendex replications show higher sampled proportional set size (PSS) and private
memory for the candidate. Two baseline JMdict observations fail the frozen
coverage guard, so the entire campaign remains unqualified. The failed job and
all four of its observations are retained, with null maxima for the two failures.
No observation, sample, pair, or job was retried, trimmed, removed, or replaced.

## Fixed protocol and source identity

There are six independent jobs: JMdict, Jitendex, and VNDB, each with two
replications. Each job imports four fresh browser profiles. Replication 1 uses
ABBA; replication 2 uses BAAB. A and B receive byte-identical benchmark overlays
and the same pinned fixture. Exactly two packaged files differ between arms:
`js/dictionary/term-bank-wasm-parser-worker.js` and
`js/dictionary/term-bank-wasm-parser.js`. Their exact source snapshots and complete
package member hashes are retained; package bytes are stable within each arm
across all six jobs.

| Corpus | Release/revision | Term rows | Media rows | ZIP bytes |
|---|---|---:|---:|---:|
| JMdict | JMdict.2026-09-06 | 526,942 | not specified by fixture | 15,587,032 |
| Jitendex | 2026.08.11.0 | 435,448 | not specified by fixture | 38,698,313 |
| VNDB | 395525135651 (release 1.0.0) | 6,648,310 | 146,570 | 291,705,969 |

The fixture lock retains download URLs, exact SHA-256, title, revision and counts.
Every report independently confirms the pinned dictionary metadata and expected
term rows; VNDB also checks media rows. Fourteen immutable source snapshots
include the observer, runner, witness, workflow, complete benchmark overlays and
changed runtime files. API snapshots retain the exact run, job, artifact, source
commit and source tree identities.

## Sampled memory results

The following values are candidate-versus-baseline percentage changes in the
maximum eligible sampled whole-tree sum, calculated separately for the two
adjacent A/B pairs in each job. Positive values indicate higher candidate memory.
These are descriptive paired results, with no confidence interval or complete
peak-memory claim. A job must qualify all four observations before reporting any
pairs.

| Corpus | Replication | PSS changes, pair 1 / pair 2 | Private changes, pair 1 / pair 2 |
|---|---:|---:|---:|
| JMdict | 1 | +1.562924% / +2.577745% | +2.499337% / +2.967593% |
| JMdict | 2 | unqualified / unqualified | unqualified / unqualified |
| Jitendex | 1 | +11.108525% / +10.952125% | +13.579703% / +13.806864% |
| Jitendex | 2 | +9.703045% / +8.160535% | +12.102028% / +10.145652% |
| VNDB | 1 | +5.670305% / −0.539787% | +7.635106% / −0.408263% |
| VNDB | 2 | +4.998436% / +4.211033% | +5.949762% / +4.793310% |

Exact KiB totals and unrounded arithmetic for every pair and observation are in
`memory-audit.json` and the unchanged raw `memory-comparison.json` receipts.
PSS apportions shared mappings; private memory is reported separately. The window
includes browser startup, import, sampled public readback and browser restart.
Individual process reads are non-atomic. Short-lived processes between scans and
processes already reparented before discovery can be missed. The sampler does not
measure a complete peak or isolate import-only retained memory.

**No elapsed time in this campaign is authoritative.** The unchanged quick
benchmark's internal timing labels cannot detect the external process sampler;
the outer plan, identity, observation and comparison explicitly override those
labels for this memory-only study. Runtime speed qualification remains separate.

## Frozen coverage rule and all failures

Executable paths identify browser seeds, with readable argv0 used only as a
fallback. All transitive descendants are included regardless of their titles.
The observer requires a stable PID/start-time/process metadata set before and
after each scan, readable browser and renderer roles, multiple readable processes,
and no disallowed read or identity-coverage failures.

The separately frozen `stable-single-thread-zombie-esrch-v1` rule exempts only a
failed `smaps_rollup` read with ESRCH when the same integer PID and start time are
confirmed before and after, both states are Z, both thread counts are exactly 1,
and both executable reads explicitly fail with ENOENT. Unknown counts, live
states, permission failures, reused PIDs and multithreaded zombie leaders remain
unqualified. Each failed read remains in `unavailableProcesses`; every narrow
exemption additionally retains its after-scan identity in `confirmedExitedZombies`.
No measured zero-memory value is invented for an exited task.

| Audit fact | Count |
|---|---:|
| Fixed observations | 24 |
| Total scans | 2,211 |
| Eligible stable, fully read browser/renderer scans | 1,709 |
| Qualified observations | 22 |
| Unqualified observations | 2 |
| Narrowly confirmed exited-zombie records | 109 |
| Confirmed identities, summed within observations | 23 |
| Stable scans with nonexempt unreadable processes | 4 |

The four remaining unreadable scans occur in JMdict replication 2, observations
1 and 2 (both A). They contain Z-state leaders with **two threads**, executable
ENOENT and `smaps_rollup` ESRCH. They correctly fail the frozen exception. Their
raw processes, error messages, null observation maxima and failed job status are
all retained. This final rule is not applied retrospectively to either earlier
campaign, whose evidence and qualification remain separate and unchanged.

The observer README contains the immutable upstream Linux source rationale and
its version limitation. A live compiled-C witness covers rewritten process
titles, arbitrary descendants, an ordinary unreaped single-thread child, and a
`pthread_exit` leader with a surviving thread. The latter remains rejected. Five
local witness tests pass, including 20 fail-closed mutations and denied-read
coverage. The exact witness source and original output are retained, along with
the hosted witness outputs for all six jobs.

## Public results and independent verification

All 24 browser reports preserve complete public results for the same 12
deterministic terms before and after restart, with nonempty entries and no
degraded dictionary availability. Their complete public objects agree across
both arms and both replications within each corpus. The independent Node helper
recomputes JavaScript's exact `JSON.stringify` SHA-256 values. It is sampled
public readback, not exhaustive all-term browser validation.

The audit also recomputes all 576 derived physical preview counters, requires
per-package physical stability, and permits only the predeclared raw content
offset/preview differences and a preview counter exactly derived from those raw
bytes. Every process partition, zombie exception, readable memory sum, eligible
sample count, qualified maximum, job result and pair arithmetic is independently
recomputed from the complete raw receipts without importing the sampler module.

Requirements: Python 3.10 or later, Node.js 22 or later, and temporary disk space.
No repository checkout, npm dependencies, browser, fixture download, native
compiler, process sampling or new dictionary import is required.

```sh
python3 /path/to/package/verify_memory_package.py /path/to/package --node /path/to/node
```

The verifier checks every package and raw member hash, the expanded TAR digest,
all artifact provenance, and the complete independent audit. It extracts to a
temporary directory and removes it afterward. The TAR contains sorted regular
members with fixed metadata and unchanged bytes, compressed with Python standard
library XZ preset 6. `raw-members.json` records each exact raw file; the package
manifest records all transport identities.

All six original GitHub ZIPs were checked against advertised byte lengths and
SHA-256 at acquisition and again before packaging. The compact transport retains
every uncompressed ZIP member plus each original ZIP's API identity and complete
member inventory. Original ZIP containers remain in the acquisition workspace;
rechecking a container digest additionally requires the original download.
No signed download URLs are included.

To rebuild from the original acquisition directory, including its original ZIPs,
use a new destination:

```sh
python3 /path/to/package/freeze_memory_package.py /path/to/original/collection /path/to/new/package
```

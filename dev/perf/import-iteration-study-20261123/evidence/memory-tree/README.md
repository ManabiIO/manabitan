# Original process-tree memory campaign: failed qualification preserved

Run https://github.com/ManabiIO/manabitan/actions/runs/45114745900 used harness
`75dc67eb4a4f67e56c7270a278c4d034b1955c6f` to compare baseline
`1e235059a4c05c2509e8757fccba43a2d60222df` and candidate
`51f095912b11ddd158ac173698eb322e2be99d12` in a separate fixed memory study.

**The campaign remains unqualified.** Thirteen of its 24 observations fail the
original process-memory coverage rules. No sample, observation, pair or failed
job has been removed, retried, replaced, or retrospectively reclassified here.
Any later sampler repair is a separate campaign.

## What the raw evidence establishes

Six jobs cover JMdict, Jitendex and VNDB, with two replications each. Replication
1 uses ABBA and replication 2 uses BAAB. All four observations are retained even
if one fails qualification. The sampling window includes browser startup,
dictionary import, complete sampled semantic readback, and browser restart.
None of the reported elapsed times is authoritative: the unmodified quick
harness cannot observe the external sampler, and its internal timing labels
do not override this study's explicit non-timing scope.

The independent audit recomputes the exact original per-sample and per-observation
rules, process identity/stability comparisons, readable process sums, eligible
sample counts, qualified maxima, job failures, and allowed memory pairs.

| Fact | Verified result |
|---|---:|
| Original observations | 24 |
| Total scans | 2,301 |
| Eligible stable, fully read browser/renderer scans | 1,689 |
| Observations failing original coverage rules | 13 |
| Stable scans containing unreadable processes | 87 |
| Unreadable process records in those stable scans | 89 |

All 89 stable unreadable process records have state `Z`, no executable path,
empty command arguments, and `smaps_rollup` error number 3 (`ESRCH`). Eighty-five
affected scans contain one such process; two contain two. These details explain
the recorded failure mechanism but do not remove or excuse failures under the
original rules. Failed observations retain null maxima and failed jobs retain
empty comparison-pair lists.

Only VNDB replication 1 passes all four original observations. Its two PSS
comparisons are **+4.194707%** and **+0.108392%**; private-memory comparisons are
**+5.156856%** and **+0.109744%**. This isolated passing job does not establish
campaign-wide memory nonregression. Samples are non-atomic, can miss short-lived
or already-reparented processes, and are not complete peak-memory measurements.

All 24 browser readback reports independently preserve complete public responses
for the same 12 deterministic terms before and after restart, with nonempty
results, no degraded dictionary availability, and equal semantic results across
arms. The exact JavaScript JSON digests are recomputed separately. Every derived
physical preview counter is also checked. This semantic evidence is sampled,
not exhaustive all-term browser readback.

Every API-advertised original ZIP was checked at collection and again before
packaging. Every raw receipt/member byte is retained. The complete package maps
remain stable within each arm across all six jobs, with exactly the two expected
parser JavaScript differences. Fourteen source snapshots are checked against the
immutable measured Git objects as well as the recorded CI source hashes.

## Offline verification

Requirements: Python 3.10 or later, Node.js 22 or later, and temporary disk space
for the raw receipts. No repository checkout, npm dependencies, fixture download,
process sampling, browser, native compiler, or dictionary import is needed.

```sh
python3 /path/to/package/verify_memory_package.py /path/to/package --node /path/to/node
```

The verifier checks every package hash, the uncompressed TAR digest, all raw
member identities, original artifact provenance, and the full independent audit.
It uses a temporary extraction directory that is removed afterward. Node is
needed only to reproduce JavaScript's exact `JSON.stringify` digest semantics.

`memory-audit.json` retains every observation's status and every stable unreadable
process record. `raw-receipts.tar.xz` contains all original artifact members, API
snapshots, complete process scans, HTML/JSON browser reports, unchanged semantic
audit/helper, and source snapshots. The TAR has sorted regular members, fixed
metadata and unchanged file bytes. XZ uses Python's standard-library LZMA preset
6, with an 8 MiB dictionary. `raw-members.json` and `package-manifest.json` verify
the exact member and transport identities.

Original ZIP containers remain in the acquisition workspace. The compact
publication retains all uncompressed members and each original API digest,
size, ID and full member inventory. A reviewer can verify every retained byte;
rechecking an original ZIP-container digest additionally requires the original
download. `original-zips.json` records this distinction explicitly. No tool-issued
signed download URLs or download-request scratch specifications are included.

To rebuild from the original collection (including its ZIPs), use a new output
directory:

```sh
python3 /path/to/package/freeze_memory_package.py /path/to/original/collection /path/to/new/package
```

Keep this package separate from prior memory diagnostics and any later
zombie-aware follow-up. Its failures remain part of the evidence.

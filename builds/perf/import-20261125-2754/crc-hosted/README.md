# Contiguous source CRC: complete hosted evidence

**Hold PR [#910](https://github.com/ManabiIO/manabitan/pull/910) as an
unqualified performance experiment.** The six-block timing screens do not
establish a material, reliable complete-import improvement. Both VNDB memory
replications fail the unchanged coverage gate. These failures are not measured
PSS/private regressions; their qualified maxima remain null.

The frozen product is `c2cf7647c67b02474301ed48e54a53205be0f027`, tree
`074e622aec0c6537c7f0d8ac92725dd62c28b73b`. Baseline and identical-product
control are `7d1643e6147a10cb2165e9744cf0e63b59e46632`. The later test annotation
head `2fe47fa3db04342d04eb4f309c5d74ef45eef9e3` changes no product/build inputs.
Measurements retain their actual frozen commit label.

## Results and preserved failures

The independent [full audit](CRC_AUDIT.md), [timing reconciliation](independent-timing-audit.json),
[memory reconciliation](independent-memory-audit.json), and
[cross-study package audit](cross-study-package-audit.json) retain all results.
All 69 original timing reports and 24 memory observations reconcile, including
2,435 original process-tree scans. All correctness receipts pass.

| Corpus | Median B/A | Median B/C | B faster than A | Memory replication 1 / 2 |
| --- | ---: | ---: | ---: | --- |
| JMdict | +1.085% | +0.301% | 1/6 | Pass / pass |
| Jitendex | -1.186% | -0.792% | 5/6 | Pass / pass |
| VNDB | +0.859% | +0.131% | 2/6 | Coverage failure / coverage failure |

Negative timing changes mean faster. Jitendex's B/A descriptive bootstrap
interval excludes zero, but its B/C interval crosses zero. VNDB has a +10.625%
worst identical-product C/A pair. No tail is discarded and no independent
qualification is inferred from this fixed screen.

VNDB replication 1 fails all four observations (covered gaps 330.483, 266.171,
322.760, and 370.240 ms). Replication 2 fails B2 at 452.155 ms. The original
250 ms rule remains unchanged. Replication 1 A2 also retains an unreadable
address-space scan; it is excluded under the original rule rather than counted
as zero. Both replication medians remain null. The one complete pair in
replication 2 does not qualify that failed replication.

The timing [run](https://github.com/ManabiIO/manabitan/actions/runs/45644628634)
and memory [run](https://github.com/ManabiIO/manabitan/actions/runs/45644635208)
are original attempt-one acquisitions. No study was reacquired or cancelled,
and no observation was replaced. Memory-acquisition timings are not timing
evidence.

## Archive

[archive-manifest.json](archive-manifest.json) binds all nine original artifact
ZIP digests to [provider metadata](github-artifacts.json), enumerates every
retained file, and lists every omitted binary with its hash and size. All
original textual members are byte-identical to the original ZIP members. The
archive also includes the exact workflows, protocols, observer/auditor source,
package-entry manifests, reports, markers, failures, and independent audit
scripts/results. The same-source package-entry bytes agree across all nine
jobs; ordinary ZIP metadata can differ between independent builds.

Only the original ZIP containers, twelve duplicate A/B release ZIP payloads,
and generated Python bytecode are omitted. Original timing artifacts did not
contain release ZIP payloads. Their supplied package hashes and complete entry
manifests remain intact. Original downloaded evidence remains available in its
existing location; this archive does not remove it.

## Portable verification and replay

Run ordinary Python without optimization. From the repository root, verify and
extract into a new or empty directory:

```sh
python3 builds/perf/import-20261125-2754/tools/verify_text_archive.py \
  builds/perf/import-20261125-2754/crc-hosted/archive-manifest.json \
  --extract /absolute/path/to/fresh-crc-extraction
```

Replay all saved raw memory scans without changing the original summaries:

```sh
python3 builds/perf/import-20261125-2754/tools/audit_memory_saved.py \
  --candidate c2cf7647c67b02474301ed48e54a53205be0f027 \
  /absolute/path/to/fresh-crc-extraction/artifacts/memory/*
```

The adapter hash-checks and invokes each artifact's original auditor. A passed
reconciliation means the preserved result was reproduced exactly; the two
VNDB memory gates remain failed. Full package/receipt verification additionally
requires the matching omitted `A-product.zip` and `B-product.zip` files placed
back into each extracted memory artifact directory. Then invoke its captured
`source/dev/perf/import-memory-20261124-3aac/verify_receipts.py` with that
artifact directory. Package-entry hashes alone cannot replace the ZIP bytes.

For timing, use the unchanged captured auditor with explicit repository and
Node 22.22.0 paths. The repository must contain the frozen baseline harness
files; this evidence checkout does. For example, replay JMdict:

```sh
python3 builds/perf/import-20261125-2754/tools/audit_timing.py \
  --auditor /absolute/path/to/fresh-crc-extraction/independent-audit/timing-auditor.py \
  --repository /absolute/path/to/repository \
  --node /absolute/path/to/node-22.22.0 \
  --candidate c2cf7647c67b02474301ed48e54a53205be0f027 \
  --recorded-audit /absolute/path/to/fresh-crc-extraction/independent-audit/timing-jmdict-audit.json \
  /absolute/path/to/fresh-crc-extraction/artifacts/timing/15036814976/cohort
```

Use `timing-jitendex-audit.json` with artifact `15038541229`, and
`timing-vndb-audit.json` with artifact `15038993452`. The adapter reopens all 23
reports per corpus, preserves original exclusions and validation, and requires
exact equality with the complete recorded independent result. All three were
successfully replayed from fresh archive extraction, as were all six raw
memory audits. These are saved-evidence checks; no browser acquisition occurs.

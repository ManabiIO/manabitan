# Native metadata publication preflight: complete hosted evidence

**Hold PR [#914](https://github.com/ManabiIO/manabitan/pull/914).** The target
JMdict screen regresses: median paired complete-import time increases
**1.471% against A and 1.724% against C**, with the candidate slower in all six
pairs against both baseline controls. VNDB memory replication 2 also fails all
four coverage observations. The component publication improvement does not
establish an import improvement.

The frozen product is `b2e816c4714f42f87cbb6a1ebc7fe1a2d2fd863b`, tree
`be5b6a8d9c24915516d6edd8167a071e0449d793`. Baseline and identical-product
control are `7d1643e6147a10cb2165e9744cf0e63b59e46632`. Later validation head
`b273513dab4fa409a0213a2db470e52b4a0f559c` adds formatting with retained exact
normalized-AST equivalence and test-fixture guards. All measurements retain
their actual frozen preformat source label.

## Results and preserved failures

The [complete independent audit](study-audit-summary.md),
[exact summary](study-audit-summary.json),
[all 69 timing observations](all-timing-observations.csv), and
[all 24 memory observations](all-memory-observations.csv) retain every result.
The unchanged auditors reconcile all raw timing reports and 2,486 raw memory
scans. All correctness receipts pass. Six fixed balanced timing blocks per
corpus are exploratory screens, with no independent timing qualification.

| Corpus | Median B/A [descriptive 95% interval] | Median B/C [descriptive 95% interval] | B/A wins | Memory replication 1 / 2 |
| --- | ---: | ---: | ---: | --- |
| JMdict | +1.471% [+0.811%, +10.987%] | +1.724% [+0.570%, +4.450%] | 0/6 | Pass / pass |
| Jitendex | -0.144% [-5.161%, +6.399%] | -0.679% [-3.532%, +4.731%] | 4/6 | Pass / pass |
| VNDB | -1.217% [-3.550%, +2.273%] | -1.571% [-5.355%, +0.818%] | 5/6 | Pass / coverage failure |

Negative changes mean faster. Non-target intervals cross zero. JMdict's worst
B/A pair is +17.657%; its matching identical-product control also varies.
Every observation remains included, and control drift is not subtracted from
the candidate result. The six-pair descriptive intervals have no
multiple-comparison adjustment.

VNDB replication 2 preserves covered gaps of 318.904967, 252.904922,
276.914989, and 379.334888 ms, in acquisition order B1/A1/A2/B2. The original
250 ms limit is unchanged. All four qualified maxima and both aggregate
memory metrics remain null. The passing first replication and correctness
receipts do not repair the failed second replication. This is a coverage
failure, not a measured PSS/private regression.

The timing [run](https://github.com/ManabiIO/manabitan/actions/runs/45645363685)
and memory [run](https://github.com/ManabiIO/manabitan/actions/runs/45645371602)
are the original frozen acquisitions. No observation was rerun, replaced,
discarded, or pooled with another source or stage. The separate
[source review](source-review.md) found no correctness blocker. The final
component admission audit found no concrete structural fix and does not claim
a measured admission rate or infer causation from overlapping phase timers.

## Archive

[archive-manifest.json](archive-manifest.json) binds all nine original ZIPs to
[provider identities and digests](github-artifacts.json), enumerates every
retained text file, and records every omitted binary's hash and size. Every
original textual ZIP member is retained byte-for-byte, including protocols,
workflows, observer and auditor source, package-entry manifests, raw reports,
markers, logs, failure records, and receipt audits. Independent summaries added
after download are identified as supplemental text.

Original ZIP containers, twelve duplicate A/B release ZIP payloads, and
generated Python bytecode are omitted. The original timing artifacts had no
release ZIP payloads; their supplied package hashes and complete entry
manifests remain intact. Original downloaded evidence is preserved separately.
An early queued-status snapshot remains labeled historical; it is not a
replacement for completed study outcomes.

## Portable verification and replay

Run ordinary Python without optimization. From the repository root, verify and
extract into a new or empty directory:

```sh
python3 builds/perf/import-20261125-2754/tools/verify_text_archive.py \
  builds/perf/import-20261125-2754/metadata-hosted/archive-manifest.json \
  --extract /absolute/path/to/fresh-metadata-extraction
```

Replay saved raw memory scans without overwriting the recorded summaries:

```sh
python3 builds/perf/import-20261125-2754/tools/audit_memory_saved.py \
  --candidate b2e816c4714f42f87cbb6a1ebc7fe1a2d2fd863b \
  /absolute/path/to/fresh-metadata-extraction/artifacts/memory/*
```

Successful reconciliation reproduces each original result exactly, including
the failed VNDB replication. Full package/receipt verification additionally
requires matching omitted `A-product.zip` and `B-product.zip` bytes restored
to each extracted memory artifact directory; invoke its captured
`source/dev/perf/import-memory-20261124-3aac/verify_receipts.py` with that
directory. Retained manifests are not replacements for those bytes.

For timing, supply the unchanged retained auditor and explicit repository and
Node 22.22.0 paths. The repository must contain the frozen harness files; this
evidence checkout does. For example, replay JMdict:

```sh
python3 builds/perf/import-20261125-2754/tools/audit_timing.py \
  --auditor builds/perf/import-20261125-2754/tools/audit_cohort_original.py \
  --repository /absolute/path/to/repository \
  --node /absolute/path/to/node-22.22.0 \
  --candidate b2e816c4714f42f87cbb6a1ebc7fe1a2d2fd863b \
  /absolute/path/to/fresh-metadata-extraction/artifacts/timing/15039675829/cohort
```

Use artifact `15037874732` for Jitendex and `15039728256` for VNDB. Each
artifact's supplemental `independent-timing-audit.json` contains its recorded
whole result. All 23 reports per corpus are reopened with unchanged validation,
and the complete recomputed result must match exactly. Saved-evidence replay
requires no browser acquisition.

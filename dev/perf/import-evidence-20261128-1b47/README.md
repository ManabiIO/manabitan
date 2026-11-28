# Manabitan import component evidence — 2026-11-28 UTC

This branch preserves reproducible evidence for two small product proposals
against baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
The bundles support component improvements; neither establishes a complete
browser-import speedup. Product changes are on separate branches.

| Proposal                                                                                                                                            | Product commit                             | Measured scope                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Restore indexed compact score-key validation](https://github.com/ManabiIO/manabitan/commit/b15bad43acdfd54d541895cac1109c0e5ba51b2f)               | `b15bad43acdfd54d541895cac1109c0e5ba51b2f` | Approximately 1.57–1.60 ms saved per complete warm validation of 12 actual JMdict field buffers / 528,299 rows                         |
| [Use existing CRC tables for eight- and four-byte gap tails](https://github.com/ManabiIO/manabitan/commit/5909db31ebe859fce1cc4b38324271ddf9f3dd59) | `5909db31ebe859fce1cc4b38324271ddf9f3dd59` | 6.82–8.65% lower summed CRC phase in two complete sequential VNDB parser cohorts; the direct verifier interval includes no improvement |

## Evidence bundles

Read the component README before interpreting a timing result:

- [Score restoration scope, validation and reproduction](score-restoration-README.md)
- [CRC scope, weaker controls and reproduction](crc8_4-README.md)

Each `.tar.gz` has an external `.manifest.json` listing every member's exact
size and SHA-256 and binding the entire archive. The `.sha256` file binds the
archive and manifest. Extract into a new directory; original workspace-relative
paths are preserved. The retained packager verifies the archive without
extracting it.

The archives include frozen scripts, source identities, observations,
correctness checks, failed attempts and negative controls. Score's small actual
numeric inputs are included. Large dictionary ZIPs, source captures and build
dependencies have explicit hashes and reconstruction instructions rather than
being duplicated here. The CRC README discloses the missing exact-driver binding
for one early rejected slicing32 exploration.

## Hosted qualification

- [Score restoration study, run 46106456744](https://github.com/ManabiIO/manabitan/actions/runs/46106456744)
- [CRC study, run 46107723369](https://github.com/ManabiIO/manabitan/actions/runs/46107723369)

Both exact product-source validation jobs passed before publication. At package
preparation, the complete browser timing/restart/media/storage/memory matrices
were queued. The archived receipts state their observation time; future job
completion does not retroactively change those snapshots.

The larger enclosing Node timing changes are not attributed to these
components. The score loop's owning phases were flat, and CRC's unchanged
inflation phase also moved. Rejected CRC variants remain visible. Do not add
component timings to overlapping worker phases or apply their percentages to a
whole import.

## Held score-cache investigation

The [complete cache experiment readout](cache-held-README.md) preserves both
source revisions, all actual numeric inputs and all fixed observations. V2's
warm JMdict encoder improvement did not pass its predeclared common-path
criterion: all four upper bounds exceeded +5%, and the all-in-range control
showed a positive slowdown against both identical baselines. There is no cache
product PR. The conditional first-use study was never implemented or run.

The cache archive, external member manifest and checksum file are stored here
as `score-cache-held-evidence-20261128-1b47.*`. Its archive SHA-256 is
`3a2ef15ec420b06bcff2db905b69454520c291479ac6a20a6af1344b0788acda`.

## Other experiments and preserved failures

The [session investigation readout](session-held-README.md) covers the pipeline,
checkpoint, compression, inflater, glossary-reuse and parser experiments. Its
sealed archive preserves the status snapshot at 2026-11-28 06:32:35 UTC, including
all selected raw observations, controls, scripts, source bindings and failures.
Later browser results are identified separately; they do not rewrite the sealed
snapshot.

The session archive, external member manifest and checksum are stored here as
`import-session-held-evidence-20261128-1b47.*`. Its archive SHA-256 is
`eed792a9c77ffcdc65fcffa2106157b365dc8a56369a06bcd640d1b6ba060f8b`.

## Completed browser results through 06:46:37 UTC

The [browser-results addendum](browser-results-addendum-README.md) preserves the
later checkpoint JMdict/Jitendex and pipeline VNDB cohorts, including all raw
reports and 1,052 memory scans. The checkpoint candidate did not establish a
whole-import gain and is closed without a PR. Pipeline VNDB is a flat control
that does not activate the proposed overlap.

The immutable addendum archive, member manifest and checksum are stored here as
`browser-results-addendum-20261128-1b47.*`. Archive SHA-256:
`76b1ae9451052684192902916b5cdeb1e812ff806b064d0773e6d2bdf242ec98`.

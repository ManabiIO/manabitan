# Combined import optimization: hosted browser qualification

Run [45114362649](https://github.com/ManabiIO/manabitan/actions/runs/45114362649) compares the combined changes from PRs #809, #810 and #811 against their common #801 baseline. All six jobs completed successfully, and the independent audit passes every recorded source, package, fixture, count, semantic response and restart guard. This evidence is separate from the original 24-cell campaign and its retained failures.

## Frozen identities

- Baseline A: `1e235059a4c05c2509e8757fccba43a2d60222df`.
- Candidate B: `62891eb93d64877a404c9fc8025e0e051f6b5cfb` (combined runtime tree `0fd0a2a237b66eb95061d3072d07d2c432abe1a5`).
- Harness: `b910f2502300b8fe8ff0a28185317ec22d704247` (tree `72a04f85698f0539a88da70cd005028c37c47e22`). The retained source files were obtained from local commit `697fc67c8f20400a73b0611e6f474640537e3dd9`, whose entire Git tree equals the published harness tree. The published commit/tree API receipt and per-file hashes are retained.
- Node `22.22.0`; Chromium `153.0.8010.12` in every timed observation.
- Dictionary archives, release URLs, sizes, SHA-256 values, revisions and row counts are pinned by the retained fixture lock and checked for every observation.

## Timing method and observed results

Each of the two independent jobs per dictionary uses the frozen 26-observation schedule: two warmups, two A/A control pairs, eight candidate pairs alternating AB/BA, and two final A/A control pairs. Replication 2 reverses the initial candidate order. All 156 observations are retained. Warmups and A/A controls are excluded from candidate statistics. No observations or outliers were discarded. The timing boundary is the existing browser `totalImportMs` boundary, with no tracing, import flags or external memory sampler enabled.

The main statistic is the median of the fixed paired changes, `100 × (B/A − 1)`. Negative values mean a shorter import. Per-arm medians below describe the same candidate observations; their ratio is a different statistic and must not replace the paired median. The two jobs use different runners, so pooled absolute medians are descriptive.

| Dictionary | A median (ms) | B median (ms) | Paired median change | B faster | A/A median | A/A range |
|---|---:|---:|---:|---:|---:|---:|
| jmdict | 971.80 | 999.65 | +0.865% | 6/16 | -0.579% | -15.385% to +3.702% |
| jitendex | 1792.95 | 1563.55 | -13.212% | 16/16 | -1.714% | -3.384% to +1.495% |
| vndb | 8202.80 | 7845.10 | -4.084% | 15/16 | -0.493% | -6.908% to +4.709% |

### Replication details

Each row contains eight candidate pairs and four A/A control pairs. Full raw pairs, warmups, before/after control groups, source identities and ordered observation hashes are in `combined-audit.json` and the compressed receipts.

| Dictionary / replication | A median (ms) | B median (ms) | Paired median | B faster | A/A median | A/A range |
|---|---:|---:|---:|---:|---:|---:|
| jmdict / 1 | 1022.75 | 1030.75 | +0.497% | 3/8 | -0.579% | -1.421% to +3.172% |
| jmdict / 2 | 940.00 | 948.95 | +1.138% | 3/8 | -0.177% | -15.385% to +3.702% |
| jitendex / 1 | 1924.90 | 1681.35 | -12.672% | 8/8 | -1.507% | -3.384% to +1.495% |
| jitendex / 2 | 1652.35 | 1422.60 | -13.952% | 8/8 | -1.714% | -2.509% to +1.121% |
| vndb / 1 | 8983.60 | 8633.20 | -3.484% | 8/8 | -0.493% | -3.790% to +4.709% |
| vndb / 2 | 7235.40 | 6971.15 | -4.561% | 7/8 | -1.268% | -6.908% to +4.283% |

Jitendex improves in all 16 pairs, with both replication medians well outside the A/A ranges. VNDB shows an observed 4.084% paired median reduction and 15 of 16 faster pairs; its control range overlaps the measured effect, so the size remains runner-sensitive. JMdict has no demonstrated whole-import improvement in this campaign. These are direct measurements of the combined candidate. They are not sums of the earlier isolated component effects, and they do not establish a universal percentage on other machines or dictionaries.

## Correctness scope

Every observation verifies the complete exact-lookup responses for **12 deterministic terms per dictionary**, immediately after import and after browser restart. The audit recomputes exact JavaScript JSON serialization digests and requires all entries to be present without degraded public responses. This is sampled browser readback, not an exhaustive browser lookup of every dictionary term.

The six cells contain 312 checked before/after states, 3,744 derived physical preview counter checks and 5,928 retained physical rows. Semantic entry counts per state are 12 for JMdict, 17 for Jitendex and 13 for VNDB. Public responses remain identical across arms and restarts. Physical storage identities remain stable within each arm. JMdict and VNDB physical samples are identical across arms. Jitendex permits only the precisely enumerated offset/preview differences caused by compressed shared content, plus the independently recomputed preview counter derived from those same rows. The preview is encoded reference storage, not decoded glossary content. Direct persisted file lengths were not retained; no inferred size is presented as a direct file stat.

Exactly five packaged runtime files differ between A and B: the term record store, parser worker, parser, importer and source ZIP media pack. Each of those five file hashes in every package matches the retained original Git blob bytes for its pinned arm commit. Git blob object IDs, SHA-256 values and trees are retained and verified. Every other packaged file hash is equal across arms, and timing harness file hashes are identical across replications. Original extension ZIPs are not retained by the benchmark artifact; their recorded whole-ZIP hashes cannot be recomputed from this package. The complete recorded package-member inventories and source hashes are retained and verified.

No memory diagnostics were scheduled in this combined campaign. It makes no whole-process-tree memory, peak-memory or memory nonregression claim. Separate memory campaigns retain their own raw qualification outcomes. The original failed Jitendex physical-digest campaign and original insufficient memory coverage remain preserved in their separate evidence packages; this later run does not reclassify them.

## Durable evidence and verification

`raw-receipts.tar.xz` is a deterministic USTAR stream compressed with XZ preset 6. It contains every original artifact member byte, per-artifact manifests, final normal GitHub API metadata, frozen harness files and source provenance. All six advertised original ZIP SHA-256 values and sizes were verified during collection and again immediately before packaging. `original-zip-verification.json` retains those acquisition identities and complete member inventories. Original ZIP containers remain in the collection workspace to avoid storing both container and extracted bytes; recomputing a ZIP-container SHA requires the original downloaded ZIP. The portable verifier checks every retained member byte and its inventory. Tool-issued signed download URLs and download-request scratch specifications are excluded.

`combined-audit.json` is derived evidence. `audit_combined.mjs` recomputes semantic/physical/source checks directly from the raw members. `verify_package.py` checks the package and raw inventories, re-runs that auditor, and independently recomputes paired statistics in Python. It starts no browser and performs no dictionary import. Python 3 with standard-library LZMA support and Node.js 22 or later are sufficient; no npm packages are needed.

```sh
python3 verify_package.py . --node node
```

To rebuild from the retained collection tree (which contains the original artifact ZIPs):

```sh
python3 build_evidence_package.py /path/to/round2-combined-artifacts /path/to/new-package
```

The source tree and workflow in the raw archive record the exact hosted reproduction procedure. A new hosted campaign will produce new observations and must be retained as separate evidence rather than replacing this frozen run.

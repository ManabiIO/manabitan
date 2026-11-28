# Frozen native component screen

This kit screens six independent native parser changes against two identical
baseline controls. It is based on develop
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. It adds no product change. A promising
component result can nominate a separate complete-browser import experiment;
these measurements alone cannot qualify an optimization PR.

## Frozen arms

| Arm | Native change                                                         | Parser bytes | Difference from baseline |
| --- | --------------------------------------------------------------------- | -----------: | -----------------------: |
| A   | Baseline                                                              |       67,659 |                        0 |
| B   | Recognize existing short structured tags before a closing object      |       67,751 |                      +92 |
| C   | Byte-identical baseline control                                       |       67,659 |                        0 |
| D   | Separate strict glossary root validation from nested subtree scanning |       69,628 |                   +1,969 |
| E   | Inline the row dispatcher                                             |       69,275 |                   +1,616 |
| F   | Inline the strict row implementation                                  |       75,929 |                   +8,270 |
| G   | Keep composite hint flags in locals and publish on return             |       67,714 |                      +55 |
| H   | Terminal tags plus `th`, `td`, `tr`, `table` and `ol`                 |       67,969 |                     +310 |

Each patch applies independently to the baseline. H contains B's terminal-tag
behavior plus the five listed literals. A and C instantiate independent modules
and heaps from the exact same bytes. All arms use the unchanged baseline
JavaScript parser and lookup preparation code.

`plan.json` freezes source, binary, manifest, dictionary, runtime and grouping
identities. `prepare.mjs` applies each C-only patch to a private source copy,
validates the existing native manifest/source binding, and rebuilds both native
targets using their unchanged manifest arguments. Clang and LLD must both be
21.1.8. Every rebuilt module must equal its stored artifact byte for byte; the
canonical scanner must remain unchanged. Source and kit identities are checked
again after acquisition.

## Input and production policy

The only timed fixture is the locked JMdict 2026-11-22 archive: 15,645,766 bytes,
53 term banks and 528,299 rows, SHA-256
`3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`.
The runner checks archive size and hash, ZIP entry CRCs, index title/revision,
bank numbering, and the complete row total. It records each bank's hash and
exact group membership.

The archive image flag comes from all actual ZIP filenames using the production
image-type helper. This JMdict archive has no images, so `mediaHintFastScan` is
false. The replay models the unchanged lazy byte-balancing policy with an
explicit three-parser-worker count, four groups per worker and a 24 MiB target.
That produces twelve groups. The partition helper comes from the source-bound
`test/perf/segmented-lookup-ownership-20261125/replay.mjs`.

The twelve groups execute **serially** within every arm. There are no browser
workers in this study. Raw ZIP inflation, CRC checking and loading happen before
measurement. This component model does not reproduce worker overlap, complete
import scheduling, compression, OPFS storage, image import or browser UI work.

## Acquisition and interpretation

The one-job Actions workflow pins Ubuntu 26.04 and Node 24.22.3. Before starting
Node, it selects the second CPU in the initial allowed affinity, or the sole CPU
when only one is available. The initial and selected affinities are recorded.
This rule is fixed before observing any timing result.
The harness requires Linux affinity APIs and `/proc` for these host receipts.

Each arm gets two full-corpus untimed warmups in orders `ABCDEFGH` and
`HGFEDCBA`. The sixteen measured blocks are committed in `plan.json`: eight
cyclic Williams rows, followed by their reversed rows in reverse row order.
Every arm occurs twice in every position, and every directed adjacency within
a block occurs twice. There are sixteen full-corpus observations per arm and
128 observations in total. Explicit garbage collection runs immediately before
every pass, outside native timers.

The primary measure is current-thread CPU time spent inside
`parse_and_encode_term_bank_token_binary_dedup`. Its wall time, all selected
native export times and the JavaScript parser/lookup API wall time are retained
as diagnostics. The native wrapper measures only calls made during that API
invocation. Module compilation, ZIP work, garbage collection and output hashing
are outside native-call timers. The wall diagnostic also excludes output
hashing. Raw call counts and timings are retained for every observation.

Every pass, including warmups, verifies a framed full-output SHA-256 against
baseline A. The digest covers every numeric column, dedup ID, interned key
column, exact prepared lookup byte, route filter, canonical content row and both
content hashes, plus media fields and lazy byte views. Counts and parser fallback
behavior must match. This is full output verification rather than a row sample.

The summary reports each candidate against both A and C, and C against A,
including all paired changes, medians, equal-work ratios and faster-pair counts.
It does not automatically select or promote a winner. Identical-control spread
is part of the evidence. No outlier deletion, adaptive warmups, extra blocks or
control-driven resampling are allowed. An incomplete run remains incomplete.
The workflow ignores rerun attempts; a repaired protocol requires a separately
reviewed acquisition rather than continuation of partial timings.

## Correctness evidence and local portability check

`prevalidation.json` preserves source-bound local correctness receipts for the
subtree, hint-local and expanded-tag candidates. Each matches all 937 banks and
7,613,164 rows across the current locked JMdict, Jitendex and VNDB fixtures,
including media-enabled parser outputs. These broader media-enabled checks are
correctness evidence; their flags and two-bank grouping are not the timed
JMdict policy. The new hint and expanded-tag malformed/fallback suites also
passed before this kit was frozen. The terminal-tag candidate has separate
source-frozen full-browser qualification in progress.

To check portability without acquiring any timing, prepare a fresh output
directory and invoke the runner's explicitly untimed mode:

```sh
node dev/perf/native-components-20261128-1c413/prepare.mjs builds/perf/native-components-local
node --expose-gc dev/perf/native-components-20261128-1c413/run.mjs \
  builds/perf/native-components-local /absolute/path/JMdict.zip --verify-only
```

This mode executes one full pass per arm, compares all outputs, and records no
CPU or wall timing. It writes a separate `verification` receipt and cannot
produce timing contrasts. The hosted workflow runs only the committed measured
protocol and uploads every observation, source stage, rebuild receipt and
failure under the exact acquisition commit.

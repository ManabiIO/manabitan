# Reference-table record fields: latest-source qualification

This is a prospective correctness and persisted-size qualification of runtime
`85a8aa49f76fbabd2dc494aad247f74774ff2573`, based on
`a300da36d00df8e353c5679b1528b50a1299b75f`. Both corpus arms use the same frozen
candidate. Arm A leaves `experimentalReferenceTableFields` disabled; arm B sets
it to exactly `true`. No elapsed-time result from this helper is performance
evidence.

The candidate uses dictionary storage floor 13 when a format4 chunk actually
becomes authoritative. The parent already uses floor 12 for its online content
root. This qualification remains separate from the earlier dcfc/f28 observations
and from the browser storage cohort. The latter exercises real media storage,
restart, lookup, and installed SQLite floor, which this term-sink replay omits.

## Frozen inputs and original oracles

`verification-manifest.json` pins the parent and candidate runtime trees, each
relevant source and generated asset, the exact Node executable, and all eight
original corpus oracle files. `verification-oracles.tar.gz` contains those files
unchanged. The runner verifies each archive member's path, type, size, and SHA256
before extracting it; acquisition preflight checks the same identities again.

The core runner, bounded filesystem adapter, independent record-field decoder,
full-file format4-to-format2 expansion, lazy-record-ID decoder, and all corpus
oracles were recovered byte-for-byte from helper commit
`343884244602d3ecbbbfdc4cb2efee0190567b58`. `source-preparation.json` records every
recovered file's immutable identity. The only three existing-helper edits are
the new evidence directory, the actual a300 reader's floor13/max12 assertions,
and observation of a300's content activation and persistent purge hooks. The
new hosted driver and workflow orchestrate those preserved helpers.

The source profile admits the explicitly listed a300 changes while requiring
every other historical source identity to match. The two native dictionary WASM
targets retain the original compiler/linker 21.1.8 manifest and asset hashes.
Generated third-party assets retain their existing exact pins: their complete
build inputs are unchanged, and actual built bytes must match during preflight.
ZIP normalization is limited to the original 24 esbuild source-path comments.

## Hosted acquisition

Dispatch `.github/workflows/reference-field-corpus-qualification-4d9f.yml` from
the tooling commit that contains these files. The workflow uses Ubuntu 26.04,
Node 22.22.0, the repository lockfile, and the normal `build:libs` command. It
checks out the runtime and previous reader by exact commit, independently of the
tooling checkout.

The first job checks portable helper syntax/contracts and scoped JavaScript
lint, then invokes the actual previous reader against a real SQLite database
and actual candidate-written format4 files. It must reject floor 13 before any
recovery, content prepare or activation, persistent purge, record prepare,
schema initialization, runtime pragma, or health restoration. Every SQLite and
OPFS byte must remain unchanged.

Only after that job succeeds do the three corpus jobs start. Each job downloads
its unchanged checksum-pinned fixture through the repository fixture helper,
runs one complete default-off acquisition, runs one complete enabled
acquisition, and compares the complete results. Every arm uses a fresh process
and output directory, 512 MiB Node heap, the recorded four-core/eight-GiB helper
policy, the current production grouping, and four production codec workers.
Existing row, source-bank, media-reference, archive CRC, and complete final-file
checks remain active. No group is reduced or discarded to fit a runner.

Failed and successful processes retain their raw logs, exact exit/signal,
source/helper/fixture identities, resource observations, progress, and all
available result receipts. The launcher does not retry an unchanged failure.
Each job uploads its reports even when a check fails.

## Reproduce one corpus manually

Prepare three ordinary checkouts: this tooling commit, candidate85a8 above, and
parenta300 above if running the downgrade proof. Install the candidate's exact
dependencies with `npm ci`, make those dependencies available to the tooling
checkout, and run `npm run build:libs` in the candidate. The previous-reader
check additionally needs its normal bundles and the same locked dependencies.

From the tooling checkout, with Node 22.22.0 on the path:

```sh
python3 test/perf/record-reference-table-verification/hosted-qualification.py \
  --phase corpus \
  --source-root /absolute/path/to/candidate85a8 \
  --node "$(command -v node)" \
  --corpus vndb \
  --cache-dir /absolute/path/to/pinned-fixture-cache \
  --output /absolute/path/to/new-report-directory
```

Use a fresh tooling checkout for each invocation that extracts the oracles; the
driver refuses to overwrite extracted files or acquisition directories. The
workflow already provides an independent checkout for each job. Substitute
`jmdict` or `jitendex` to qualify those complete corpora. The explicit protocol
and source manifest are checked before any import work.

## What a passing result establishes

A passing pair proves every actual written field row resolves to the original
source values, every format4 reference-table entry and original row ID is
retained exactly, every final index chunk was reread and checked, and the
independently expanded files plus all logical metadata equal the original full
corpus oracle. The disabled writer must preserve every original file byte.
Reported saving is the difference in actual drained file sizes, equal to the
exact changed record-field bytes. It is neither reserved capacity nor a
hypothetical deduplication estimate.

This helper does not measure whole-browser import speed or browser memory. It
does not persist or format media, perform the settings UI flow, publish the
SQLite dictionary transaction, or run the online optimizer. The separate
source/iterator, actual previous-reader, and browser storage gates cover those
respective boundaries. No older-browser restart is claimed by the focused
previous-reader test.

# VNDB media diagnostics component study

This study replays captured native media columns through the production importer to measure media-requirement materialization and compaction. It excludes archive reading, parsing, image payload work, database writes, and full import completion. The capture used the actual native parser and its Node worker adapter, a fixed `hardwareConcurrency = 4` and `deviceMemory = 8`, and three workers. It contains all 6,648,310 term rows across 665 banks and 170 groups; 146,725 media rows yield 146,570 distinct deferred references.

## Preserved results and decisions

The pooled candidate eliminated **270,731 eager UTF-8 decodes**. All 22 original timing observations have the same complete semantic-reference digest, reference count, and missing-media diagnostic samples. Its six alternating A/B pairs were all faster for this component, with median paired change **-47.14%**. The four A/A control pairs show substantial host noise and remain in the original receipts.

`retention.json` contains six separate fresh-process forced-GC snapshots in `ABBAAB` order, after captured rows were dropped. The pooled candidate retains 170 diagnostic arenas using 340 backing buffers: 4,207,278 bytes of key data and 2,347,600 bytes of spans. Its JavaScript heap snapshots were about 8.15 MB lower, while backing-buffer bytes rose about 6.55 MB. These are retained component snapshots, not whole-import peak-memory measurements. Report the heap and backing-buffer figures separately; do not treat RSS differences as a stable memory improvement.

The earlier direct-buffer variant is preserved in `direct-buffer-*`. It also avoided eager decoding, but retained many small typed-array/buffer wrappers and was replaced by the pooled design. It has no separate forced-GC retention study. Its timing result is exploratory and is not the shipped candidate's result.

## Identity

| Arm | Frozen source |
| --- | --- |
| Baseline | `1e235059a4c05c2509e8757fccba43a2d60222df` |
| Pooled candidate, local | `f836c595bce05ae7e97fdb0a8ea03dc8215a27f5` |
| Pooled candidate, published | `7272ea938fd3de01bd40efcd4ee838c3249d0587` |

`provenance.json` preserves the original measurement-time HEADs and exact runtime file hashes. Both HEADs there are the baseline because the candidate was measured before commit. `identity.json` maps the frozen files to the later commits. A subsequent test-only JSDoc correction leaves the measured runtime hashes unchanged. `pooled-candidate.patch` and `direct-buffer-candidate.patch` preserve both source variants.

The omitted `native-media-chunks.bin` capture is 64,449,222 bytes, SHA-256 `9344108f0b5728772d15ce5fc7b4e1872e7324b9a689d174785f7fc2218a4ee1`. It is regenerated from the pinned VNDB archive; original capture identity remains in `capture.json`. The production pipeline delivers importer callbacks in group order despite worker completion order. Use the pinned Node/V8 version for the serialized binary; full-media correctness keeps its strict original capture-hash guard. The capture was not regenerated during evidence packaging. Replay restores worker-owned buffer geometry before either arm is measured.

## Reproduction

Use Node **24.22.3** and Python 3. In both source checkouts run their locked `npm ci` and `npm run build:libs`. The capture uses the existing `test/fixtures/parser-settlement/worker-node.mjs` adapter. Obtain the pinned VNDB archive from the URL in the repository's optional VNDB fixture lock (tooling commit `4e568fcde29fb93df9a856eab5d177b741d99bce`): it must be 291,705,969 bytes, SHA-256 `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`.

The original runners retain their one-off absolute paths unchanged. `prepare-reproduction.py` creates separate copies with only literal paths adapted and records both original and adapted runner hashes. It verifies the archive, parser Wasm, and source identities before creating runners. It does not execute observations.

```sh
evidence=/absolute/path/to/round2-component-evidence
baseline=/absolute/path/to/baseline-at-1e235059a-checkout
candidate=/absolute/path/to/pooled-candidate-checkout
archive=/absolute/path/to/vndb_characters_by_bee.zip
media_output=/absolute/path/to/new-media-reproduction-directory

python3 "$evidence/media/prepare-reproduction.py" \
    --variant pooled --baseline "$baseline" --candidate "$candidate" \
    --archive "$archive" --output "$media_output"
NODE_OPTIONS=--max-old-space-size=1536 node "$media_output/capture.mjs"
python3 "$media_output/run.py"
python3 "$media_output/retention.py"

# A separate correctness-only pass; no timing observations are collected.
python3 "$media_output/full-media-parity/run.py" \
    --baseline "$baseline" --candidate "$candidate" --fixture "$archive" \
    --capture "$media_output/native-media-chunks.bin" \
    --wasm "$baseline/ext/lib/term-bank-parser.wasm"
```

`run.py` keeps the exact original schedule: A/B warmups, two A/A control pairs, six alternating A/B pairs, then two A/A control pairs. `retention.py` is an exact transcription of the original Python stdin loop, and runs six fresh `node --expose-gc` processes in `ABBAAB` order. These two scripts write new receipts only in the reproduction directory.

To reproduce the rejected direct-buffer design, create a separate baseline-at-`1e235059a` checkout, apply the preserved `direct-buffer-candidate.patch` there, and use `--variant direct` with a different fresh output directory. Run its generated `capture.mjs` and `run.py`; do not use the pooled candidate checkout or infer a retention result that was never measured.

## Full image correctness addendum

`full-media-parity/` preserves a separate serial comparison of the actual source pack/validator and generation index at unchanged production limits. All **146,570 real image payloads**, the complete **195,649,882-byte packed Blob**, ordered records, descriptor, **163,034 index slots**, three missing-image diagnostics, and a corrupted real payload's error matched. The candidate checkout includes a test-only JSDoc follow-up (`6cb16bd28626d597c6be736068d0cc71773200db`); runtime hashes still match published `7272ea938fd3de01bd40efcd4ee838c3249d0587`.

This addendum records no timings and performs no database publication. Its driver accepts explicit locator overrides and is copied into the fresh reproduction directory by the portable preparer, so running it does not overwrite preserved receipts. `lint.log` retains the initial test-JSDoc failure, while `lint-final.log` records the successful follow-up; the runtime source did not change.

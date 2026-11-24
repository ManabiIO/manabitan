# JMdict and Jitendex compression-level component study

## Published proof

`complete-component-proof.tar.xz` contains the complete compact proof. Its tar
payload is byte-identical to the originally verified gzip archive; only the
lossless transport compression differs. `archive.json` records both archive
hashes and the common decompressed-tar hash. All 218 members and all observations
are unchanged.

From a checkout containing this directory, the analysis can be reproduced
without the excluded derived corpus files:

```sh
manabitan_proof_dir="$(mktemp -d)"
tar -xJf dev/perf/import-critical-path-20261124/compression-level-study/complete-component-proof.tar.xz -C "$manabitan_proof_dir"
python3 "$manabitan_proof_dir/harness/analyze.py" \
  "$manabitan_proof_dir/cohort-1" "$manabitan_proof_dir/recomputed-analysis.json"
```

The original portable-analysis receipt is retained in `portable-analysis.json`.

## Decision

Retain the existing trained-dictionary level −1. This fixed study does not establish a useful shared speed/size tradeoff for changing the default. It completed all 64 measured observations and 128 excluded warmup passes, with no retries, omitted tails, added samples or product changes.

Both locked titles use the JMdict-trained dictionary at level −1. Changing generic level 1 would not activate for either fixture. [Current dispatch](https://github.com/ManabiIO/manabitan/blob/bbccabd520972cc351a65d9f545bd5369b6e9747/ext/js/dictionary/zstd-term-content.js) resolves both names to the same trained dictionary. [PR #771's source audit](https://github.com/ManabiIO/manabitan/blob/aa09b85cbc43c8c9c05a3e7f1d1b7c53f41712a4/dev/perf/import-experiments-20260914.md#compression-follow-up-prepared-dictionary-reuse) examined ordinary prepared-dictionary reuse thresholds; it did not measure compression levels or establish a latency/size frontier.

## Exact corpus and measured boundary

The unchanged product base is `bbccabd520972cc351a65d9f545bd5369b6e9747`. Untimed capture runs its actual native parser, global canonical deduplication, block planner, Zstd wrapper, native integrity envelope and block-reference reader. A memory-backed file adapter preserves physical offsets and reads; reservation scheduling and record writes are disabled because neither belongs to the component measurement. All ZIP hashes/CRCs, source rows and decoded block bytes are checked.

Every captured aggregate matches the independent full-browser baseline inventory, including unique contents, pending/persisted hits, pre-dedup encoded bytes, content-file bytes, groups and written chunks. That browser comparison is an inventory comparison, not exhaustive byte comparison of browser-persisted blocks. Capture uses the production database's **1 MiB block target**, not the standalone block store's 4 MiB default.

| Corpus   |    Rows | Groups | Global unique contents | Compression blocks | Raw block bytes | Compressed bytes with envelopes | Fixed reference bytes | Content-file bytes |
| -------- | ------: | -----: | ---------------------: | -----------------: | --------------: | ------------------------------: | --------------------: | -----------------: |
| JMdict   | 528,299 |     12 |                362,032 |                103 |     100,300,626 |                      12,326,040 |             7,240,640 |         19,566,680 |
| Jitendex | 436,555 |     22 |                363,243 |                385 |     389,687,485 |                      31,121,935 |             7,264,860 |         38,386,795 |

Each arm runs a fresh Node 22.22.0 child. It loads the same complete raw blocks, runs two excluded full-corpus warmups, then one measured pass. A and D both use −1; B uses −2; C uses −3. Eight four-arm blocks use `ABCD, BDAC, CADB, DCBA, DCBA, CADB, BDAC, ABCD`. Corpora remain separate.

The timer includes each existing `compressUsingDictWithPrefix` call: retained-buffer input/dictionary copies, native compression, native envelope checksum and owned output copy. Every per-block duration and complete-loop duration is retained. It excludes source gathering, worker transport, deduplication, persistence, initialization, I/O, hashing, decompression and explicit forced-GC calls. Automatic GC can occur inside a timed call and remains included; the frozen plan's shorter wording about excluding GC refers only to the explicit calls. This is a serial component comparison, not an import benchmark or a prediction of browser completion time.

Outside every warmup and measured timer, all blocks pass exact decompression and envelope checks. Level −1 outputs must match the originally captured production frames exactly. Every repeated output at each level must remain byte-identical. The retained corpus has all 488 raw blocks and one complete compressed output set per level; repeated observations record every verified output hash and size.

## Component results

Negative changes mean faster. Each comparison uses the eight paired full-corpus component times; controls are not subtracted. All observations and tails remain.

| Corpus / level | Paired median vs A | Paired median vs D | Equal-work vs A | Equal-work vs D | Faster pairs vs A / D |
| -------------- | -----------------: | -----------------: | --------------: | --------------: | --------------------: |
| JMdict −2      |             −1.71% |             −0.62% |          −0.47% |          +0.86% |              6/8, 5/8 |
| JMdict −3      |             −5.46% |             −4.83% |          −5.62% |          −4.36% |              6/8, 7/8 |
| Jitendex −2    |             +3.52% |             −6.27% |          +1.77% |          +3.24% |              3/8, 5/8 |
| Jitendex −3    |            +10.14% |             −0.80% |         +18.55% |         +20.27% |              4/8, 4/8 |

Same-source D/A paired medians are −0.065% for JMdict and −0.770% for Jitendex, with substantial retained variation: JMdict ranges from −17.10% to +36.52%, and Jitendex from −17.14% to +17.44%. Quiet local coordination cannot remove shared-host variability. The results do not justify treating small candidate medians as reliable wins.

JMdict arm medians are 161.92 / 159.36 / 154.56 / 162.40 ms for A/B/C/D; the −3 component saving is approximately 8 ms at these medians. Jitendex arm medians are 469.72 / 488.43 / 534.11 / 486.34 ms. These separate arm medians are descriptive and do not replace paired comparisons.

## Exact storage tradeoff

Content-file totals add the unchanged production reference bytes to the measured compressed frames and their envelopes. They are not whole-dictionary database or ZIP sizes.

| Corpus / level | Compressed bytes with envelopes | Content-file bytes | Added bytes | Content-file increase |
| -------------- | ------------------------------: | -----------------: | ----------: | --------------------: |
| JMdict −1      |                      12,326,040 |         19,566,680 |           0 |                    0% |
| JMdict −2      |                      12,638,444 |         19,879,084 |     312,404 |                1.597% |
| JMdict −3      |                      13,100,410 |         20,341,050 |     774,370 |                3.958% |
| Jitendex −1    |                      31,121,935 |         38,386,795 |           0 |                    0% |
| Jitendex −2    |                      31,871,953 |         39,136,813 |     750,018 |                1.954% |
| Jitendex −3    |                      33,995,568 |         41,260,428 |   2,873,633 |                7.486% |

Level −2 fits a 2% content-file budget in both corpora but has no dependable speed benefit here. Level −3 exceeds even a 5% Jitendex content-file budget and does not improve that corpus's component result. Neither supports changing the common default.

## Retained evidence and reproduction

Frozen plan SHA-256: `8ea0e039aa7e09328d1b1dd39ec73659ef8e36f76d9f7754cd8d60387881acf5`.

The evidence directory is `/workspace/scratch/ad5d54ac9137/evidence-20261124/compression-level-study`. `capture-attempt-2` contains the complete raw blocks, original −1 frames and production inventories; `cohort-1` contains the fixed plan, all 64 process receipts, 192 complete pass results, all per-block timings, three complete output sets and the analysis. `capture-attempt-1` and its log preserve the incomplete first capture, which stopped because the memory adapter lacked a batched-read method. That was fixed before the final capture and before any timing. A plan-construction attempt also stopped before writing its plan because the executor did not expose `cpu.max`; the final plan records that unavailable field.

Recompute the analysis without rerunning compression:

```sh
python3 dev/perf/compression-level-study-20261124/analyze.py \
  /workspace/scratch/ad5d54ac9137/evidence-20261124/compression-level-study/cohort-1 \
  /workspace/scratch/ad5d54ac9137/evidence-20261124/compression-level-study/cohort-1/recomputed-analysis.json
```

The analyzer requires an unused output path and rejects incomplete schedules, changed plan identities, unequal output hashes or missing parity. New measurements require a new plan and output directory; do not append observations to this cohort.

### Compact proof and reproducible corpus exclusions

The compact proof retains the frozen plan, every command/stdout/stderr and observation JSON, all per-block warmup and measured timings/hashes/sizes, complete capture inventories, both setup-attempt logs, independent audit, exact capture/runner source, analyzer and regeneration helper. `excluded-corpus-manifest.json` records the path, byte size and SHA-256 of every excluded derived raw/compressed file, including the incomplete first capture. Those derived bytes remain locally preserved and are deliberately excluded from the Git proof bundle.

To regenerate the complete successful corpus, check out exact product commit `bbccabd520972cc351a65d9f545bd5369b6e9747`, install the pinned dependencies/build the packaged libraries, and copy the retained harness into `dev/perf/compression-level-study-20261124/`. Use Node 22.22.0 and the locked JMdict/Jitendex archives identified by the retained fixture manifest. All packaged source/WASM/dictionary hashes are checked before output regeneration.

```sh
node dev/perf/compression-level-study-20261124/capture.mjs \
  /path/to/locked-dictionary-cache /path/to/regenerated-capture jmdict jitendex
node dev/perf/compression-level-study-20261124/regenerate-corpus.mjs \
  /path/to/extracted-proof/cohort-1/plan.json \
  /path/to/extracted-proof/excluded-corpus-manifest.json \
  /path/to/regenerated-capture /path/to/regenerated-outputs
```

The second command checks every regenerated raw block and all 1,464 compressed outputs against the original byte manifest and verifies exact decompression. It does not measure performance. Passing `--verify-only` as the output argument performs all checks without writing another copy. Capture timing fields naturally differ on regeneration; source block bytes, boundaries, canonical counts and compressed outputs must match the retained proof. The original source dictionaries remain externally pinned inputs, not files copied into the proof bundle.

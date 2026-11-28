# VNDB media staging qualification

This evidence separates the existing direct-index implementation in [#909](https://github.com/ManabiIO/manabitan/pull/909) from the additional path-array removal in [#943](https://github.com/ManabiIO/manabitan/pull/943). It uses the pinned VNDB archive and production media functions on the current runtime base.

The new followup saves **1,364,384–1,374,832 bytes** of retained heap plus external-memory staging in two ordered comparisons against #909 alone. This is a component allocation result at a fixed boundary before any media payload is read. It is not a measurement of browser peak memory or end-to-end import speed.

## Variants and source identity

| Variant | Measured local source | Tree | Published equivalent |
| --- | --- | --- | --- |
| Runtime baseline for complete parity | `0143e9596cd8f790d5e166d4ba6a2425fbc57f14` | `004fa8fde0055379ffbf22f9bbb60ae50f99114a` | Same source |
| Allocation baseline | `4efc41a8f516abf637777c6a23d6b7b3dd8cebd7` | `16db1f4ad5f3f9d6469fd4cf0a2beb2bb261b583` | Runtime files identical to the baseline above |
| Current baseline plus existing #909 | `d2d97a39d163f0455afe127a7c313e2de330fe75` | `c9959c5ef03fc895f7a9d7a3595becc777449e9a` | `7f3a01b469bef3ec3de7764a3913d305afbdbc1d` |
| Current baseline plus #909 and #943 | `ed88750ee57a416e13bb801af4ed7a2b6ed95c6b` | `066c5df06005bcfa457295d424c311b1883f174c` | `e18ea0cdf750b85d57652707b0f165374a994d44` |

The allocation baseline worktree received the receipt-policy correction while these tasks were running. Its only changes from `0143e959` are `dev/perf/benchmark-support.js` and `test/perf-experiment-receipts.test.js`; neither is imported by the component probe. A Git diff confirmed no dictionary runtime or WASM difference. The raw observations preserve the actual allocation source SHA rather than relabeling it.

The qualified implementation of the narrow stacked #943 was published at source `e1266a28c73b5178aa1657289eef0cd79a2ba067`, tree `411518531ddd1ca403928ee379f121d163504a91`, and parent `477353ff8e4d99fafd9224392bb0b26055745378` from #909. Its only changed files are the generation media store and writer test. The current-base qualification branch additionally includes the clean replay of #909. Subsequent test-only style commits (`55e30d0c` stacked and `2ea2ee2c` current-base) change no runtime bytes; their identities are recorded separately.

`provenance.json.txt` records complete identities and hashes of the production files used by each variant. The checked-in WASM SHA-256 is `b97009b54ae1056efba84964dc6f20e334cd27f47b793a5028e66d9482cb6cfa` for every media variant.

## Allocation protocol and observations

`allocation-cohort.py` executed one fixed sequence of six fresh Node v24.22.3 processes: baseline, parent, followup, followup, parent, baseline. Each child ran `replay.mjs` with `--expose-gc`, loaded the same ZIP catalog and media file list, and took its initial memory snapshot after two explicit garbage collections. The first production payload read was intercepted; two further garbage collections preceded the retained snapshot. A private sentinel then ended the probe before any media payload read. All six attempts completed successfully, with no replacement samples.

The metric below is the within-process change in `heapUsed + external` between those two snapshots. `arrayBuffers` is recorded separately and is not added again because it is included in `external`. The candidate rows include the upfront dense index and ID buffers; the baseline row includes its original record staging. This boundary does not measure the complete later lifetime or peak of either implementation.

| Arm | Forward staging delta, bytes | Reverse staging delta, bytes |
| --- | ---: | ---: |
| Current runtime baseline | 20,176,056 | 20,174,920 |
| Existing #909 only | 5,952,800 | 5,957,104 |
| Existing #909 plus new #943 | 4,588,416 | 4,582,272 |

| Comparison | Forward saving, bytes | Reverse saving, bytes |
| --- | ---: | ---: |
| Existing #909 versus baseline | 14,223,256 | 14,217,816 |
| New #943 versus existing #909 | 1,364,384 | 1,374,832 |
| Combined changes versus baseline | 15,587,640 | 15,592,648 |

#943 removes the retained array of complete media path references. Writes validate a primitive string using the already validated namespace and canonical numeric ID. The guard preserves rejection of boxed strings and other foreign values without coercion. The numeric parser requires the exact positive decimal spelling, so aliases such as leading zeros, signs, exponents, or a different suffix do not acquire the same accepted identity. Existing #909 contributes the larger separate saving by avoiding the old per-image records and associated staging.

The new validation does additional path parsing during writes. This package makes no throughput claim about that tradeoff. The raw parity `prepareMs` values are retained for transparency but are **not comparable timing evidence**: those correctness runs overlapped other validation and host/I/O contention.

## Complete byte and image verification

The fixture is `vndb_characters_by_bee.zip`, 291,705,969 bytes, SHA-256 `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`.

The pristine runtime baseline and the current-base combined candidate both produced:

| Output | Verified result |
| --- | --- |
| ZIP directory entries | 147,237 |
| Images | 146,570 |
| Decoded image bytes | 188,131,284 |
| Packed source span | 195,649,882 bytes, beginning at source offset 86,882,547 |
| Physical reads | 144, totaling 195,649,882 bytes |
| Dense index | 163,034 slots, 16,464 holes, 3,912,816 bytes |
| Index SHA-256 | `a385fd324da2f40f1f414f5db4c1ffe4f624076fce240eee8ccbb3426cf3aca5` |
| Packed span SHA-256 | `02ea178832f43bb1ef0ff6d97c1f9b8aebe2be100842f862303e0aa943d13ecc` |
| Path-and-content stream SHA-256 | `8e059c7593f23b9827c15df54f58c714b898fe5652d3ae756acd2fb4866b460a` |

The JavaScript probe compared the complete packed Blob to the original ZIP slice and retained each complete binary index for the oracle. `verify-source.py` independently required byte-for-byte equality of those two indexes, validated every occupied and empty index row's identity and checksum, then decoded every indexed payload directly from the pinned ZIP. Each decoded byte string matched Python's ZIP reader, source CRC, and expected length. This covered 146,569 stored images and one deflated image. All occupied slots were visited exactly once.

The binary indexes and packed media are intentionally omitted from this small evidence commit. Their hashes and the complete successful verification record are preserved. Both indexes can be regenerated with the commands below; no packed media copy is needed.

## Validation attempts and limitations

The new writer suite passed all 69 tests. A broader four-suite run passed 188 tests and hit the unchanged 15-second timeout on one rotated-input parity test during concurrent full-media verification. Running only that case under the same timeout passed in 3.93 seconds. The original failure and successful isolated result are both retained; together they cover all 189 distinct tests, without relabeling the broad run as an uninterrupted pass.

Earlier setup attempts encountered missing generated libraries. A Node22 test attempt and parity startup were interrupted without assertion or timing results. The later scoped lint process was killed with exit 137; no lint success is claimed and the chained type-check did not start. `attempts.json.txt` lists these attempts and identifies which initial tool-transcript outcomes do not have a file log. The available failure, timeout, and successful retry logs are included unchanged.

Hosted JavaScript lint initially reported two test-only style errors in #943. Both were fixed (explicit `new Object` and parentheses around a conditional arrow), and scoped repository ESLint then passed with exit 0. The full hosted failure log and focused successful log are retained. No runtime file changed, so the measured candidate remains the same.

These component checks do not replace the runtime PR's normal unit/build/type checks or hosted complete-import and restart checks. Local browser startup was blocked before page execution by the environment's socket restriction. No local browser memory or import-latency observation is claimed here.

## Reproduction

Use Node v24.22.3 for this component cohort and the pinned fixture above. Prepare three separate worktrees named `bench-baseline`, `media-parent`, and `media-work` under one workspace. Use the measured local commits when available, or their published equivalents listed above. For the allocation baseline, public `0143e959` has exactly the same component runtime files as measured `4efc41a8`. Raw regenerated source identities will reflect the selected equivalent commit.

Install the repository dependencies and build the normal generated libraries. Sharing the unchanged dependencies and generated libraries between these media worktrees is sufficient. Copy this directory's unchanged `replay.mjs` to `media-evidence/replay.mjs` under that workspace, which is the fixed runner location used by the executed cohort script. Use new output paths; probes deliberately refuse to overwrite result files.

```sh
probe_workspace=/absolute/path/to/workspace
evidence_dir=/absolute/path/to/this/media/directory
vndb_archive=/absolute/path/to/vndb_characters_by_bee.zip
probe_output=/absolute/path/to/new-output-directory
mkdir -p "$probe_output" "$probe_workspace/media-evidence"
cp "$evidence_dir/replay.mjs" "$probe_workspace/media-evidence/replay.mjs"

node --expose-gc "$evidence_dir/replay.mjs" \
  "$probe_workspace/bench-baseline" "$vndb_archive" baseline \
  "$probe_output/baseline.json.txt" parity
node --expose-gc "$evidence_dir/replay.mjs" \
  "$probe_workspace/media-work" "$vndb_archive" candidate \
  "$probe_output/candidate.json.txt" parity
python "$evidence_dir/verify-source.py" \
  --archive "$vndb_archive" \
  --baseline "$probe_output/baseline.json.txt" \
  --candidate "$probe_output/candidate.json.txt" \
  --output "$probe_output/source-verification.json.txt"

python "$evidence_dir/allocation-cohort.py" \
  --workspace "$probe_workspace" \
  --archive "$vndb_archive" \
  --output "$probe_output/allocation-cohort"
```

The exact executed probe and oracle scripts are included unchanged. Raw JSON files have a `.json.txt` extension for repository artifact conventions; their contents are unchanged. `artifact-hashes.json.txt` contains SHA-256 hashes of every included artifact except itself, plus both omitted binary indexes.

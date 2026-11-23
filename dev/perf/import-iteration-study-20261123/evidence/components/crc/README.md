# CRC component experiment: unqualified locally

Both original screens are preserved, including every observation in its original JSON and JSONL order. The 64 MiB-per-observation screen had coarse thread CPU accounting. The single longer, fixed 1 GiB-per-observation screen still had noisy A/A controls and mixed aggregate JMdict work: its summed equal-work CPU change was +7.57%, despite a negative median paired change. These local results do not qualify a production speed claim. The independent browser comparison is separate evidence.

Both screens check CRCs over resident first/middle/last term banks from each pinned archive, with alignments 0, 1 and 3. Each has eight alternating pairs per corpus for both A/A and A/B comparisons, 96 observations total. Archive I/O, inflation, allocation, copies, compilation, and warmups are excluded from timing. All CRC values matched the pinned archive CRCs.

## Original evidence

- `crc-screen.mjs`, `crc-screen-long.mjs`, and `prepare-crc-screen.py` are unchanged original files.
- `crc-words-screen/` contains both JSON/JSONL screens, the original `inputs.json`, the exact measured `candidate.patch`, module/function identity records, committed identities, and the final local qualification decision.
- `hotspot-provenance/` documents the earlier baseline name-map diagnostic. Its module differed only by an appended Wasm name section and helped identify `crc32_bytes` in browser profiles. These records describe a diagnostic baseline module, not the CRC candidate or an additional timing arm.

The measurement originally used an uncommitted candidate against `5e1f8c12f7ff798ba407323aff675cb23b22af02`, so `inputs.json` correctly retains that HEAD for both arms. Its source hashes and patch SHA-256 identify the candidate. The later local commit `520ce235948da06ebc99fa5d67772ae5614f779c` and published commit `930083af581bd4d8fe8dc42fe7e443e57666f8f9` contain the frozen candidate; `committed-identities.json` and `qualification-status.json` supply that mapping.

The candidate patch SHA-256 is `7ed6e56ede369278f8c5c9a67550838b7cbe4fc33688773c36a60204f8397074`. Only product function body 2 changed; the identity receipts report all other product function bodies and non-code sections unchanged. The test-only export's CRC body matches the product body exactly in both arms.

## Reproduction

Use Node **22.22.0**, Python 3, and **clang/LLD 21.1.8**. Original compiler and linker versions and complete argv lists are in `crc-words-screen/inputs.json`; the original local toolchain environment was `/workspace/scratch/f34c9c9fae89/toolchains/llvm21-env.sh`. Any installation paths are supported by the portable preparer, which rejects a rebuilt module whose hash differs.

Prepare separate source checkouts at:

| Arm | Commit |
| --- | --- |
| Baseline | `5e1f8c12f7ff798ba407323aff675cb23b22af02` |
| Candidate | `930083af581bd4d8fe8dc42fe7e443e57666f8f9` |

Place the three pinned archives named `JMdict.zip`, `jitendex-yomitan.zip`, and `vndb_characters_by_bee.zip` in one directory. Their exact hashes and selected bank names are in the original `inputs.json`; do not substitute newer releases. Then run:

```sh
evidence=/absolute/path/to/round2-component-evidence
baseline=/absolute/path/to/baseline-checkout
candidate=/absolute/path/to/crc-candidate-checkout
archives=/absolute/path/to/pinned-archives
crc_output=/absolute/path/to/new-crc-reproduction-directory
clang=/absolute/path/to/clang-21
linker=/absolute/path/to/wasm-ld-21

python3 "$evidence/crc/prepare-reproduction.py" \
    --baseline "$baseline" --candidate "$candidate" \
    --archives "$archives" --clang "$clang" --linker "$linker" \
    --output "$crc_output"

node --expose-gc "$evidence/crc/crc-screen.mjs" \
    "$crc_output/inputs.reproduced.json" "$crc_output/screen-1.json"
node --expose-gc "$evidence/crc/crc-screen-long.mjs" \
    "$crc_output/inputs.reproduced.json" "$crc_output/screen-long-1.json"
```

The preparer only relocates paths in a new copy of the original inputs. It verifies source, product artifact, compiler-produced test module, archive, and bank identities against the preserved receipt. It never changes the source checkouts or original evidence. Both screen runners are unmodified and require fresh result paths. The long runner's `previousScreen` string records the original campaign's path as metadata; it does not read that path.

Generated test modules and extracted `.bin` banks are omitted because the recorded source/flags/archive identities regenerate them exactly and their hashes are checked. The baseline name-map module is also omitted; it is unnecessary for reproducing either CRC screen. Reproducing timing requires an otherwise idle host and does not change the original unqualified local decision.

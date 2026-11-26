# Native token import correctness evidence

The complete locked corpus replay passed for both native candidates against
`develop@0143e9596cd8f790d5e166d4ba6a2425fbc57f14`. All three arms produced
identical key plans, numeric columns, encoded content and hashes, prepared
lookup-index bytes, and projected media paths and diagnostics.

| Corpus   | Banks | Rows per arm | Groups | Projected media rows | Unique projected paths |
| -------- | ----: | -----------: | -----: | -------------------: | ---------------------: |
| JMdict   |    53 |      528,299 |     12 |                    0 |                      0 |
| Jitendex |   219 |      436,555 |     22 |                  324 |                    236 |
| VNDB     |   665 |    6,648,310 |    170 |              146,725 |                146,570 |
| Total    |   937 |    7,613,164 |    204 |              147,049 |                146,806 |

Jitendex additionally retains 15 ordinary media rows; all 339 media-bearing
group representatives match. VNDB's default parser policy takes 26 fused
fallbacks in each arm. No fallback count or content-capacity value changed.

The maximum reused WASM capacities agree in every group: 41,680,896 bytes for
JMdict, then 76,218,368 bytes for Jitendex and VNDB. Instances are reused across
corpora. These are native linear-memory capacities, not standalone dictionary
peaks or browser memory measurements. The mixed three-arm process reached
576,204 KiB maximum RSS; it supplies no per-candidate memory comparison.

## Sources and evidence

The empty-string scanner candidate is [PR #951](https://github.com/ManabiIO/manabitan/pull/951),
runtime head `8c32e0e4d9ad61a1dafd324efa717f2680ba31db`. The literal-content
capacity preflight is [PR #958](https://github.com/ManabiIO/manabitan/pull/958),
runtime head `e5dffc2889f814eec7231ed37ab46cfe7c9ae61b`. These separately frozen
source snapshots were tested independently; this replay does not test their
composed binary. Performance decisions remain separate from this correctness result.

- [Compact audit](summary.json.txt) and [portable source provenance](provenance.json)
- [Full raw evidence archive](raw-evidence.tar.gz): every group, execution log,
  exact runner, independent source review, frozen C patches, WASM and manifests
- [Checksums of published files](SHA256SUMS) and [raw archive member checksums](RAW_SHA256SUMS)

The runner checks each archive's locked SHA-256 and length, ZIP decoded lengths
and CRCs, and source identity again after the replay. JavaScript sources are
identical across the arms. It models the production byte balancing with an
explicit three-worker policy, then executes groups sequentially. Browser
scheduling, persistence, decoded media payload readback, complete-import time
and browser peak memory remain outside this replay.

JSON receipts use `.json.txt` to preserve the exact recorded bytes through
repository formatting. The archive preserves both frozen candidates exactly as tested. All member hashes match the original
uncompressed evidence retained outside this publication directory.

## Reproduction

Run from a checkout containing this evidence. Use Node `^22.22.0` or `>=24.8.0`; the
recorded run used Node 24.22.3. Populate a cache from the exact URLs and hashes
in `test/perf/dictionaries.lock.json`. The command below requires a new report
path and fails rather than replacing an existing report.

```sh
evidence_dir="$PWD/dev/perf/native-token-import-20261126-1e61"
tar -xzf "$evidence_dir/raw-evidence.tar.gz" -C "$evidence_dir"
git worktree add --detach ../parity-baseline 0143e9596cd8f790d5e166d4ba6a2425fbc57f14
git worktree add --detach ../parity-preflight 0143e9596cd8f790d5e166d4ba6a2425fbc57f14
git worktree add --detach ../parity-empty-string 0143e9596cd8f790d5e166d4ba6a2425fbc57f14
git -C ../parity-preflight apply "$evidence_dir/raw/preflight.c.patch.txt"
git -C ../parity-empty-string apply "$evidence_dir/raw/empty_string.c.patch.txt"
cp "$evidence_dir/raw/preflight.wasm" ../parity-preflight/dev/data/dictionary-wasm/term-bank-parser.wasm
cp "$evidence_dir/raw/preflight.manifest.json" ../parity-preflight/dev/data/dictionary-wasm/manifest.json
cp "$evidence_dir/raw/empty_string.wasm" ../parity-empty-string/dev/data/dictionary-wasm/term-bank-parser.wasm
cp "$evidence_dir/raw/empty_string.manifest.json" ../parity-empty-string/dev/data/dictionary-wasm/manifest.json
npm ci
npm ci --prefix ../parity-baseline
npm ci --prefix ../parity-preflight
npm ci --prefix ../parity-empty-string
cp "$evidence_dir/raw/replay.mjs.txt" "$evidence_dir/replay.mjs"
node --expose-gc "$evidence_dir/replay.mjs" \
  --baseline-root ../parity-baseline \
  --candidate-root preflight=../parity-preflight \
  --candidate-root empty_string=../parity-empty-string \
  --cache-dir /path/to/e2e-dictionary-cache \
  --parser-workers 3 --out /path/to/new-parity-report.json
```

To independently reproduce each binary from its applied source patch, use
Clang and LLD 21.1.8 with `npm run build:dictionary-wasm -- --check` in that
worktree. Set `MANABITAN_CLANG` and `MANABITAN_WASM_LD` to the corresponding
executables when the default `clang-21` and `wasm-ld-21` names are unavailable.

## Component performance and browser checks

[The complete timing summary](TIMING.md) retains both empty-string screens and
both content-preflight screens. Neither candidate has a qualified import-speed
improvement. Identical-code controls vary too widely, including when source
and output arenas are preallocated. The
[timing archive](native-import-components-20261126.zip) preserves all original
observations, exact runners, setup failures and slower outliers. Its
[member inventory](TIMING_MANIFEST.json.txt) and
[packaging receipt](TIMING_RECEIPT.json.txt) are also available directly.

Local browser attempts produced no measured import result; their original logs
are retained in [the setup archive](local-browser-setup.zip). Hosted validation
for the unchanged PR #951 runtime subsequently passed the all-target build,
main/test TypeScript, full Chromium and Firefox extension imports, and
Chromium restart/interruption recovery. These functional checks are not a
controlled browser performance comparison.

- [PR #951 CI](https://github.com/ManabiIO/manabitan/actions/runs/45862556658)
- [PR #951 restart/interruption](https://github.com/ManabiIO/manabitan/actions/runs/45862556761)

The candidates are separate source snapshots. Taking both requires regenerating
the combined parser WASM and manifest with the pinned toolchain, then testing
that combined artifact. This evidence does not qualify a combined runtime.

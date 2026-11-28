# WebAssembly Zstd match counting screen

This harness compares the shipped codec with a candidate compiled from the same
pinned Zstd source and Emscripten toolchain. It is a codec component screen. It
neither models the complete import pipeline nor qualifies browser memory use.

The SIMD candidate changes `ZSTD_count` on WebAssembly SIMD targets. It compares
16 bytes per iteration, finds the first differing byte with a lane mask, and
handles the remaining 8, 4, 2, or 1 bytes without reading past the caller's match
length limit. The scalar implementation remains available for other targets.
Compression levels, dictionaries, frame format, and decoder code are unchanged.

## Reproduction

Install the repository dependencies, run `npm run build:libs`, and provide the
three archives pinned by `test/perf/dictionaries.lock.json` in
`builds/e2e-dictionary-cache`. The harness verifies their SHA-256 digests and full
term-row counts. Preserve the baseline WASM before replacing the asset, or extract
it from the pinned baseline commit:

```sh
mkdir -p builds/zstd-match-count
git show 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2:dev/data/zstd-simd.wasm > builds/zstd-match-count/baseline.wasm
node test/perf/zstd-match-count-20261127/screen.mjs jmdict jitendex vndb \
  --baseline-js dev/lib/zstd-simd-module.js \
  --baseline-wasm builds/zstd-match-count/baseline.wasm \
  --candidate-js dev/lib/zstd-simd-module.js \
  --candidate-wasm dev/data/zstd-simd.wasm \
  --pairs 12 \
  --out builds/zstd-match-count/result.json
```

The generated JavaScript is unchanged between the two builds. Each arm still
instantiates its own WASM module, compression context, decoder, and buffers. Use
`--fuzz-only` to run the boundary checks without downloading archives. CLI options
also allow selecting another parser asset, cache directory, or generated module.

## Checks and timing scope

The boundary screen checks 3,072 deterministic combinations of input patterns,
lengths, source alignments, dictionary selection, and compression levels. Both
arms must produce identical compressed frames and integrity envelopes, and both
must decode back to the input. Another 1,652 destination-capacity checks compare
success/error results and use trailing canaries to detect output overruns.

The corpus screen parses all canonical term rows. It omits repeated content
offsets within each parser group and packs record-aligned blocks of at most
4 MiB. JMdict uses groups of seven banks, Jitendex ten, and VNDB four. This grouping
does not reproduce the importer’s global content deduplication or exact production
block plan. The JSON receipt records row counts, input/output hashes, byte counts,
module and fixture hashes, and maximum linear-memory sizes.

Every block receives two warmup calls per arm. Measured pairs alternate AB/BA
order. The timed region contains only compression; parsing, copies, envelope
writing, equality checks, and decompression are outside it. Both wall time and
process CPU time are retained. Node flags are recorded, including any experimental
flags used to study JIT tiering. Process CPU includes background runtime work and
is not a replacement for controlled browser timing.

The local environment showed substantial variation even for identical A/A builds.
Its timings are screening evidence only. Promotion requires paired full-import
browser measurements on the pinned dictionaries, including lookup/reopen and
storage checks.

## Build identity

The unpatched control rebuild reproduced the shipped JavaScript and WASM exactly.
The candidate uses the same compiler, flags, exports, source pin, and envelope
helper; the source patch is applied before Zstd amalgamation.

| Asset                           |   Bytes | SHA-256                                                            |
| ------------------------------- | ------: | ------------------------------------------------------------------ |
| Baseline WASM                   | 433,631 | `ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc` |
| SIMD candidate WASM             | 428,172 | `60319137e8014265d975e493c1fbc1d24a9aa8a773a401f5cb072e4a3a74fb7a` |
| Generated JavaScript, both arms |   9,046 | `9ec18a2a02698c24e797882ffcee1ef8d97dd7b00e5fa58aa5a0365c7234fe48` |

The candidate is 5,459 bytes smaller. See `dev/data/zstd-wasm.PROVENANCE.md` for
source and toolchain details. Smaller code size is not evidence of an import-time
improvement.

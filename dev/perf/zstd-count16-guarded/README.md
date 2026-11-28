# Guarded wasm32 match-count verification

This package verifies a new product candidate without running a component timing
cohort. The production recipe applies `dev/data/zstd-wasm32-count.patch` to pinned
Zstd commit `82d322c4973d9e2968d94047a40892bc6d9a9bdf` before amalgamation. The patch
uses 16-byte SIMD comparisons with an 8/4/2/1-byte remainder only when both
`__wasm32__` and `__wasm_simd128__` are defined. Other targets retain the original
scalar function body.

The candidate retains the compiler, exports, JavaScript glue, dictionary,
compression levels, block size, envelope, and wrapper from the product baseline.
Its complete production build must reproduce the already staged asset exactly.

| Artifact                       | SHA256                                                             |   Bytes |
| ------------------------------ | ------------------------------------------------------------------ | ------: |
| Baseline WASM                  | `ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc` | 433,631 |
| Guarded candidate WASM         | `13890c7e75e7a2ff5fa00bd65f1e518e15f545da85154719be6a2eaa2a773a22` | 433,757 |
| Unchanged generated JavaScript | `9ec18a2a02698c24e797882ffcee1ef8d97dd7b00e5fa58aa5a0365c7234fe48` |       — |

## Why this is a new candidate

The earlier `wasm-word-width-v2` count16 experiment omitted an early return for a
reversed input limit. Its actual-corpus and ordinary fuzz cases passed, but that
coverage did not exercise all internal caller contracts. The external
[count128 source audit and guarded patch](https://github.com/ManabiIO/manabitan/blob/ede7e7a6b92e2c752ac631a503231a5a8aa62d3e/dev/perf/zstd-count128-20261128/zstd-count128.patch)
identified this boundary. Independent local reviews confirmed it against the
pinned `zstd_lazy.c`, `zstd_opt.c`, and `ZSTD_count_2segments` source.

Dictionary tree searches can add a cached common length before the two-segment
helper calculates its virtual limit. If the match position is already past the
dictionary end, that virtual limit precedes the current input. The upstream
scalar function returns zero without a load. Converting the negative remaining
length to unsigned before checking it can instead allow a wide read.

The new candidate adds exactly `if (pIn > pInLimit) return 0;` before unsigned
length arithmetic. Removing that line reconstructs the exact previous header.
All old source, timing, and parity receipts remain separate. Those exploratory
timings do **not** qualify this new binary; complete-import qualification must
use its new exact commit and hash. The old smaller-module observation also does
not carry over: this candidate is 126 bytes larger than the baseline.

## Inputs and invocation

Use Node 24.22.3 for this correctness job. Browser timing remains a separate job
with its own pinned environment. Python 3, Git, and `tar`/`xz` are required. The
entry point downloads and checks the exact Emscripten 5.0.1 archive recorded in
`manifest.json`; it never installs an unpinned current release.

Use three separate inputs:

- A baseline checkout at `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
- A product candidate checkout containing the patch, production build-recipe
  change, and the exact guarded WASM asset.
- The already captured JMdict source artifact 15245899188. The entry point checks
  its report SHA256 and every compressed group file before use.

Run the verifier from the tooling checkout, which also retains the frozen v2
parity helpers:

```sh
python3 dev/perf/zstd-count16-guarded/verify.py \
  /path/to/baseline /path/to/candidate /path/to/capture /path/to/new-output
```

The output directory must be new. The product and tooling checkouts may be
different directories; the frozen parity helpers resolve from the tooling
checkout, while the build recipe and product assets resolve from the candidate.

An already verified local SDK can be reused by setting
`MANABITAN_EMSCRIPTEN_UPSTREAM` to its `upstream` directory. This override is
recorded in the receipt and still requires the exact compiler version and
revision. The CI job should use the default hash-checked archive acquisition.

The existing immutable artifact downloader can obtain the capture with
`actions: read` permission and the workflow token in `GITHUB_TOKEN`:

```sh
node dev/perf/wasm-word-width-v2/fetch-capture.mjs \
  ManabiIO/manabitan /path/to/new-capture /path/to/capture-receipt.json
```

## Checks

The verifier first runs the production `build-zstd-wasm.js --keepTemp` command in
verification mode. Its freshly fetched, patched source must reproduce the
candidate's checked-in WASM and unchanged JavaScript byte for byte. No source,
dictionary, wrapper, or compile-parameter substitution is permitted.

The direct probes compile `count-boundaries.c` against the **complete actual
upstream header**, in three separately identified states: baseline, preserved
invalid count16, and guarded count16. The source tree must have no tracked changes
outside that one header. The probes are not linked into the production module.

The direct harness covers:

- All short mismatch positions and all 16-by-16 input/match alignment pairs.
- Equal and reversed limits with either pointer at linear-memory end.
- An interior reversed span that exposes an incorrect old return value.
- Exact input and match heap-end tails, plus identical and overlapping pointers.
- Original two-segment continuation at dictionary and input boundaries.
- Cached common lengths extending past the dictionary end.

The fixed local run completed 885,455 cases. The baseline and guarded helper
agree; the preserved invalid helper produced 768 traps and one wrong result in
the dedicated reversed-limit cases. These are regression observations about the
superseded source, not accepted behavior of the new candidate.

The verifier then invokes only the frozen raw-corpus and wrapper **parity** modes:
651 exact compression and cross-decoder cases, 1,110 tight-capacity comparisons
with destination canaries, and 103 actual production 1 MiB wrapper blocks. Any
compressed-byte, success/error, canary, source-identity, or schedule mismatch
fails the correctness job. It never invokes the warm or cold timing modes.

## Evidence and scope

Retain `verification.json`, `boundary-result.json`, `raw-parity.json`,
`wrapper-parity.json`, `boundaries/build.json`, and the small probe WASM files.
Do not upload `sdk/` or `native-build/`: they are reproducible build intermediates.

These checks establish source binding and tested behavior. They do not establish
import latency, browser CPU, process memory, or cross-architecture performance.
The new candidate requires a prospective complete-import cohort. SIMD bitmask
cost can differ on ARM; an x86 result must not be described as an ARM performance
gain.

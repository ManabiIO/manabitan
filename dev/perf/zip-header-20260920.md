# Large ZIP header coalescing experiment

Source and CI context are tracked in the [Manabitan repository](https://github.com/ManabiIO/manabitan).

## Decision: keep this candidate draft, not a general performance promotion

This branch is stacked on the independent ZIP-read lifetime repair #68.
It changes only the large Blob/File raw-entry reader: read the bounded
local header and filename together, then read the owned payload. Normal
entries use two Blob reads instead of three. The prefix is capped at
65,565 bytes; unrelated extra fields are not read. Header, encryption,
method, filename and payload bounds remain checked before payload I/O.
Invalid central filename lengths use a header-only read before rejection.
Small Blob/ArrayBuffer paths and compressed-source budgets are unchanged.

Baseline commit: `a60ffa2b0a8e3b8421da170d404cc5da2c914402`.
Baseline source blob: `3166e4ab89f5550c56038fcb2d0cece2d293f0bf`.
Candidate source blob: `82cbf729cc65a27ab389e813f60b7e44980d5e7c`.
The candidate was measured separately before applying it to product source.

## Executed measurements and limits

This is a synthetic raw ZIP-reader stage measurement, NOT JMdict,
Jitendex, wty-en-en, G10, decompression, WASM, database write, whole import,
UI settling, peak memory or lookup qualification. Fixture data is
xorshift32 bytes in local ZIP records padded to a 129 MiB sparse file;
it is not term-bank JSON or a complete dictionary ZIP.

Node 22.16.0 and real Chromium 144.0.7559.96 File/Blob I/O on Linux x64,
Intel Xeon Platinum 8573C. Warm filesystem cache; explicit GC outside the
timed region. Fresh production reader per sample. Each workload has one
A and one B warmup, then six ABBA cycles (12 measured A and 12 B samples).
Node verifies SHA-256 of every payload; Chromium verifies every byte
against the fixture generator. Verification occurs after the timer stops.
No samples or outliers were removed.

Workloads: tiny-256 = 256 x 512-byte payloads, concurrency 3; medium-67 =
67 x 64 KiB, concurrency 3; large-67 = 67 x 1 MiB, concurrency 3;
medium-67-sequential = 67 x 64 KiB, concurrency 1.

Canonical elapsed-time changes, computed as (sum B / sum A - 1) x 100:

- tiny-256: Node -24.32%; Chromium -30.44%.
- medium-67: Node -19.24%; Chromium -32.01%.
- large-67: Node +35.72%; Chromium -10.74%.
- medium-67-sequential: Node -39.52%; Chromium -28.00%.

The Node large-payload result is a material regression. Five of its six
cycles were slower, so it cannot simply be dismissed as one outlier.
Chromium's large-payload case improved in five of six cycles. Earlier
exploratory sessions also favored Chromium but exposed substantial timing
variance. Neither those results nor pooling runs justifies hiding the
canonical regression or claiming a universal win.

All 576 measured samples from the two exploratory sessions and the
canonical session are retained in `zip-header-20260920-samples.csv`.
Each CSV row is one complete ABBA cycle, in original order, in milliseconds.
Exploratory harnesses ran Node and Chromium separately; the canonical
runner below generates fixtures, joins complete file writes, records
source blob hashes, runs both runtimes and persists a complete/incomplete
receipt. Compare sessions separately rather than treating them as a
single identically controlled trial.

## Reproduction

From this branch, with repository dependencies and Chromium installed:

```sh
node --expose-gc web/zip-header-benchmark.mjs --baseline-ref a60ffa2b0a8e3b8421da170d404cc5da2c914402 --output builds/zip-header-benchmark.json
```

`--runtime node` needs no npm packages. `--runtime chromium` uses
`@playwright/test`; `CHROMIUM_PATH` may select an installed browser.
`--baseline-file` and `--candidate-file` allow isolated source comparison.
`--rounds` defaults to six. Temporary fixtures are removed in finally.
The local run used the exact baseline/candidate blobs above through
`--baseline-file`, with an installed Playwright driver module selected by
`MANABITAN_PLAYWRIGHT_MODULE` and Chromium at `/usr/bin/chromium`.

## Correctness evidence

The actual reader passed all 27 range-reader cases on Node through an
explicit minimal Node assertion adapter, not a full Vitest installation.
Twenty existing cases retain semantic assertions; only expected read
ranges change to reflect coalescing. Seven added cases cover absent raw
filename metadata, offset views, zero/max filename length, impossible
central lengths and short prefix reads. Real Blob reads and deflate
roundtrips are executed. The independent #68 lifetime suite also passes
all seven unchanged cases on the combined source.

No full repository lint/type/build/Vitest pass is claimed from local
execution. Run the normal CI matrix and focused Vitest on this exact head.

## Promotion gates and next steps

Do not merge this draft solely from the stage gains. Investigate and
repeat the large-payload regression without removing bad samples. Run
real JMdict, Jitendex, wty-en-en and G10 source imports A/B in Chromium and
Firefox against #68, with identical artifacts, flags, storage state and
worker counts. Measure actual import completion, UI-settled time, peak
memory, persisted row counts and representative lookup/glossary parity.
Keep archive cancellation, fallback, malformed metadata, restart and
owned-buffer tests. Promote only after repeatable end-to-end improvement
without a correctness, memory or target-browser regression; otherwise
close the experiment while retaining the benchmark evidence.

Lookup changes were not implemented or performance-qualified in this
pass. Persisted key hashing and lookup indexes remain unchanged. The
priority and time spent here were import lifetime correctness and import
reader performance. #68 does not depend on this experiment.

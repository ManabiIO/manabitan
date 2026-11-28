# Record-run validator component study

This directory is an unexecuted prospective comparison. `protocol.json` remains
`draft-review-required`; both the launcher and observer refuse acquisition until
the parent reviews the code and explicitly freezes that status. No production
module loader, build manifest, public API, worker policy, or dictionary format has
changed.

## Comparison

Each of 36 observations launches a fresh pinned Chromium 153.0.8010.12 process,
context, and dedicated worker. There are 12 balanced AB/BA pairs and six interleaved
identical JavaScript A/A controls. Each observation consumes the same 12 captured
JMdict groups twice, in order, without a warmup.

The primary interval is the sum of first-pass validation calls plus the native
arm's separately measured first module compilation, memory creation, and
instantiation. Each native call includes its shape checks, memory growth, every
input-column copy, the kernel, result translation, and diagnostic counters. Cold
initialization, copy, kernel, guard/result, and heap reservations remain separate
in raw reports. The second pass reuses only that observation's declared module
and memory. Inputs and results are verified outside the timed interval, and every
call is checkpointed before proceeding.

The JS arm contains the exact source-bound loop and validation helpers extracted
from commit `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Extraction changes function
size, lexical context, call shape, and potential V8 optimization. This study can
screen a kernel; it cannot establish the gain of the actual async writer method
or a complete import. Asset fetches, script parsing/import, common factory-origin
admission, input restoration, verification, and observer transport are excluded.
Verification gaps can also affect background compilation and cache behavior.

## Inputs and contracts

`inputs/` contains 6,505,560 bytes of source-bound typed-column values. Every pass
has 528,299 rows and 366,030 unique references. Native staging is 6,505,556 bytes,
with a 655,360-byte peak linear-memory reservation. The adapter accepts only the
first run and only when the unique-reference count does not exceed that run's row
count, bounding staging by 16 bytes per requested row. Other inputs keep the JS
loop. Its result range is `[8,32)` and all native input ranges begin at 32, so the
adapter never writes its source columns. The raw export itself permits overlapping
result ranges after all relevant reads; it does not promise input immutability for
an arbitrary raw caller.

The original capture records the field-encoding boundary after production run
selection. Reconstructed private columns prove fixed-corpus component eligibility,
not the earlier live factory guard's activation. Original ArrayBuffer capacities
and aliases were not retained. The exact field-capture writer and worker bridge
were found by their recorded hashes; the enclosing capture harness remains
unlocated. The input inventory retains these limits and its earlier receipt.

## Review and execution

Use Node 22.22.0 and Playwright 1.63.0. The observer verifies the Chrome executable
version and SHA-256, then records launch arguments. It does not set WASM engine
flags or use a profiler. `observe.mjs` and `run.mjs` adapt the team's canonical
component lifecycle; `harness-lineage.json` records the copied source hashes.

Before acquisition, run the synthetic protocol checks and refresh the inventory:

```sh
node check-harness.mjs
python3 check-analysis.py
node refresh-source-inventory.mjs
```

The inventory refresher does not freeze or execute anything. After parent review,
the final protocol and every changed source must be rebound. The hosted workflow
and publication remain parent-owned. With the reviewed protocol frozen and exact
assets staged, the invocation is:

```sh
node run.mjs --inputs ./inputs --output /absolute/new/output-directory
python3 analyze.py /absolute/new/output-directory
```

The output directory must be new. Failed observations and partial calls are retained;
the fixed schedule continues without replacements. A successful analysis requires
all 36 observations, both complete passes, exact parity and admissions, source/asset
hashes, and final identity checks. All prespecified metrics and unchanged controls
are reported; there is no outlier trimming, engine pooling, adaptive rerun, or
whole-import inference.

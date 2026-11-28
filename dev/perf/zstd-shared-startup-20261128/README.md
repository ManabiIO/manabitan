# Shared Zstd module startup screen

## Review scope

The candidate sends the parent's already compiled `WebAssembly.Module` and loaded
16 KiB dictionary to the four production compression workers. Each worker still
creates its own native instance, heap, and contexts. Compression levels,
dictionaries, frames, envelopes, block boundaries, and the native WASM artifact
are unchanged.

This screen supports a reduction in redundant asset loading and Node process
memory. It does **not** establish faster browser imports or a statistically clear
reduction in first-job CPU. The isolated hosted workflow is the prospective test
for complete JMdict, Jitendex, and VNDB imports against identical controls.

## Acquisition and controls

- Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`; exact source and asset
  hashes are in `source-manifest.json`.
- Node `22.22.0`, V8 `12.4.254.21-node.33`, Linux `6.18.57`, x64,
  AMD EPYC 9V74. Parent heap limit 512 MiB; each actual Node worker's old
  generation limit 64 MiB. Four production workers are used.
- Fixture: the stock parser's canonical content slab for the first seven banks
  of the locked JMdict archive. These are 70,000 rows and 13,233,851 content
  bytes. The first four contiguous 1 MiB portions provide the compression
  workload. They are real canonical bytes, not a claim that these artificial
  boundaries reproduce the importer's complete block plan.
- Each child is a fresh Node process. Cold time includes production JavaScript
  imports, parent WASM/dictionary loading, four worker launches and readiness,
  and completion of the first four-block batch. A second, once-warmed batch is
  recorded separately. Fixture I/O and construction of the input arrays precede
  timing; output hashing and decompression verification follow it. Cold means a
  new codec and worker pool; OS file caches are not cleared, and the file-backed
  fetch adapter does not reproduce browser networking.
- A and C are independent executions of identical baseline code; B is the
  candidate. Twelve triplets use the fixed repeated rotations
  `ABC, CBA, BAC, CAB, ACB, BCA`. All observations and outliers are retained.
- The corrected cohort initializes `Response` and consumes an empty body in
  the parent before timing and in every worker bridge before its production
  import. This makes Node's lazy Response/undici adapter initialization common
  to both arms. Earlier fixed cohorts without this control are retained under
  `original-adapter` and are excluded from qualification.
- CPU is process user plus system time, including worker threads. Peak RSS is
  process lifetime maximum through the second batch, before verification; it
  includes fixture preload and adapter setup. These are Node measurements,
  including its worker transport and WebAssembly streaming implementation.

## Corrected results

All 36 corrected observations loaded four workers, compressed the same 4,194,304
input bytes into the same 437,286 output bytes, and passed exact frame/envelope
comparison plus decompression. Output SHA-256:
`2f8852dc35f9ee534d3c709b5ba28cb4f6531b282edfea656e2131b3d08aa8d1`.

| Metric                      |    A median |    B median |    C median | Paired B/A median change and 95% interval | Identical C/A control     |
| --------------------------- | ----------: | ----------: | ----------: | ----------------------------------------- | ------------------------- |
| Cold first-job wall time    |   218.10 ms |   211.45 ms |   218.50 ms | −7.86% [−33.48%, +12.20%]                 | −6.50% [−21.99%, +9.96%]  |
| CPU through cold first job  |   512.69 ms |   447.69 ms |   525.21 ms | −13.36% [−21.10%, +9.53%]                 | +2.20% [−8.59%, +9.56%]   |
| Peak RSS through second job | 159,724 KiB | 150,546 KiB | 161,146 KiB | −5.68% [−7.10%, −5.25%]                   | +0.20% [−1.82%, +1.98%]   |
| Once-warmed wall time       |    19.16 ms |     9.00 ms |    17.84 ms | −50.36% [−62.50%, −12.91%]                | −0.50% [−15.39%, +27.54%] |
| Once-warmed process CPU     |    47.22 ms |    26.04 ms |    44.96 ms | −52.03% [−55.32%, −30.63%]                | +4.34% [−22.34%, +23.50%] |

Intervals use a fixed-seed percentile bootstrap of the paired median percent
changes: 20,000 resamples, seed 473829. RSS is lower in all 12 pairs against each
independent baseline. Against C, its paired median change is −6.52%
[−7.17%, −5.46%]. First-job CPU is lower in nine of twelve pairs against both
baselines, but both confidence intervals cross zero. The single once-warmed
sample can include ongoing compilation and other startup work; it does not
establish steady compression throughput.

The deterministic work reduction is 5 to 1 WASM fetches, 5 to 1 dictionary
fetches, and 2,250,075 to 450,015 fetched bytes per parent plus four-worker pool.
Four worker streaming instantiations are replaced by instantiations of the
shared compiled module. This saves 1,800,060 asset bytes at the loader boundary;
network transfer depends on browser caching and is not measured here.
This is one-time pool startup: neither arm reloads these assets for subsequent
jobs while the same initialized pool remains alive.

The corrected parent-initialization comparison is also inconclusive: paired
B/A +2.82% [−26.41%, +33.56%]. The candidate's default loader retains a cloned
response for MIME fallback, so one extra WASM body can be buffered temporarily
in the parent. That cost is included in the measured candidate and must remain
covered by the browser qualification.

## Correctness and failure behavior

The focused source checks passed 133 assertions across 17 files, including
actual compression workers with asset fetching forbidden, byte-identical
dictionary and generic frames/envelopes, parent dictionary overwrite, owned
outputs, decoder allocation behavior, concurrent initialization, MIME fallback,
bad HTTP/WASM/module rejection with retry, delayed initialization following an
early module import failure, and startup dispatch failure cleanup with peer
settlement and a successful replacement pool. Hosted release-package,
import, memory, restart, and lookup validation remains required.

Changed JavaScript lint, main TypeScript, and a scoped typecheck of the five
codec test files and their imports pass. The full test TypeScript project could
not complete locally: the host killed it with exit 137 and no TypeScript
diagnostics. An earlier 512 MiB lint attempt exhausted its configured heap;
the scoped lint subsequently passed at 1,536 MiB. These resource failures are
recorded in `verification/checks.json`; they are not counted as passing gates.

`measured-candidate` preserves exact source snapshots matching the measured
candidate SHA-256 hashes. The final source adds two local aliases and explicit
JSDoc casts at untyped boundaries, removes semicolons from two new declarations,
and immediately observes a worker module import rejection while waiting for the
initialization message. The original rejection is preserved for the eventual
initialization-error response. `final-source-manifest.json` binds the review
source and documents the exact AST normalizations used to confirm there are no
additional executable changes. The built codec and native assets remain
byte-identical. The successful workload was not retimed after these disclosed
edits; hosted qualification uses the final PR head.

## Reproduction

Copy the `.mjs.txt` harness files into a scratch directory and remove their
`.txt` suffixes. Both source roots require installed dependencies and built
library assets. The baseline root also needs the locked JMdict ZIP in
`builds/e2e-dictionary-cache`.

```sh
node capture.mjs /absolute/baseline /absolute/evidence/jmdict-content.bin
node screen.mjs /absolute/baseline /absolute/candidate \
  /absolute/evidence/jmdict-content.bin /absolute/evidence/corrected.jsonl 12 pool
```

Set `NODE_OPTIONS=--max-old-space-size=512` for the commands above. The screen
spawns each child serially with that limit and writes every receipt before
continuing. `pool-response-warm-12-triplets.jsonl` contains the corrected raw
observations; `analysis.json` contains the unfiltered distributions and
intervals. No local browser result is inferred from these Node receipts.

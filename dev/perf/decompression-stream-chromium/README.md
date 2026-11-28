# Gzip-framed source inflation component

This research branch changes no product source. It compares the current native
libdeflate inflater against `DecompressionStream('gzip')`, using a fixed gzip
header and a trailer containing each existing ZIP member's CRC32 and decoded
size. Compressed bytes are unchanged. The hypothesis is that the browser's
native gzip implementation can combine inflation and CRC verification quickly
enough to pay for the extra copy of decoded chunks into parser memory.

The first campaign uses every bank and all 12 current-policy groups of the pinned
528,299-row JMdict fixture. Capture independently verifies the archive hash,
raw payload consumption, decoded length, CRC32, full decoded SHA-256 and JSON row
count. Every group must be ineligible for the current deferred CRC path. The
measured native call still receives `reuseGlossaryCrc=true`; a nonzero deferred
CRC pointer invalidates the comparison. VNDB is deliberately outside this first
campaign because its deferred glossary CRC reuse changes the work being compared.

## Frozen protocol

- Full Chromium 153.0.8010.12, Playwright 1.63.0, revision 1243, executable SHA-256
  `8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e`.
- One separate fresh browser verifies raw/gzip trailing-input and single-member
  conformance, malformed source acceptance, exact decoded bytes and native error
  replay. It must succeed before timing starts.
- Six balanced AB/BA pairs for each prospective fixed 64 KiB and 1 KiB compressed
  input slice variant, plus six separate source-identical native control pairs.
  Scenario order rotates before results; every arm launches a fresh full
  Chromium process/profile (36 measured processes in total).
- Each arm initializes three fresh module workers, each with its own parser
  instance, from one compiled source-bound WASM module. All 12 groups are assigned
  round-robin, four per worker. One group is measured at a time.
- The assignment differs from production's concurrent next-available scheduling.
  Results describe summed inflation/CRC/copy work, never parallel import wall time.
- No pre-inflation warmup, repeated pass, trimmed observation, selective retry or
  optional extra cohort. The first group on each worker is reported separately.
- Registration precedes browser work. Every completed group/conformance case is
  journaled and acknowledged before proceeding, preserving partial observations
  on error or timeout. Every arm is retained even if another arm fails.

Initialization includes module acquisition, its SHA check, compilation, worker
construction, JavaScript module loading and private instantiation. Browser/page
launch is reported separately. Group time includes allocations, native compressed
input copies, stream creation, gzip framing, fixed compressed input slices, all
decoded copies into the WASM arena, CRC/size/stream-end validation and bank wrapper
checks. Fixture HTTP reads and input digests are outside group timing. Both arms
copy and hash the complete decoded output, and check all preserved bank spans,
after timing and before any next call reuses that heap. Parsing and downstream
storage, compression, lookup and media work are outside this component.

## Correctness and resource limits

The direct helper is a prototype with exclusive heap ownership. The current
production scheduler awaits a complete worker job, then any borrowed-content
release, before sending another job. A product transaction must preserve that
decode-through-parse ownership. The helper's local active flag only prevents
concurrent decode calls; returned native memory expires on the next parser call.

DecompressionStream errors do not have the existing importer error class/text.
The conformance harness first compares direct accept/reject and valid bytes, then
checks unchanged compressed input and reruns native validation to reproduce its
original error. A native replay on failure is a possible integration mechanism;
the prototype itself is not activated as a product fallback. The hidden second
gzip member case is mandatory: a permissive concatenating gzip decoder can emit
the expected bytes with the expected final length and CRC despite invalid raw ZIP
payload boundaries. Length and CRC alone do not prove single-member validity.

The prototype checks declared output size before every destination copy and
requires full stream completion. Chromium may allocate decoded chunks internally
before JavaScript sees them. Neither fixed input slice variant therefore proves
the current native inflater's hard output-capacity bound on dishonest metadata.
A favorable ordinary-fixture result cannot waive that resource requirement. A
stricter bound would be required before a product candidate or full import PR.

Local Node 22 conformance found that raw DecompressionStream accepted forbidden
trailers and gzip accepted additional members, including the framed-source
adversary. No Node timing is presented as an equivalent browser implementation.

The [Compression Standard](https://compression.spec.whatwg.org/) requires gzip
CRC/size validation and rejection of additional members or trailing input.
[Chromium's inflater source](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/compression/inflate_transformer.cc)
checks for unconsumed input and data supplied after stream end. That source
inspection supports the experiment; the frozen browser's own conformance result
is the requirement for this study.

## Reproduction

```sh
node dev/perf/decompression-stream-chromium/capture.mjs \
  builds/e2e-dictionary-cache /tmp/inflate-captures
node dev/perf/decompression-stream-chromium/campaign.mjs \
  /tmp/inflate-captures builds/perf/inflate-screen 6
```

Capture and campaign output directories must be fresh. The campaign verifies
baseline Git blobs, source hashes, input manifests and the exact browser binary.
The GitHub workflow runs the same fixed protocol and retains all evidence.

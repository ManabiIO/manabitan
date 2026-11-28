# Fresh Chromium checksum component study

This is a research harness only. It does not change the extension, integrate the native helper into imports, or establish a complete-import speedup.

The frozen three-stream XXH32 module is the same 4,374-byte module used in the preceding Node study. Its SHA-256 is `04401e56da4ed009ca67def777e7c51e87251529b92eceb6951980907efbf75e`, and its entire fixed memory is 65,536 bytes. All native input copies, admission checks and ABI calls remain in the timed helper. It preserves the existing three independent XXH32 values and seed.

## Registered comparison

Each locked dictionary gets eight JS/native pairs plus eight independent JS/JS control pairs. Pair order alternates AB/BA, and scenario order rotates. Every arm starts a separate full Chromium process with a new temporary profile, a new page and a new module worker. There are no hash warmups, intra-group repetitions, trimmed samples or retries. Every process hashes all captured sections exactly once, in their captured order. Expected hash values are compared after each timed call without executing a comparator checksum.

The total is dynamic helper module loading plus native module HTTP acquisition, compilation and instantiation, plus the sum of the first-pass checksum calls. The native helper statically imports the existing JS fallback, so that module is also included in its load cost. Startup subtotals and checksum-only times are preserved separately. Local HTTP transport is part of the measured helper load; this is not the extension resource-loading environment.

Browser startup, worker startup, fixture HTTP I/O, SHA-256 verification, input backing reconstruction and result validation are outside that total. They remain visible in separate process/worker wall times. Each process streams one source group at a time rather than retaining the entire VNDB corpus. Base and derived spans are reconstructed as adjacent views after a 16-byte prefix in one ordinary owned buffer, matching the sink's source-view arrangement. Record fields keep a separate owned buffer. The unhashed prefix is zero-filled; no measured checksum sees it.

The server enables cross-origin isolation for precise browser timing and serves only an explicit source/input allowlist. Every input is checked for SHA-256 and length before hashing. The campaign records exact Git source/tree, harness and runtime file hashes, locked archive identity, manifest identity, native module hash, package lock, Playwright version/revision, browser executable hash, browser version and V8 version. Native compilation is reproduced using pinned Clang/LLD 21.1.8, and the independent upstream oracle is run in a separate Node process before the campaign.

## Capture scope and remaining limits

The frozen capture uses the actual source partition functions, native parser, prepared lookup bytes, record encoder and sidecar validation. It processes all locked rows and groups, but uses deterministic content references and calls `_encodeAndAppendArtifactChunkForState` directly with `contentDictName='raw'`. It does not replay compression, media rewriting or the real per-content-dictionary run splitting in `appendArtifactChunk`.

JMdict has 12 captured groups, 36 checksum calls and 23,748,240 hashed bytes. Adding 12 × (40-byte chunk envelope + 16-byte lookup container) and the 40-byte file header gives 23,748,952 bytes, matching the observed complete-import sidecar size.

VNDB has 170 captured groups, 510 checksum calls and 401,458,992 hashed bytes. Framing produces 401,468,552 bytes for one file. The observed complete import has two sidecar files of 399,513,708 and 2,386,124 bytes, totaling 401,899,832 bytes. The import counter 401,899,752 excludes those two 40-byte file headers. The remaining 431,280-byte difference is not explained by the captured envelopes: the real writer separates `raw-block-v2` and `raw-v6` content runs. This component therefore does not reproduce VNDB's exact sink call count or span sequence.

Fresh-worker cold behavior is also a deliberately separate question from real-import tiering. Earlier importer work may already have invoked the JS hash implementation. Complete browser imports, with actual startup overlap, preceding calls and persistence work, are required before treating this as a production optimization.

The earlier single-stream study is retained unchanged: on its first hosted JMdict machine, the warmed copy-inclusive native path regressed by 42–44% with stable controls. Other hosts favored it slightly or also regressed. Those results are not superseded by cold or three-stream observations.

The preceding complete-corpus Node study also has mixed warmed three-stream results. On AMD EPYC 9V74, JMdict's warm native/JS median was 0.535; on AMD EPYC 9V45, VNDB's was 0.863; on Intel Xeon 6975P-C, Jitendex's was 1.013 with a 1.001 A/A control. Fresh-process initialization-inclusive medians were 0.400, 0.435 and 0.428 respectively, with eight of eight treatment wins each. Those are Node observations on different CPUs, not browser or import speedups. This new browser cohort tests the cold-runtime interpretation without discarding the unfavorable warmed Jitendex result.

## Run

```sh
node dev/perf/native-sidecar-hash-prototype/capture-first-bank.mjs \
  "$PWD" builds/e2e-dictionary-cache /tmp/hash-captures --all-groups jmdict
node dev/perf/native-sidecar-hash-chromium/campaign.mjs \
  /tmp/hash-captures builds/perf/native-sidecar-hash-chromium/jmdict 8
```

Install the browser selected by the frozen `package-lock.json` with `npx playwright install --with-deps chromium`. The harness explicitly selects that full Chromium executable, not the separate headless-shell package. Failures and every registered observation are artifacts, and no failed arm is selectively rerun.

# MDict client lifecycle and support guide

## Ownership

`ext/js/comm/mdx.js` owns one conversion request across file reads, worker startup, messages, and settlement. The request-local failure callback is also its identity: old completions may clean up only their own timer and worker. `disconnect()` uses the same settlement path as errors and timeouts.

Snapshot the MDD selection before awaiting. Check cancellation both before starting each file read and after receiving its bytes. Cancellation can run in the microtask gap between a completed read and the outer continuation; a post-read check alone does not prevent the next resource read. `Blob.arrayBuffer()` is not itself aborted: the public request rejects promptly and late reads are ignored, including late rejections.

Worker progress callbacks can throw, cancel, or synchronously replace the request. Handle exceptions and reentrancy without clearing the replacement's state. Terminal messages and duplicate disconnects settle and terminate at most once.

The existing 180-second timeout now covers the complete read-and-convert operation, not only the worker. This is an intentional behavior change. Do not call it an import speedup or assume it qualifies large files.

## Tests

After the normal repository setup and library build:

```sh
node --test --test-reporter=tap test/util/mdict-native-cases.js test/util/mdict-client-cases.js test/util/mdict-client-edge-cases.js
npx vitest run test/mdict-binary-regressions.test.js
```

`test/util/mdict-client-edge-cases.js` adds controlled worker/file/timer coverage. It is included by both the native Actions command and the Vitest wrapper. These tests execute the production client but do not certify browser-worker transport or OPFS. Keep native parser fixtures unmocked; the wrapper's native subprocess avoids the vendored UMD codec choosing the wrong branch under Vite.

`test/playwright/mdict-help.spec.js` covers the shipped help page, Quick Start navigation, visible audio/installation limits, keyboard-operated troubleshooting, and narrow-screen layout. The guide uses existing production material/settings CSS and the generic page controller, with no new stylesheet or settings option.

## Documentation boundaries

`ext/mdict.html` is the offline user-facing guide. `ext/quick-start-guide.html` links to it; `docs/mdict.md` summarizes it. Do not claim dictionary audio works while the controller passes `enableAudio: false`. Local files import immediately, but URL sources are queued. Conversion completion must not be described as installation success. Do not recommend deleting unrelated dictionaries or renaming unrelated MDD resources.

The prior R3 download is a separate, unapplied cumulative candidate. Do not apply its manifest over the active native-correctness branch: parser, lifecycle, and test changes overlap. Its pairing and conversion-notice changes require a separate rebase and integration review.

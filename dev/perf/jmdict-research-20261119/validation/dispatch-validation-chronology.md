# Dispatch validation receipt chronology

This note explains retained receipts for candidate `8af2ed9d7bd6eb51b4cacd89e684c3a3904c539a`. It was written after validation, without rerunning checks or replacing any log or exit file. All paths below are under `/workspace/scratch/cb98f2e06b71/`.

## Type checks

The first command was `npm run test:ts:main && npm run test:ts:test`, with both command outputs directed to `dispatch-types.log`. That log reaches the test command, proving that the shell's main command exited successfully. The subsequent test command failed with TS2306 because the new test imported the worker entry directly even though that entry has no static module declarations. Consequently, `dispatch-types.exit` correctly remains **2**.

There is **no standalone main-type exit-zero receipt**. Main types passed at that stage, before the later worker event-data `unknown` annotation and test-only lint fixes. Do not label this as an additional main-type run on the final frozen source.

After fixing the test import, the command was focused Vitest **&&** test TypeScript. `dispatch-test-types-final.log` contains the clean test-type output, and `dispatch-focused-types-final.exit` is **0**, proving that both commands completed successfully. This occurred before the final test-only typed-array-copy style fixes; those changed `.slice()` to typed-array constructors and added a fixed-path import lint explanation.

## ESLint

Every invocation used a separate process with `NODE_OPTIONS=--max-old-space-size=1536`. The seven successes are distributed across retained runs; there is no single all-green final lint JSON.

| Changed file                                                | Successful evidence                                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ext/js/dictionary/zstd-term-content.js`                    | `dispatch-lint.log`: the original Python loop stopped on the first nonzero return; it advanced from this file to the worker file. |
| `ext/js/dictionary/zstd-term-content-compression-worker.js` | Explicit `exitCode: 0` in `dispatch-lint-final.json`.                                                                             |
| `test/zstd-term-content-pool.test.js`                       | Explicit `exitCode: 0` in `dispatch-lint-final.json`.                                                                             |
| `test/zstd-term-content-pool-drain.test.js`                 | Explicit `exitCode: 0` in `dispatch-lint-final.json`.                                                                             |
| `test/zstd-term-content-block-plan.test.js`                 | First ESLint command in the later `dispatch-final-gates.log` chain described below.                                               |
| `test/zstd-term-content-dispatch-batch.test.js`             | Second ESLint command in that chain.                                                                                              |
| `test/zstd-term-content-worker-batch.test.js`               | Third ESLint command in that chain.                                                                                               |

`dispatch-lint-final.json` and `.exit` correctly retain the three earlier test-file lint failures. Their successful follow-up command, as executed, was:

```text
eslint test/zstd-term-content-block-plan.test.js
&& eslint test/zstd-term-content-dispatch-batch.test.js
&& eslint test/zstd-term-content-worker-batch.test.js
&& vitest run [the seven focused suites] --maxWorkers=1 --testTimeout=30000
&& npm run test:build
&& git diff --check
```

All output went to `dispatch-final-gates.log`. It reaches Vitest and reports **64 passing tests across seven files**, establishing successful exits for all three preceding ESLint commands. Packaging then failed because the temporary `ext/lib` path was a symlink. Thus `dispatch-final-gates.exit` correctly remains **1**; it is not an ESLint or unit-test failure.

After replacing only that worktree's generated-library symlink with a private directory, the package-and-diff-check repeat succeeded. `dispatch-package-final.log` lists every build target and `dispatch-package-final.exit` is **0**.

## Receipt identities checked during this review

| Receipt                         | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `dispatch-types.log`            | `63caf74d677a17c25b4164bb5e2df2213eb49b215a5ac94307e8468909fee054` |
| `dispatch-test-types-final.log` | `5ec5f2bf15dc1efa5549e5bfd9f636ce37623bf9069b46861c528a1b8632748a` |
| `dispatch-lint.log`             | `ea2b0f85affc4b44b681f7e680219b1ad2899c0cb8bc3839a14bc867c61197d4` |
| `dispatch-lint-final.json`      | `d2219e294c6dca0b48f6d2e2bc53bcf15ed5ba641d8300d4373862457e51b468` |
| `dispatch-final-gates.log`      | `a34f7663f1f80ae704f9e429944954d8dba918a9e7d6fefd92bd1b8448e6f1db` |
| `dispatch-package-final.log`    | `f58f7fe0ac48e0d52ba8236ca6f5ee90074a08899acfa572dc9103cc9469d0b8` |

# Compact fused metadata validation

The correctness, build, and type gates for [PR #961](https://github.com/ManabiIO/manabitan/pull/961) passed on the exact published product tree. This ledger preserves the unsuccessful local attempts alongside the successful hosted checks. The [separate corpus proof](../README.md) covers JMdict, Jitendex, and VNDB output and lookup-route equivalence under the registered worker policies.

## Source identity

| Role                     | Identity                                                           |
| ------------------------ | ------------------------------------------------------------------ |
| Baseline                 | `0143e9596cd8f790d5e166d4ba6a2425fbc57f14`                         |
| Local candidate          | `6ad7d0112a8dd1078a007952d2f5647162525cd9`                         |
| Published candidate      | `0e233538e975c7be11b2144974923e2bf6396254`                         |
| Hosted CI merge          | `865ab81bfcd75e47c343834dfb2466a6c85b2b44`                         |
| Shared candidate/CI tree | `c83e5d77135b1ccf8ab86a4c51065758e3038b5d`                         |
| Parser WASM SHA-256      | `90d1d539ecf1e0f5519de9bc9aeab7ca550feb0c54e46bf411e93650d64ce264` |

The saved GitHub Git-data responses identify the published commit's parent as the baseline and the CI merge's parents as that baseline and published commit. Both GitHub trees equal the local candidate tree. Each hosted log records the merge checkout and Node `22.22.0`. The local receipts contain the candidate source hashes and Node `24.22.3`.

## Hosted gate results

[CI run 45865210236](https://github.com/ManabiIO/manabitan/actions/runs/45865210236), attempt 1, completed successfully. All 15 normal jobs succeeded; four conditional/manual jobs were skipped. The saved job metadata retains those skips explicitly.

| Gate                     | Result                                                                                                 | Receipt                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full unit suite          | **651 files passed; 14,681 tests passed; 47 skipped**                                                  | [Job 140066162560](https://github.com/ManabiIO/manabitan/actions/runs/45865210236/job/140066162560), `hosted-unit.log`, `hosted-unit-steps.json`                |
| Main TypeScript          | `npm run test:ts:main` executed successfully                                                           | [Job 140066162671](https://github.com/ManabiIO/manabitan/actions/runs/45865210236/job/140066162671), `hosted-main-types.log`, `hosted-main-types-steps.json`    |
| Test TypeScript          | `npm run test:ts:test` executed successfully                                                           | [Job 140066162347](https://github.com/ManabiIO/manabitan/actions/runs/45865210236/job/140066162347), `hosted-test-types.log`, `hosted-test-types-steps.json`    |
| Native rebuild and build | LLVM/LLD `21.1.8` pinned rebuild `--check`, seven extension targets, and manifest validation succeeded | [Job 140066162034](https://github.com/ManabiIO/manabitan/actions/runs/45865210236/job/140066162034), `hosted-build-140066162034.log`, `hosted-build-steps.json` |
| Chromium extension E2E   | Passed                                                                                                 | [Job 140066162186](https://github.com/ManabiIO/manabitan/actions/runs/45865210236/job/140066162186), `hosted-all-jobs.json`                                     |
| Firefox extension E2E    | Passed                                                                                                 | [Job 140066162141](https://github.com/ManabiIO/manabitan/actions/runs/45865210236/job/140066162141), `hosted-all-jobs.json`                                     |

The unit log explicitly records all 13 new compact-metadata cases passing, the four CRC tests and 17 memory-page tests passing, and all 90 unchanged content-hash tests passing. The build log contains the candidate WASM hash above and successful builds for `chrome`, `chrome-dev`, `chrome-playwright`, `firefox`, `firefox-dev`, `firefox-android`, and `edge`.

## Preserved local attempts

### Full suite, first attempt

```sh
npm run test:unit -- --maxWorkers=1
```

This Node `24.22.3` run started at `2026-11-26T17:14:15.156861Z` and exited 1 at `2026-11-26T17:28:56.880489Z`: 648 files passed, three files failed; 14,659 tests passed, one timed out, and 68 were skipped. The compiler helpers in `term-bank-crc.test.js` and `term-bank-memory-page.test.js` reported that no supported WASM compiler was available in that process. The unchanged content-hash test for byte offset 7 exceeded its existing 5,000 ms limit.

The original `unit.log` and `summary.json` are retained byte for byte. The planned subsequent local build did not start because the supervisor stopped after the failed unit gate.

### Pinned compiler and failed-file retry

```sh
source /workspace/scratch/f34c9c9fae89/toolchains/llvm21-env.sh
node node_modules/vitest/vitest.mjs run \
  test/term-bank-crc.test.js \
  test/term-bank-memory-page.test.js \
  test/term-entry-content-hash.test.js \
  --maxWorkers=1
```

The environment reported Clang and LLD `21.1.8`. The retry ran from `2026-11-26T17:32:44.881743Z` to `2026-11-26T17:38:21.321676Z`. Both native compiler suites passed all 21 tests. Across all three files, 106 tests passed and five unchanged content-hash cases exceeded the existing 5,000 ms limit:

| Byte offset | Observed test duration |
| ----------- | ---------------------: |
| 1           |             128,646 ms |
| 2           |              57,430 ms |
| 3           |              50,294 ms |
| 7           |              50,576 ms |
| 15          |              15,851 ms |

The log contains timeout failures and no hash-value mismatch. The content-hash test and implementation have identical Git blob IDs at the baseline and candidate, recorded in `summary.json.txt`. No assertions or timeout limits in those existing tests were changed, and the frozen product tree remained unchanged throughout these validation attempts.

`failed-files-retry.log` and `retry-summary.json` preserve the unsuccessful retry. An independent probe using the same WASM target/linker flags also compiled successfully; its exact command, source, output, and timestamps are included under `compiler-probe/`. A second full local run and local build were never started. Hosted exact-source unit, build, and type checks supplied the final gate results above.

## Receipt integrity and scope

`receipts.tar.gz` contains the unmodified local logs and metadata, the decoded hosted job logs, normalized GitHub job/step/run/commit metadata, and the compiler probe. `summary.json.txt` lists every archive member's byte count and SHA-256. Hosted job logs preserve their decoded UTF-8 bytes, including the BOM and terminal color sequences. `SHA256SUMS` binds the archive, summary, and this document.

```sh
sha256sum -c SHA256SUMS
tar -xzf receipts.tar.gz
```

This ledger closes correctness, build, and type validation. Dictionary-import timing qualification uses the separate registered cohort; test-run durations in this ledger are excluded from import-speed claims.

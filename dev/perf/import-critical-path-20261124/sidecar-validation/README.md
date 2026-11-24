# Sidecar candidate gate receipt

Frozen candidate **e0a0e73cc44e82a03474885d3bf4aee6765b317d**, tree **adf9df739aab4f1d641d77cb9eee3331e37d9100**, on base **bbccabd520972cc351a65d9f545bd5369b6e9747**. Source remained unchanged throughout these gates.

The initial full unit invocation failed. Its complete log and both unsuccessful compiler-setup retries are retained. Targeted retries resolved all observed failures without changing source, tests, or timeouts. Across the complete invocation and targeted retries, all 644 suites were exercised successfully, with 14,507 distinct passing tests and 47 remaining skips. This is combined coverage, **not a clean full-suite pass in one invocation**. Hosted CI remains the clean full-suite gate if performance qualifies the candidate.

| Attempt | Result | Log |
| --- | --- | --- |
| Full unit, two workers | 641 suites passed; two native setup failures; three Android 5-second timeouts | unit.log |
| Native and Android, one worker | Android 22/22 passed; incorrect compiler path still blocked native suites | unit-setup-retry.log |
| Native, corrected compiler path | Compiler found; linker absent from PATH blocked setup | unit-native-retry.log |
| Native, pinned compiler and linker | 2 suites, 21 tests passed | unit-native-pinned-toolchain.log |
| TypeScript | All four projects passed | typescript.log |
| Dry build | All seven extension targets passed | dry-build.log |

`receipt.json` records each exact command, exit code, test count, log SHA-256, and frozen source identity. The runtime was Node v22.22.0, npm 10.9.4, Vitest 4.1.12, and pinned Debian Clang 21.1.8. The compiler requires its sibling Debian executable directory on PATH for wasm-ld-21, plus its runtime library directory in LD_LIBRARY_PATH.

Generated extension libraries and legal notices came from the root setup. The dependency symlink is uncommitted. These gates establish correctness and build coverage; they do not establish a performance improvement.

# Shared-span compression transport validation

Frozen local source: **97a1cb41705c30462c516ffe46b05b0522e5c669**, tree **29ef86aa6a72b3c14c9429a725a811254a2db46e**, parent **bbccabd520972cc351a65d9f545bd5369b6e9747**. Published qualification source **7d4e4979f9ad0f3ed1d0e61840e6e06212ad63d8** has the same tree. No source changes followed the freeze.

| Gate                                 | Result                                                      | Retained evidence                                                       |
| ------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| Complete unit suite, one worker      | 645 suites passed; 14,506 tests passed; 47 skipped; exit 0  | unit.log                                                                |
| Focused compression/ownership suites | 10 suites, 98 tests passed                                  | Command and result in receipt.json; original output in agent transcript |
| TypeScript                           | All four projects passed                                    | typescript.log                                                          |
| Dry extension builds                 | All seven targets passed                                    | dry-build.log                                                           |
| Targeted ESLint                      | Passed on exact frozen source                               | eslint.log                                                              |
| Independent reviews                  | Evidence agent and root found no protocol/ownership blocker | Recorded in receipt.json                                                |

The complete suite passed in one invocation with Node v22.22.0 and the pinned LLVM21 compiler and linker correctly configured. `receipt.json` records the command, toolchain paths, counts, timings and log hashes. Generated dependencies were copied from the unchanged root setup; the dependency symlink remains uncommitted.

The change batches shared-span transport into the existing per-worker round-robin sequences. Every logical block retains its individual completion and source-consumption promise, immediate error notification, exact frame and ordered result slot. One existing 60-second deadline covers each worker batch and remains active until every logical job settles. Successful source acknowledgements reach the caller after every final gather and before the final compression; failed jobs still drain all later readers. Result ownership is bounded by the already-admitted operation. Private-factory dispatch, worker count, block planning, dictionary choice and codec settings are unchanged.

These checks establish correctness and integration coverage. They establish no import-speed improvement. Hosted whole-import qualification and its complete observations are maintained separately by the parent agent.

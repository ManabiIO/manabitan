# PR #784 source-bound CI evidence

PR: https://github.com/ManabiIO/manabitan/pull/784

All seven PR workflows completed successfully. All 21 executed jobs passed on Ubuntu; four conditional jobs were skipped (Edge, Android smoke, Android capability probe and published release upgrade). Main CI had 15 successful jobs, including complete unit tests, Chromium/Firefox extension E2E, Anki deduplication, build, all TypeScript groups and style/lint checks. Restart/interruption recovery, static web acceptance, CodeQL, dependency review, workflow lint and auto-approval also passed.

- Frozen product: `a0f8e8e00d30823b8451248b3e6bab20b4640eb8`
- Base: `d733d0efe53398bfc2b45985aa709ade54f5710a`
- Product and tested merge tree: `b0d18a0f0bbd096ebe9a18d09bf284d2684d4a65`
- Tested merge: `ef8b8e242e8fbeef260d23db05827896f2320323`
- Main CI: https://github.com/ManabiIO/manabitan/actions/runs/44826704284
- Restart/interruption CI: https://github.com/ManabiIO/manabitan/actions/runs/44826704427

## Actual report validation

| Evidence                    | Verified outcome                                                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full unit suite             | 622 files passed; 13,854 tests passed, 47 skipped, 13,901 total                                                                                                                                                              |
| Chromium extension E2E      | Status success; 90 completed phases; skippedVerification=false; OPFS sahpool installed in the dedicated dictionary worker; fallback disabled                                                                                 |
| Firefox extension E2E       | Status success; 63 completed phases; skippedVerification=false; OPFS sahpool installed in the dedicated dictionary worker; fallback disabled                                                                                 |
| Chromium Anki deduplication | All 10 scenarios passed; explicit clean merge/tree identity; OPFS sahpool with fallback=false                                                                                                                                |
| Restart/interruption        | Six required phase witnesses present; nine captured Chromium processes received SIGKILL and exited; recovery retained the exact old generation and removed one staging row; subsequent full update published 350,001 entries |

Browser report validation checks the actual worker storage API support and successful content-integrity phases, not only workflow success. Both browser reports explicitly say verification was not skipped. Chromium also contains successful persistence checks after update and after the JMdict/JMnedict multi-file import. All 51 observed Chromium and 10 observed Firefox fallback fields, including parsed phase receipts, are false.

The browser E2E reports do not embed source commit IDs. Their source binding comes from immutable GitHub run/artifact metadata plus retained successful job logs proving checkout of the exact merge commit and local chrome-dev/firefox-dev package builds. The merge tree equals the frozen product tree. Anki and restart reports additionally contain explicit source commit/tree identities. These general CI jobs use development package targets; the separate persisted-payload diagnostic uses pinned release Firefox packages.

The independent restart review verifies both launch identities and strict OPFS flags, the actual authoritative payload-write interruption boundary, owned process-tree termination, recovery/publication oracles, original artifact SHA256, source/tree identity, harness hash, all six changed packaged product files and the instrumented complete package tree hash. Its reproducible receipt is `restart-interruption/report-validation.json`. All 23 independent checks passed. The original extension ZIP and revision-two fixture ZIP are absent from the artifact, so their reported ZIP hashes could not be independently rehashed; the complete retained instrumented package tree, all six changed product files, exact observer insertion, and all archived fixture rows were verified. The restart oracle checks generation, inventory, sentinels, misses and cleanup; exhaustive persisted-term hashing is supplied by the separate combined payload diagnostic.

## Artifact preservation

| Report artifact      | Artifact ID |  ZIP bytes | ZIP SHA256                                                         |
| -------------------- | ----------: | ---------: | ------------------------------------------------------------------ |
| Chromium E2E         | 14673899157 |    157,975 | `be9f4825a959973496b3d90ecfda08e64b0693f214b1518acc4f7611a5478022` |
| Firefox E2E          | 14673424209 |     40,736 | `ceae5bf83f4fd4754292fac9c9eaaae00a139706022d314a93d2d8dca0797167` |
| Anki deduplication   | 14675220295 |      9,182 | `c7dfc1a19585f984a8439c921079ab47d01d01920e24dfc19aa703433073e65a` |
| Restart/interruption | 14673898767 | 34,279,689 | `fa961d1ba7c62cf6c85e9e0f70edef7d5aae878c4365c39e3680857804ba3a06` |

Every original ZIP matched GitHub's exact size and digest before safe extraction. Each artifact directory retains the original ZIP, metadata, download verification, full extracted reports/evidence and SHA256 manifest of every extracted file. The full browser job logs and full unit-test log are retained. `ci-receipt.json` combines the final verdicts; `workflow-gate-receipt.json` retains every workflow/job conclusion and Linux label; `browser-report-validation.json` retains the browser and Anki checks.

This is correctness and CI evidence, separate from performance benchmarks. No timings are claimed from these CI runs. No source changes, PR mutations or reruns were made during collection. Combined full persisted-byte equality is recorded separately in `payload-combined-results-20261120`; PR #785's verifier-only CI is recorded separately in `pr785-ci-results-20261120`.

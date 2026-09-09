# Isolated WASM inflater follow-up — September 9, 2026

## Decision

**PR #28 contains committed production source, but remains draft. The decompression component improves; a regression-free whole-import result is not established.** No release merge, Reader vendor update or v3-hotfix change was made by this work.

Parent: #26 at `925421edcb5262dd99f8879818c86fbace8e458a`. Performance baseline: #24 at `ff9cbf2e848a86d6bbfd281179a6d753349e52f4`. Actual production/test candidate: `dc226aaf88a0f8d2d4b2bcc37778352be0104622`. Later commits change verification tooling, not product code.

Only the miniz header's WebAssembly i64 capability selection is reused from #22. Its bulk history-copy experiment is excluded. Batch sizes, worker selection, memory budgets, grammar, CRC/size/trailing-input checks, caches and persisted formats are unchanged.

Candidate `miniz.h` Git blob: `22d72694d7361cc2642e845a7136eb38e6afeb63`; SHA-256: `619fbff2e98605a83f327a2879d52f219b5edaa579036a657937910f0707a43b`. Baseline blob: `6b71bda7605c11f0cb6da7f150d7d0fce6a5a6d2`; SHA-256: `8f03a9180dfc53fecfe26baa3566527f83af49cb432a60304aff75adb3b99f51`.

## Executed correctness

Independent correctness jobs in [34332509223](https://github.com/ManabiIO/manabitan/actions/runs/34332509223) and [34333540881](https://github.com/ManabiIO/manabitan/actions/runs/34333540881) passed. Each passed **5,511 unit tests**, 46 existing skips, 25 options tests, all four strict TypeScript projects and all-target dry builds. Their raw artifacts were downloaded and inspected. Protocol checks increased from 12 to 18 after the provenance repair.

Each CI job and local Clang 17 verification passed **3,847 native inflater cases for each bit-buffer width under ASan+UBSan**, with leak detection enabled: zlib byte oracles, streaming input/output boundaries, guard pages, truncation, exact consumption and output guards. This instruments the affected core, not the whole browser; no TSan pass is claimed.

Actual complete production WASM modules passed **4,434 oracle comparisons**: 4,096 synthetic cases plus all **338 fixed dictionary banks**, representing **754,052,959 decoded bytes**. Every emitted inflater/array-join byte matches both controls and an independent normalized-array oracle. This is exhaustive at that boundary, **not exhaustive persisted-database equivalence**.

The final typed oracle in `test/native/wasm-inflate-oracle.js`, blob `29b6c4850db961d0e2553ca61887d28266512551`, again passed all 4,434 cases locally. Focused repository lint, strict test types and a same-binary oracle passed in [34336244322](https://github.com/ManabiIO/manabitan/actions/runs/34336244322). No lint rules or source gates were weakened. The ordinary strict Chromium integration job in [34332513883](https://github.com/ManabiIO/manabitan/actions/runs/34332513883) also passed; its overall matrix was not green.

## Component measurements, not whole imports

Six alternating pairs per dictionary/environment, one excluded warmup pair, resident fixed compressed inputs. The real inflation/CRC/array-join export is timed; setup and verification are outside. CPU and elapsed bracket that call. Values are medians of within-pair changes; independent environments are not pooled.

| Dictionary | Local elapsed | First CI elapsed | Second CI elapsed |
| ---------- | ------------: | ---------------: | ----------------: |
| JMdict     |        -5.73% |           -8.40% |            -9.73% |
| JMnedict   |        -5.60% |          -12.10% |            -8.17% |
| Jitendex   |        -3.41% |           -6.88% |            -9.07% |

CPU medians also fell in every cell. The second CI JMnedict comparison includes a slower pair, retained in the evidence. Local: Clang 17/Node 22.16; CI: Clang 18/Node 24.20. These percentages are not whole-import, memory, ARM/Android, native Reader or iPhone claims.

## Complete browser comparisons

[34333540881](https://github.com/ManabiIO/manabitan/actions/runs/34333540881) used corrected driver `cd61590ec61b17198b7d03819a706ac21d604b54` with the same pinned product controls above. Each lane predeclared 18 fresh-profile imports: six alternating A/B pairs, two interleaved same-binary pairs and an excluded warmup pair. Trial 2 reversed initial order. Native page/worker memory classification was observed, not overridden. Timing remained file-input-change to post-UI completion.

Both JMnedict lanes completed and passed:

| Lane | Paired median | Equal-work total | Faster pairs | Worst pair |
| ---- | ------------: | ---------------: | -----------: | ---------: |
| 1    |        +3.53% |           -0.87% |          2/6 |    +22.69% |
| 2    |       -10.39% |          -11.40% |          4/6 |    +29.99% |

Same-binary changes were -12.60%/-0.04% in lane 1 and -20.73%/-13.42% in lane 2. The variation prevents a general speedup claim or a causal explanation of the slower pairs. #24's previous slow-tail concern remains open.

JMdict lane 1 retained 10/18 reports; Jitendex lanes 1/2 retained 10/18 and 9/18, then those jobs ended cancelled. JMdict lane 2 failed before its first import at the 30-second settings-input selector timeout. **These incomplete lanes have no effect estimates.** All six artifacts were downloaded, SHA-verified, and all 65 retained successful reports independently revalidated for source/package identity, rows, banks, memory tier, complete source-byte accounting, report hashes and sampled persisted readability. No observations were deleted, spliced or retried.

Artifacts for that run: correctness `10096887318`; JMdict 1/2 `10097473157`/`10097347626`; JMnedict 1/2 `10097431496`/`10097452564`; Jitendex 1/2 `10097476739`/`10097473529`. Raw artifacts, identities and full-precision audit output are also retained in the delivered evidence bundle.

## Errors and prior evidence kept separate

The first attempted full comparison rejected successful warmups because the new driver expected a WASM hash field absent from schema 3. The fixed driver checks actual build bytes, the entire ZIP and its unique WASM member before timing and after each import; the report's ZIP hash remains mandatory. Six new regression tests cover missing, duplicate and changed bytes. The first attempt has no effect estimate. One lane also hit its process limit after UI import completion but before complete verification; that output is not accepted.

Focused lint initially found the `.mjs` oracle outside all configured projects. Moving and typing it in the existing test project, then correcting two layout errors, produced the successful focused check above. Production code did not change.

Separately, the historical #26 run [34328594992](https://github.com/ManabiIO/manabitan/actions/runs/34328594992), which compares #23 with #24, was audited: 46 retained reports; only JMnedict lane 1 complete. Its paired median was -3.44%, equal-work total +1.12%, worst pair +18.38%, faster 4/6. The other lanes are incomplete. These are historical observations, not new local runs or part of #28's effect.

## Continuation gates

Use the browser lock's 526,942 JMdict, 667,942 JMnedict and 435,448 Jitendex rows; these JMdict/JMnedict archives differ from native Reader's fixed fixtures. Keep source and binary identities and complete plans. Improve setup/startup reliability or use a suitable measured runtime rather than dropping slow observations, changing memory classification, or combining incomplete runs.

Keep #28 draft pending complete whole-import evidence and platform coverage. Reconcile the selected #25/#22 release train with #23/#24 before release; apply the shared miniz header change only once. Concurrent #27/#29 copy experiments were not combined or duplicated. Native #12's Apple gate remains separate. Reader and v3-hotfix branches remain outside this work.

# Import research checkpoint: canonical component and source screens

**Decision: stop the combined canonical scanner experiment. No optimization PR, owner-boundary Stage 3, or replacement performance cohort is supported by this evidence.** The surrounding JavaScript publication screen is also closed without a candidate. This directory is research evidence; it changes no runtime, worker count, memory budget, or storage format.

The canonical study combines the existing immutable-input snapshots from [#880](https://github.com/ManabiIO/manabitan/pull/880) with the non-journal counter localization from [#864](https://github.com/ManabiIO/manabitan/pull/864), on exact baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. It is a source-derived Node native component, not an installed-extension or whole-import benchmark. Fresh-process first use and warmed kernel observations have separate boundaries. No subtraction from browser phase counters or extrapolation to import latency is valid.

## Exact product and correctness evidence

| Identity | Value |
|---|---|
| Baseline commit / tree | `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` / `d99ea4d04658f7ec1c76acdc5f3684594212a471` |
| Candidate commit / tree | `0285d5bd779cc1f4225bd41826613b6c00b08516` / `e1f60ce0a28bee8caeca32ebdc023e4a89eec96f` |
| Baseline canonical WASM | 1,624 bytes; SHA-256 `40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af` |
| Candidate canonical WASM | 1,806 bytes; SHA-256 `5ce4a3ef2869fe101d92cd46d1364c4be273546d2a77b9d7fd38ec3b10f2644a` |
| Candidate C source | SHA-256 `dc50ff2e2597e3e869583582abeb877e1174c6539d32de1870774fdfe780f126` |

[The full binary patch](canonical/product/candidate-vs-9e10.binary.patch) preserves all eight changed product/test files, including generated WASM and both baseline test fixtures. [The isolated-index proof](canonical/product/patch-proof.json) applies it to the baseline and reconstructs the exact candidate tree. This packaging check ran no native export or test and did not change the product worktree, normal index, or refs.

The original [validation receipt](canonical/validation.json), [build write log](canonical/build-write.log), [build check log](canonical/build-check.log), and [focused test log](canonical/focused-tests.log) retain the pinned Clang/LLD 21.1.8 commands and successful **150 tests across six files**. Parser WASM remained unchanged. These are historical validation receipts, not new executions during evidence packaging. Their original pre-acquisition status fields remain intact.

## Single completed replay and failed continuation gate

The immutable [protocol](canonical/component-protocol-proposed.md), [original registration](canonical/registration.json), [resumed registration](canonical/registration-resumed-home.json), [harness](canonical/canonical-component.mjs), and [watchdog](canonical/component-watchdog.py) are preserved. The resumed registration changes only the Node path and temporary root, with an [explicit amendment](canonical/resumption-home-amendment.json) and [independent review](canonical/resumption-home-independent-review.json). Node stayed at v22.22.0, SHA-256 `1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31`. Schedule SHA-256 stayed `4fca181d615f994bb3a266609a0919b7084f8099dd055dfdf8707437d6c646c9`; all numerical limits and continuation criteria stayed fixed.

Replay 002 is the **only actual performance cohort**. It includes nine first-use observations in separate fresh processes, three complete warmup blocks (108 calls), and twelve measured blocks (432 calls). The fixed measured orders are `ABC, BCA, CAB, ACB, CBA, BAC`, repeated once; A and C contain identical baseline bytes. All 549 recorded semantic checks passed. No observations were trimmed, replaced, or pooled with another cohort.

| Paired warmed component result | B versus A | B versus identical control C |
|---|---:|---:|
| Median corpus kernel saving | 0.583224 ms | 0.139855 ms |
| Median paired change | −5.134789% | −1.166188% |
| Faster measured blocks | 8 / 12 | 7 / 12 |

Median corpus totals were A 11.591712 ms, B 10.891553 ms, and C 12.258400 ms. The registered continuation screen required at least 10 ms and 10% saving against **both** controls, at least 10/12 faster blocks against each, and absolute median control drift below half the smaller candidate effect in both units. **Every gate condition failed.** The C/A median drift was +3.247480%; its observed paired range was −24.651542% to +190.172485%. Consequently the negative B/A percentage is not an established improvement. First-use data describe only the first captured call in fresh Node processes; they are retained separately and do not rescue this result.

The [raw observations](canonical/replay-002-evidence/acquisition-005/observations.jsonl), [first-use observations](canonical/replay-002-evidence/acquisition-005/first-use-observations.jsonl), [block totals](canonical/replay-002-evidence/acquisition-005/blocks.jsonl), [producer analysis](canonical/replay-002-evidence/acquisition-005/replay-analysis.json), [guard](canonical/replay-002-evidence/evidence/replay-002-guard.json), and [independent audit](canonical/replay-002-independent-audit/audit.json) are byte-preserved. The independent audit reconstructs schedule, arithmetic, source identities, semantic receipts, and resource accounting from those files; it does not execute additional performance observations. Per-call post-memory is not recorded: timed semantic success is asserted by the frozen harness, while the acquisition's twelve baseline outputs were independently recomputed in untimed fresh processes before replay.

Replay resources passed the unchanged guard: peak observed owned RSS 275,877,888 bytes; peak temporary bytes 51,268,923; minimum sampled available memory 3,070,513,152 bytes; preflight CPU busy 0.591935%. The 25.42-second guarded stage duration includes setup, first use, hashing and logging, and is **not a performance metric**. The guard recorded 495 samples, with 494 positive launched-root RSS observations; the first zero-RSS observation still contained the correct root identity.

## Acquisition, failures, and retained limitations

| Attempt | Outcome and qualification boundary |
|---|---|
| Acquisition 001 | Preflight resource block; no child or native timing. |
| Acquisition 002 | Completed twelve source captures, but its old watchdog omitted the launched Node process. Resource-invalid; never used for timing. Payloads were disposed after hash receipts, with the disposal record retained. |
| Acquisition 003 | External SIGKILL. The corrected guard did not report a configured limit violation; cause remains unknown. Seven partial capture receipts and forensic evidence survive; the partial payloads were lost in a later environment reset. No timing. |
| Acquisition 004 | Workspace ENOSPC while persisting the initial `running` receipt **after preflight passed but before Popen**. Zero-byte guard, no acquisition child. The original sidecar mislabels the branch as preflight failure; its additive correction is authoritative. The full traceback was not retained; only known excerpts remain. |
| Acquisition 005 | Qualified acquisition under the unchanged registration and guard, with report output moved to the already registered home temporary root. All twelve captures and the complete source census passed independent audit. |
| Replay 001 | CPU preflight rejected 21.88% busy; no child, replay registration, first-use call, or timing observation. |
| Replay 002 | Sole completed fixed cohort. Integrity/resource gates passed; all performance continuation criteria failed. No retry or Stage 3. |

All retained failed guards, negative guard tests, old harness/registration revisions, resumption documents, eligibility samples, console/child logs, and additive corrections are included. In particular [the original 004 account](canonical/resumed-home/acquire-004-preflight-failure.json) is preserved beside [the explicit correction](canonical/resumed-home/evidence/acquire-004-correction.json); missing traceback text has not been reconstructed.

Acquisition 005 contains 53 banks, 528,299 rows, 366,030 unique representatives, 362,032 pending rows, 3,998 exact matches, and 101,143,985 owned content bytes. Its [manifest](canonical/replay-002-evidence/acquisition-005/capture-manifest.json) records every compressed/input/semantic-output digest. The [independent acquisition audit](canonical/acquire-005-independent-audit/independent-acquisition-audit.json) binds all twelve baseline-only oracle calls, source bytes and resource accounting. Peak acquired RSS was 481,161,216 bytes and temporary storage 152,210,013 bytes; all fixed bounds passed.

The [read-only regeneration comparison](canonical/regeneration-comparison-002-to-005.json) finds that the retained 002 and 005 manifests match for all twelve input, compressed, and output hashes, arena sizes, configuration words, header words, and expected returns. This supports deterministic regeneration of the inputs. **It does not repair acquisition 002's invalid resource audit or create another timing sample.** The twelve reproducible gzip inputs (51,035,120 bytes total) are excluded from this compact pack, as are the original dictionary ZIP, native toolchain and generated/vendor bundles. Their identities are retained; the still-existing 005 inputs were not deleted by packaging.

## Surrounding source and diagnostic screens

The [closed JavaScript screen](wrapper/closed-screen.json) and [stack-qualified sample extraction](wrapper/canonical-parent-js-sample-clusters.json) use the existing exact-9e10 trace, SHA-256 `5b89ba263782ce409155bee286c51a1c7f6e181976321da71a6e9014ffac1d15`. It has 283 self samples in resolved-plan publication, 21 in pending-column adoption, and no sampled position ticks. These are counts, not weighted durations or branch coverage. All 3,998 exact candidates were recent-source hits; the source-derived capture used one fixed 26,214,400-byte arena. The retained run census covers only eleven groups: 327,665 pending rows in 3,175 runs, median length 48. A direct typed-scatter alternative remains unimplemented and unmeasured. No wrapper/publication microvariant or new benchmark was approved.

The profile owner is thread 3541; its ProfileChunk events are emitted on 3588, as documented in [the thread identity receipt](wrapper/thread-identity.json). This distinction changes no sample counts. Cache-validation reuse duplicates rejected #876; in-flight validation is already owned by #830; the bulk metadata subset from #764 is **already merged as #837**. Other related historical prototypes have no demonstrated outcome asserted here.

The CRC gap-tail idea is also parked because another owner already implemented the exact mechanism at [83912e61](https://github.com/ManabiIO/manabitan/commit/83912e61edb0bf4c8148ef3db309ed944f9babaf), with [diagnostic 53afc71f](https://github.com/ManabiIO/manabitan/commit/53afc71f1e8ed91134477be1b1f39e3f6a4cce83). Our [independent binary proof](crc/binary-proof.json) verifies unchanged non-code sections/function types/exports and only function body 5 changing from 538 to 822 bytes. The exact symbol proof maps that baseline body to `crc32_update_gap`. Existing native profiles contain **zero observed JMdict self samples** and **6,312 VNDB self samples** for it; zero samples is not proof of zero execution or cost. This review performed no compiled C test or timing of that candidate and substitutes for neither its pinned rebuild nor complete-import qualification. No duplicate implementation, branch, workflow, or PR was created by this subtask.

## Related frozen hosted studies

Statuses below are the handoff snapshot supplied on 2026-11-28 at 06:06 UTC, not live status. These studies remain separate; their observations are not pooled with this component.

| Study | Frozen source and run | Handoff status |
|---|---|---|
| Compression RPC batching | [15b77f6a](https://github.com/ManabiIO/manabitan/commit/15b77f6a453dac57bd4bd2a9bc0ba3a7ccb733e2); [run 46101323881](https://github.com/ManabiIO/manabitan/actions/runs/46101323881); [independent reader 46101845254](https://github.com/ManabiIO/manabitan/actions/runs/46101845254) | Rejected: six completed cells did not replicate a material complete-import improvement; JMdict AB failed the private-memory screen. VNDB AB memory coverage was unqualified, not a measured regression. [Summary](related/compression-batch-summary.json). |
| Parser source-limit dependency trim | [9707523b](https://github.com/ManabiIO/manabitan/commit/9707523b19c8c4ef175cf8d25cefbcae44afef05); [run 46103041097](https://github.com/ManabiIO/manabitan/actions/runs/46103041097) | Rejected: all six median intervals included zero; no independently replicated material gain. [Summary](related/parser-source-trim-summary.json). |
| Same-directory parser worker bundle | Runtime [9da7dedd](https://github.com/ManabiIO/manabitan/commit/9da7dedd17535b4a0f8edb97e56756049bbad7a7); corrected workflow [7d77b385](https://github.com/ManabiIO/manabitan/commit/7d77b3858b4f3f37e651f770f8f3a92c59d77036); [run 46110124022](https://github.com/ManabiIO/manabitan/actions/runs/46110124022) | Corrected run still queued at handoff. Original [run 46104747758](https://github.com/ManabiIO/manabitan/actions/runs/46104747758) failed the exact package-delta gate before timing because symlinked baseline dependencies changed unrelated esbuild source labels/maps. Workflow-only hardlink correction preserved runtime/harness/allowlists. [Failure receipt](related/bundle-original-validation-failure.json), [correction](related/bundle-workflow-correction.json). |
| Score validation | [f21bda70](https://github.com/ManabiIO/manabitan/commit/f21bda709a5b3374f4d5175f8234c94439936040); [run 46103789342](https://github.com/ManabiIO/manabitan/actions/runs/46103789342) | Four jobs complete, including VNDB AB qualification failure; two pending at handoff. No independently audited latency conclusion yet. [Registration identity](related/score-validation-experiment.json). |

The source profiles are reacquirable from [JMdict run 46102776159](https://github.com/ManabiIO/manabitan/actions/runs/46102776159), artifact 15245833865 (ZIP SHA-256 `af90ccebb72dab5c90f7ba48739db1b02211f7d3e86a2866db8ae30a72bdc3c0`), and [VNDB run 46105941344](https://github.com/ManabiIO/manabitan/actions/runs/46105941344), artifact 15249425984 (ZIP SHA-256 `83faed73425ccbbea53b2c7de803e4dfcea37e9077fbfa8142deca2844d78c36`). Trace observations are diagnostic, never authoritative comparative timing. The exact named native rebuild is [run 46105005935](https://github.com/ManabiIO/manabitan/actions/runs/46105005935), artifact 15247569694 (ZIP SHA-256 `b7197f3f07a0f04c017171f9389b0ed26ac841bce2e4a9fc370a58d4e5377907`); its independent audit and receipt are retained under `crc/`.

## Pack integrity and reuse

[source-aliases.json](source-aliases.json) maps every selected original path to its byte-identical stored file; duplicate contents are stored once. Historical absolute paths and original status fields are intentionally unchanged. [PACK-MANIFEST.json](PACK-MANIFEST.json) hashes every deliverable except itself. [verify-pack.py](verify-pack.py) checks the complete file set, hashes and source-alias coverage without executing product code. [assemble.py](assemble.py) records how the pack was produced from already existing evidence.

Auxiliary transport/download metadata, signed URLs and authorization fields were not selected. Raw timing, resource and failure records were never redacted or rewritten. No full traceback, lost payload, unavailable receipt, or unobserved performance result is invented. Publication of this evidence checkpoint does not publish the candidate into a runtime branch or constitute a performance promotion.

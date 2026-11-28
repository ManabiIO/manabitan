# Reconstructed native record-field integration: correctness only

This is a separately reviewed integration of the existing native-field implementation with current develop `f28c2801fcfd9416f220b46b9cbafeee901c1cb2` after PR981 merged. No full-browser native-field timing has occurred. The original executor became unavailable before the earlier integration worktree could be committed. The replacement source is explicitly a new reconstruction, with exact recovered kernel bytes and new production lifecycle, guard and test code. It is not an assertion that unmatched files were recovered byte for byte.

The clean product commit is `8982dd89fac525100bdcaca7507bfff7feb2c842`, tree `76f8a0cbe2b3820b5e33d16b5f3a4f836ef0860d`. Its sole parent is the pinned current baseline. The isolated correctness kit has that clean product commit as its sole parent. The earlier reconstructed product `5545e5c26daaaa13af18a4f6f94e762b3856446c` and every original failed run remain provenance in `recovery.json`.

## Current baseline rebind

Original correctness run46132025311 at `5c95580e99d0f1f57e0daef417753003c352e5b5` passed every required validation gate and all three untimed corpus pairs, with both complete artifacts retained. Its result remains bound to its original dcfc-based product. Completion receipt `56ee96368e7abc499ac8de3093c6122f895a5fd8` names the full logs, artifacts and all prior failures.

Develop then merged PR981 before any full-browser timing of this candidate. The new baseline changes dictionary metadata/in-flight handling, physical lookup warming and the compact field reader loop. Our database metrics additions and store helper/lifecycle additions are reapplied without altering them. The exact previous and peer patches commute: either application order yields identical complete DB/store bytes, and every original hunk context is disjoint. The remaining11 product blobs and all nine shared inert-control blobs are unchanged. All peer runtime and test changes are inherited, and current parser/native bytes remain unchanged.

Complete path/blob/patch proof is `b7b1e9914f663fa0c18f94f58b844642522614ce`; independent root review is `3f1760c6664232c76d2a77efac7093e17ef11ba7`. This revision rebinds exact source ancestry, the corpus orchestrator's baseline constant and provenance. The actual importer driver, adapters, worker bridge, open-connection text, focused tests, native compiler and archive writer/test machinery are unchanged. Current-source correctness and corpus evidence remain required; an earlier result is not relabeled as this new integrated source.

## Runtime behavior

An accepted record-store import session starts optional module and WASM preparation without waiting. Each session owns a separate bounded native memory. The live encoding boundary remains synchronous: the helper verifies private factory provenance, intrinsic typed-array and backing-buffer identities, current dimensions and representable values, copies inputs, calls the bounded kernel, checks the result and returns an independent output copy. A nullable decline enters the original JavaScript encoder once. It introduces no await between existing validation and encoding.

Only the immutable compiled module is shared. Prepare, rollback and reset retire the current owner before cleanup. Late preparation completion is identity-fenced. End-session cleanup and finalized diagnostics both retain the owner captured before the old end operation awaits, so an old completion cannot dispose or report a new session.

Missing browser features or an unavailable asset preserve the JavaScript route. Browsers without the intrinsic ArrayBuffer resizable getter decline safely. No native-memory view escapes into record storage. The new packaged asset is covered by valid release fixtures and independent missing/corrupt-asset cases.

The repairs following the original validations preserve all runtime guard, ownership, fallback and kernel-call expressions. They add accurate intrinsic getter types, the narrowly justified capture-only unbound-method annotation, JSDoc and formatting. Tests retain every existing case, replace a hostile-object deep matcher with direct argument identity checks, and correct test-only types and style. The latest repair first assigns the already-guarded descriptor value to an explicitly declared unknown local, then applies the existing number assertion. The descriptor is still read once at the same point, without coercion or a new branch. The lifecycle test declares its full nullable implementation signature before creating the mock. No performance tuning or additional native mechanism is introduced.

## Exact source and validation boundary

The source verifier binds the exact baseline, clean product parent and correctness-kit child. It verifies every changed path, Git mode, Git blob, SHA-256 and byte count, and unchanged observer/fixture/build inputs. Protected regular files may be mode `100644` or `100755`, but each must match its exact baseline Git entry and bytes.

Before setup, tracked files must equal the commit. After the unchanged setup action regenerates `ext/legal-npm.html`, only that document may differ, with committed/generated hashes recorded. Generated native files under `ext/lib` must equal the tracked manifest targets byte for byte. The accepted current parser C/WASM remains unchanged in both arms.

The workflow uses Node 22.22.0 on Ubuntu 26.04. It performs the pinned Clang/LLD 21.1.8 rebuild, scoped lint, complete ordinary and options unit suites, main/dev/test type checks, and all-target dry builds. Independent gates retain their complete logs and continue after another validation gate fails; the aggregate fails unless every required gate passed. Executable compiler/linker paths are absolute and are not canonicalized through their symlinks.

Focused helper/lifecycle tests use the actual 1,753-byte native artifact and independent expected record bytes. They cover malformed values, nullable fallback, intrinsic backing kinds, output ownership, memory bounds and old-owner/new-owner races. Controlled focused tests may await preparation; that fact does not establish natural importer readiness.

## Untimed actual-importer parity

The corpus job prepares two independent dependency installations from the same lock and pinned Node. It does not symlink baseline `node_modules` to the candidate: esbuild resolves such dependency symlinks and can emit different cwd-relative module/source-map paths. Each checkout builds its own runtime assets and license page.

Before fixtures, smoke tests or imports, a separate read-only `--preflight-only` run binds both prepared source trees and compares every generated `ext/` file. The only permitted differences are the database/store, helper JS, field C source and generated field WASM. Complete unexpected path identities are written and printed if this exact comparison fails. The actual acquisition repeats the same preflight and requires every completed arm's runtime to equal its preflight inventory.

Fresh baseline and candidate processes then use the real importer, parser, compression and index workers for all three pinned corpora. There is no helper preload, readiness await, replacement import or local speed comparison. Full field bytes, final term files and work counts must match. Readiness JavaScript calls remain in diagnostics; zero native coverage cannot establish activation.

The Node route uses nonpersistent real SQLite and disk-backed OPFS-shaped sidecars. It does not qualify browser scheduling, storage restart, image decoding, exhaustive media or performance. These limitations remain in every final receipt.

Every smoke/arm/failure emits its compact original receipt and file hashes into the job log. A small source-bound archive writer and nine bounded synthetic regressions run before any corpus import. The always-run writer retains all available corpus evidence and frozen source inside PAX tar.gz, including legitimate raw sidecar filenames containing `|`. It preserves intentional smoke-test symlinks as inert type/target metadata, never follows or extracts them, and stores hardlinked ordinary files as independent complete payloads. It reads the archive back and verifies every file hash, size, type, member name and link target. The tests cover the observed filename/link failures, dangling/cyclic links, hardlinks, output boundaries, dot-root rejection, unsupported nodes and tampering. Upload receives only the portable archive and its complete member receipt. Successful arm disks may still be retired only after complete comparison and a second full raw-byte hash, as explicitly recorded by the unchanged driver; retained hashes are not a claim that those successful raw bytes were archived.

## Preserved original failures

| Original run | Source-bound outcome |
| --- | --- |
| 46125649822 at `9f60facd...` | Both jobs failed source preflight because the first guard rejected an unchanged protected executable file. Setup and imports were skipped. Both original logs and artifacts remain linked. |
| 46127174624 at `9b75d8f0...` | Pinned native reproduction, options units, main/dev types and all-target builds passed. Lint, one ordinary unit assertion and three test-type checks failed. The ordinary suite retained 15,272 passing tests, 47 skipped tests and one failure. |
| Corpus job 140924246997 in run 46127174624 | Logs report completed JMdict A/B imports, but the exact runtime delta comparison failed. Artifact upload then rejected a raw filename containing `|`; internal arm files are inaccessible. No complete corpus parity is claimed. |
| Validation job 140932020532 in run 46129727075 at `a700f319...` | All 671 ordinary unit files and 15,273 tests passed, with 47 skips; options units, main/dev types, pinned native reproduction and all builds passed. One helper assignment lint issue and one lifecycle mock type error remained. |
| Corpus job 140932020734 in run 46129727075 | All three original A/B pairs and exact runtime preflight passed. The archive then rejected an intentional smoke-test symlink before producing a tar. Full log-backed parity/activation evidence is retained, while the missing complete archive remains an explicit limitation. |

The full validation log is retained as blob `74a1ab16c202440a5f92b6c0d46f5ff1ca38f961`, and its artifact is 15256866545. The complete failed corpus log is blob `b6c5922529251a47530954d3f0404c122be31952`. The combined failure receipt is `455d940a7ad3786dc425aa0b86c004c73080127f`. Artifact metadata and any copied archive remain distinct from an independently audited archive.

The complete a700 validation log is blob `45a364937c9bec230800212c67c03c8587881431`, and its validation artifact is 15257044175. Corpus log `19d6fd81a9376205ff0e66d1bf3d5d5cf420c921` preserved all 226 field-buffer comparisons and 7,613,164 term rows. Independent log recovery `462fc38be97a2dd82c4eac9f8488601514b3a891` confirms exact field/final-file hashes and natural native calls 12/22/192, with no JavaScript calls or declines. These are exact-source logged results; they do not replace the unavailable complete corpus archive or qualify the changed helper bytes. Combined original failure receipt `5696251e503c805ba476299a026feb5aab13aca9` preserves every passing and failing gate.

The subsequent original5c95580e revision fixed those type and archive failures and passed every required gate. This new f28 baseline integration leaves that successful source/run untouched and acquires separately identified current-source correctness evidence. It introduces no new native mechanism, comparative timing, replacement import or result-driven tuning.

## Independent component and browser gates

Original standalone component run 46115204690 failed while Clang parsed a relative linker name. It produced zero warmups and zero measured observations. The separately authorized linker-repair run 46123144616 changed only its workflow and recorded workflow hash, keeping every frozen kernel, wrapper, capture, schedule and threshold unchanged.

Records-only audit 46126612006 verified the complete corrected artifact: all 217 members, all 42 scheduled records, exact source/captures, output parity and work counts. It also verified all 82 members of the original zero-observation failure. The corrected component passed its prospective CPU/saving/control gate. Completion receipt `7a88aa027bb49f3de5c2c118454936a0b4d9458c` and final reader result `c41c034efa9021adc77c328ffc50066912e6e195` preserve that bounded result. It does not establish a full-import improvement.

Production browser acquisition remains disabled until this exact current integrated source passes all correctness gates and retained three-corpus activation proof. The prospective design keeps six original cells, 24 measured pairs, eight controls, two warmup pairs, two media imports and four memory imports: 74 reports per cell. The earlier 12-pair draft and the pre-timing rationale for higher precision remain in `recovery.json`.

The new inert control `c34c272357fb8af463d32ab781bcbc640ba1bd3d` carries identical shared helper/native/build bytes over the same baseline. Its runtime remains inactive. The product differs only at the packaged store and database files; candidate-only activation tests are not packaged. Actual member equality still must pass the unchanged common qualifier.

Every measured observation, control, fallback and failure must remain. No pruning, replacement, control correction, repeated cohort or result-driven tuning is authorized. This correctness workflow acquires no browser timings and authorizes no product PR.

The prospective readiness decision is frozen separately in `293adf44d2172d8da91f707386356dcb093cd4f8`: allow JavaScript readiness work only through the first actual source group's complete field-call/row budget, require all remaining calls/rows native, and allow zero ready-state declines. It is an engineering coverage budget rather than a guaranteed loader deadline. Exact counts remain unsealed until this new source's original receipts are independently audited. All readiness calls stay in full import timing; exceeding the budget rejects the cell without retries or exclusions.

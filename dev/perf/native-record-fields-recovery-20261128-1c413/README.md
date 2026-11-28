# Reconstructed native record-field integration: correctness only

This is a separately reviewed production-source repair over `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`. The original executor became unavailable before the earlier integration worktree could be committed. The replacement source is explicitly a new reconstruction, with exact recovered kernel bytes and new production lifecycle, guard and test code. It is not an assertion that unmatched files were recovered byte for byte.

The clean product commit is `d4038d0cfaeda8f019afc9ead47d035df633f284`, tree `49a7c6ac1270ff8ef19f4e6fb7bdad7970f294eb`. Its sole parent is the pinned current baseline. The isolated correctness kit has that clean product commit as its sole parent. The earlier reconstructed product `5545e5c26daaaa13af18a4f6f94e762b3856446c` and every original failed run remain provenance in `recovery.json`.

## Runtime behavior

An accepted record-store import session starts optional module and WASM preparation without waiting. Each session owns a separate bounded native memory. The live encoding boundary remains synchronous: the helper verifies private factory provenance, intrinsic typed-array and backing-buffer identities, current dimensions and representable values, copies inputs, calls the bounded kernel, checks the result and returns an independent output copy. A nullable decline enters the original JavaScript encoder once. It introduces no await between existing validation and encoding.

Only the immutable compiled module is shared. Prepare, rollback and reset retire the current owner before cleanup. Late preparation completion is identity-fenced. End-session cleanup and finalized diagnostics both retain the owner captured before the old end operation awaits, so an old completion cannot dispose or report a new session.

Missing browser features or an unavailable asset preserve the JavaScript route. Browsers without the intrinsic ArrayBuffer resizable getter decline safely. No native-memory view escapes into record storage. The new packaged asset is covered by valid release fixtures and independent missing/corrupt-asset cases.

The repairs following the first executed validation preserve all runtime guard, ownership, fallback and kernel-call expressions. They add accurate intrinsic getter types, the narrowly justified capture-only unbound-method annotation, JSDoc and formatting. Tests retain every existing case, replace a hostile-object deep matcher with direct argument identity checks, and correct test-only types and style. No performance tuning or additional native mechanism is introduced.

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

Every smoke/arm/failure emits its compact original receipt and file hashes into the job log. An always-run archive step retains all available corpus evidence and frozen source inside PAX tar.gz, including legitimate raw sidecar filenames containing `|`. It reads the archive back and verifies every file hash, size, type and member name. Upload receives only the portable archive and its complete member receipt. Successful arm disks may still be retired only after complete comparison and a second full raw-byte hash, as explicitly recorded by the unchanged driver; retained hashes are not a claim that those successful raw bytes were archived.

## Preserved original failures

| Original run | Source-bound outcome |
| --- | --- |
| 46125649822 at `9f60facd...` | Both jobs failed source preflight because the first guard rejected an unchanged protected executable file. Setup and imports were skipped. Both original logs and artifacts remain linked. |
| 46127174624 at `9b75d8f0...` | Pinned native reproduction, options units, main/dev types and all-target builds passed. Lint, one ordinary unit assertion and three test-type checks failed. The ordinary suite retained 15,272 passing tests, 47 skipped tests and one failure. |
| Corpus job 140924246997 in run 46127174624 | Logs report completed JMdict A/B imports, but the exact runtime delta comparison failed. Artifact upload then rejected a raw filename containing `|`; internal arm files are inaccessible. No complete corpus parity is claimed. |

The full validation log is retained as blob `74a1ab16c202440a5f92b6c0d46f5ff1ca38f961`, and its artifact is 15256866545. The complete failed corpus log is blob `b6c5922529251a47530954d3f0404c122be31952`. The combined failure receipt is `455d940a7ad3786dc425aa0b86c004c73080127f`. Artifact metadata and any copied archive remain distinct from an independently audited archive.

This new revision fixes the concrete failure set together. It does not rerun, rewrite or replace an original result. Its own complete correctness and corpus gates remain unexecuted at source freeze.

## Independent component and browser gates

Original standalone component run 46115204690 failed while Clang parsed a relative linker name. It produced zero warmups and zero measured observations. The separately authorized linker-repair run 46123144616 changed only its workflow and recorded workflow hash, keeping every frozen kernel, wrapper, capture, schedule and threshold unchanged.

Records-only audit 46126612006 verified the complete corrected artifact: all 217 members, all 42 scheduled records, exact source/captures, output parity and work counts. It also verified all 82 members of the original zero-observation failure. The corrected component passed its prospective CPU/saving/control gate. Completion receipt `7a88aa027bb49f3de5c2c118454936a0b4d9458c` and final reader result `c41c034efa9021adc77c328ffc50066912e6e195` preserve that bounded result. It does not establish a full-import improvement.

Production browser acquisition remains disabled until this repaired production source passes all correctness gates and retained three-corpus activation proof. The prospective design keeps six original cells, 24 measured pairs, eight controls, two warmup pairs, two media imports and four memory imports: 74 reports per cell. The earlier 12-pair draft and the pre-timing rationale for higher precision remain in `recovery.json`.

The new inert control `83fb6a76367e36a663ed1100191bf7959c5beb38` carries identical shared helper/native/build bytes over the same baseline. Its runtime remains inactive. The product differs only at the packaged store and database files; candidate-only activation tests are not packaged. Actual member equality still must pass the unchanged common qualifier.

Every measured observation, control, fallback and failure must remain. No pruning, replacement, control correction, repeated cohort or result-driven tuning is authorized. This correctness workflow acquires no browser timings and authorizes no product PR.

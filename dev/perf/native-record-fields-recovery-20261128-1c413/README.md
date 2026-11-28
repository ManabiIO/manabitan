# Reconstructed native record-field integration: correctness only

This is a new production-source reconstruction over `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`. Before any execution or correctness publication, the still-unexecuted reconstruction was rebased onto this exact develop revision to retain the accepted parser source and WASM. The earlier unreferenced 9e10 product commit remains provenance. The reviewed helper, store, database, field kernel, focused tests and other build files are byte-identical; only the combined native manifest is recomputed for the current parser. It exists to validate source correctness after the executor became unavailable before the earlier integration worktree could be committed. It is not an assertion that unmatched files were recovered byte for byte. `recovery.json` identifies every product file, exact recovered asset, new source file, earlier incomplete attempt and retained failure.

## Runtime behavior

An accepted record-store import session starts optional module and WASM preparation without waiting. Each session owns a separate bounded native memory. The live encoding boundary remains synchronous: the helper verifies private factory provenance, intrinsic typed-array and backing-buffer identities, current dimensions and representable values, copies inputs, calls the bounded kernel, checks the result and returns an independent output copy. A nullable decline enters the unchanged JavaScript encoder once. It introduces no await between existing validation and encoding.

The immutable compiled module can be reused; mutable native memory cannot be shared between sessions. Prepare, rollback and reset retire the current owner before cleanup. Late preparation completion is identity-fenced. End-session cleanup and finalized diagnostics both retain the owner captured before the old end operation awaits, so an old completion cannot dispose or report a new session.

Missing browser features or an unavailable asset preserve the JavaScript route. In particular, browsers without the intrinsic ArrayBuffer resizable getter decline safely. No native-memory view escapes into record storage. The new required packaged asset is covered by both valid release fixtures and independent missing/corrupt-asset cases.

## Exact source and validation boundary

The source verifier binds the separate product and correctness commits: the product commit's sole parent is the exact baseline, and the correctness commit's sole parent is the reviewed product commit. It also binds all changed file modes/Git blobs/SHA-256 values, the complete allowed path set, and unchanged observer/fixture/build inputs. Before setup, tracked files must match the commit. After the unchanged setup action regenerates `ext/legal-npm.html`, only that generated document may differ, and both its committed and generated hashes are recorded. Native files under `ext/lib` must equal the checked-in manifest targets byte for byte.

The correctness workflow uses Node 22.22.0 on Ubuntu 26.04. It runs the pinned Clang/LLD 21.1.8 rebuild, scoped lint, complete ordinary and options unit suites, full main/dev/test type checks, and all-target dry builds. Every gate retains its own complete log. The existing build script resolves the exact executable linker path; the workflow passes an absolute executable path without canonicalizing its symlink.

The new helper and lifecycle tests are source-reviewed but have not been executed at source-reconstruction time. They use the actual 1,753-byte native artifact, independent expected record bytes, malformed-input/fallback cases, owned output checks and old-owner/new-owner regressions. Some focused lifecycle tests explicitly await their controlled preparation promise. Those cases prove the tested ready-path behavior and do not claim ordinary importer readiness coverage.

The separate untimed corpus driver starts fresh exact-baseline and candidate processes, uses the real importer and worker sources, and compares complete field outputs, finalized term files, runtime identities and work counts. It does not preload the optional field helper, wait for its readiness or repeat an import to obtain activation. A readiness JavaScript call remains in the accounting. Node uses nonpersistent real SQLite with disk-backed OPFS-shaped sidecars; it does not establish browser storage, restart, image decoding, full-media or performance behavior. Any incomplete corpus or media coverage remains an explicit limitation.

No timing comparison, browser benchmark, product PR or performance nomination occurs in this correctness workflow. Product-internal clocks already present in the application are not interpreted as comparative evidence.

## Preserved component failure and independent performance gate

Original component run 46115204690 failed while Clang parsed `-fuse-ld=wasm-ld-21`. The focused tests and acquisition step were not reached: zero new warmups and zero measured observations exist. Its source, job log and artifact are retained unchanged. This failure provides no native correctness or performance conclusion.

The separately authorized linker-repair study is run 46123144616 at `e5d6d7273fafc84affe808bc4383b55107a3c99b`. Only the launcher workflow and its recorded workflow hash differ. The original 77 frozen kit files, standalone wrapper/kernel/captures, Node/host, 42-record schedule and nomination thresholds are unchanged. Neither original run is rerun or modified by this reconstruction.

Production browser qualification remains blocked until the original corrected component screen passes its prospective gate and a complete independent artifact audit. The prospective browser plan is preserved in `recovery.json`: six original cells, 24 measured pairs, eight controls and 74 total reports per cell. The earlier 12-pair draft and the pre-timing reason for increasing precision are retained. An inert-asset baseline control is required to keep the unchanged qualifier's package-member equality check. No control correction, pruning, replacement observations or result-driven tuning is authorized.

## Separate correctness source-mode repair

The original correctness corpus job 140919541894 in run 46125649822 failed at the first source check. The unchanged protected `dev/perf/prepare-dictionaries.js` has Git mode `100755`; the first guard incorrectly required `100644` for all tracked files. Node setup, comparator/smoke tests, fixture preparation and all imports were skipped. The original run, source, complete log and artifact 15255972488 remain preserved. Its separate validation job was still queued when this repair was authored; no result is inferred for that job.

This distinct correctness revision keeps product commit `5545e5c26daaaa13af18a4f6f94e762b3856446c`, every runtime/test byte, and all corpus acquisition logic unchanged. The guard accepts only ordinary Git blob modes `100644` and `100755`. Bound files must still match their exact manifest mode, and every protected path must match the baseline's complete Git entry and exact bytes. All 21 protected paths were checked against the complete pinned baseline tree: 20 use `100644`, and only the dictionary-preparation script uses `100755`.

The workflow name/branch/comments identify this separate guard repair; its correctness commands and gates are unchanged. This creates no new measured cohort and changes no component/browser study. Any subsequent concrete correctness failure must likewise retain its original evidence and use a separately reviewed source revision.

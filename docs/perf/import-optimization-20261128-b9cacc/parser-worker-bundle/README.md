# Parser worker bundle: prepared qualification handoff

**Pending; no complete-import performance conclusion or optimization PR.** This handoff preserves existing product source, diagnostics, validation failures, and prepared future qualification work. It launches no workflow, changes no branch/ref, and reruns no build, native call, test, import, or performance cohort. The earlier canonical evidence pack is unchanged.

The **2026-11-28 06:06 UTC snapshot** has corrected qualification [run 46110124022](https://github.com/ManabiIO/manabitan/actions/runs/46110124022) still queued, with Actionlint [46110123879](https://github.com/ManabiIO/manabitan/actions/runs/46110123879) separately identified. This is a recorded snapshot, not live status. Confirmation is unlaunched; its future reader deliberately has no workflow head or run bound.

## Source identities

| Role | Immutable source |
|---|---|
| Baseline | [9e10d3b3fcf66d344ab31bc42c9b522fa5215da2](https://github.com/ManabiIO/manabitan/commit/9e10d3b3fcf66d344ab31bc42c9b522fa5215da2) |
| Frozen runtime and qualification harness | [9da7dedd17535b4a0f8edb97e56756049bbad7a7](https://github.com/ManabiIO/manabitan/commit/9da7dedd17535b4a0f8edb97e56756049bbad7a7) |
| Corrected workflow only | [7d77b3858b4f3f37e651f770f8f3a92c59d77036](https://github.com/ManabiIO/manabitan/commit/7d77b3858b4f3f37e651f770f8f3a92c59d77036) |
| Clean six-file product extraction | [c0d62d7ef79e63fcf5c04968f2eab579ce3240a8](https://github.com/ManabiIO/manabitan/commit/c0d62d7ef79e63fcf5c04968f2eab579ce3240a8), unreferenced; tree `1c38abd37b182987a507cac1fead6c54aaa6d914` |
| Frozen confirmation draft | [50fcb1152888d8ec4ed1c4d3d1ecff3876f34185](https://github.com/ManabiIO/manabitan/commit/50fcb1152888d8ec4ed1c4d3d1ecff3876f34185), unreferenced; tree `3ef7ad617844c276ff086ff3efeaa1ddb6b31611` |
| Initial six-pair reader | [c7a18f22ff374503bbe73596552bb9d9f628fc2b](https://github.com/ManabiIO/manabitan/commit/c7a18f22ff374503bbe73596552bb9d9f628fc2b) |
| Future twelve-pair reader | [91f69660bc63d0faf2fed1fdeb2bb1919a272974](https://github.com/ManabiIO/manabitan/commit/91f69660bc63d0faf2fed1fdeb2bb1919a272974), unbound prospective source |

[product/identity.json](product/identity.json) binds the clean extraction's six file blobs and modes to the frozen runtime. [product/product.patch](product/product.patch), SHA-256 `b91526cb0c65a1b0007196c006f4218d751617ced763edc4bd38ff7b9f21ad44`, contains those exact changes without the four qualification-only files. The clean commit is prepared source, not a promoted or separately measured candidate.

The change builds a closed, same-directory, ES2020 ESM bundle from 23 first-party source modules and changes the parent Worker URL. That count includes the worker entry and 22 dependencies. Existing worker counts, initialization protocol, memory budgets, native code and storage formats are retained. [The independent source review](critical-path/independent-source-review.json) covers relative URLs, Firefox/Chrome CSP, module state, error propagation and cancellation. Its source review and simulated transport/native-WASM tests do not substitute for real browser qualification.

## Startup evidence and its boundary

The complete [startup harness](startup/parser-bundle-startup.mjs), [raw result](startup/parser-bundle-startup.json), and [metafile](startup/parser-bundle-startup.metafile.json) are preserved, together with the preceding loader screen. The raw result retains three warmup observations and six balanced ABC blocks, all requests and resource samples. A/C use identical baseline source. It measures parser readiness in fresh page contexts over localhost HTTP with `no-store`, within one browser process. It includes no dictionary parsing, OPFS, compression or complete import; browser/V8 process state may remain warm.

Within this startup-only cohort, B was faster than A and C in all six measured blocks. Arm medians were A 146.955 ms, B 29.8375 ms and C 130.790 ms. The identical-code controls also moved: median paired C/A change was **−17.46%**. That control drift stays part of the evidence; the result remains one component cohort.

**The startup probe and final product are not byte-identical.** The probe bundle is 174,292 bytes, SHA-256 `52c328efdee007eb5bd64227c19421dda9eac984d96a27df3a54837c9d5b6be0`. The final bundle is 174,314 bytes, SHA-256 `f6c0c2b6c19f686d1280cc0c456357a944208a2e9f56a588788a8da58e4611a6`. Its 22-byte difference has two recorded causes:

- A 15-byte generated `// @ts-nocheck` line and newline.
- Seven bytes adding `.bundle` to the embedded nested-pool Worker URL. The probe redirected the parent HTTP Worker request; its embedded URL still named the original worker, on a pool path guarded in the worker environment.

Only qualification using the final product bytes and production URL can establish product performance. Generated bundles are omitted here; their hashes are retained. [The critical-path analysis](critical-path/parser-bundle-critical-path.md) and [provenance](critical-path/parser-bundle-critical-path-provenance.json) use the existing exact-baseline trace and do not convert samples or startup savings into import-latency claims. Parser pools are disposed after each import; sequential imports exercise another pool lifetime while browser caches may persist.

## Original validation failure and workflow correction

[Run 46104747758](https://github.com/ManabiIO/manabitan/actions/runs/46104747758) failed the exact package-delta gate **before any import timing**. The baseline dependency directory was symlinked outside its source root, changing unrelated esbuild module labels and source-map paths. [The diagnosis](validation-failure/diagnosis.json), [small reproduction](validation-failure/dependency-path-reproduction.json), its script/diffs, build logs, and [workflow-only correction receipt](validation-failure/workflow-correction-publication.json) remain separate evidence.

An independent hardlinked dependency hierarchy reproduced identical library bytes. The correction preserved runtime `9da7`, the harness, timing command, matrix and exact package allowlist: only `js/dictionary/term-bank-wasm-parser.js` changes, only `js/dictionary/term-bank-wasm-parser-worker.bundle.js` is added, and nothing is removed. Both [original](validation-failure/original-audit-config.json) and [final](validation-failure/final-audit-config.json) audit configurations are preserved. This setup failure is not a product regression or a discarded performance observation.

## Pending promotion gates

1. **Finish and independently audit the six initial cells.** Require successful normal validation and Actionlint at the registered workflow head, exact source/package/bundle identities, complete fixed schedules, raw semantic/storage/media receipts, and independently qualified memory observations. Preserve failures and controls. The frozen 575-line initial reader, tests/config/workflow and existing **14 negative-control passes** are under `readers/initial/`; its filename still contains `v2`, while commit `c7a18f22…` fixes its identity.
2. **After independent audit of all six cells supports a promising JMdict gain and no repeated material Jitendex/VNDB regression, launch the fixed confirmation under the existing authorization.** No additional user permission is needed for that already authorized experiment. The final seven-file draft is under `confirmation/`, including its hidden `.github/workflows/` path. The existing receipt records **41 syntax/static checks**, not browser execution. Earlier plans under `confirmation/history/` remain historical; final registration fields control. The registration's parent-review condition describes internal evidence review. The corrected runtime/harness and all gates remain unchanged.
3. **Require confirmation on each of two fresh JMdict hosts, starting AB and BA.** Each fixed host has 12 candidate pairs, four identical-code control pairs, and two warmup pairs: 36 ordinary observations, of which 32 are measured. Each host must show at least 3% and 20 ms median paired saving, at least 10/12 faster candidate pairs, improved equal-work total, a descriptive 95% paired-percent bootstrap upper bound strictly below zero, and gain exceeding absolute median identical-code drift. Bootstrap seed 897 and 10,000 resamples are fixed. Do not pool hosts, subtract controls, replace samples, or add rescue cohorts.
4. **Pass separate memory and reliability gates.** Every memory observation must qualify; median paired increases must be at most 5%, with each individual paired increase at most 10%. Require unchanged all-media/semantic qualification, real Firefox Jitendex→JMdict imports with strict OPFS, no errors/skips and positive parallel worker/group evidence for both imports, and the unchanged Chromium restart oracle with source/package identity checks. A supported native fused-parser fallback is not an added zero-count requirement. The restart scenario does not independently establish parallel-parser cancellation coverage.

The separate future reader under `readers/future/` preserves its criteria/config and existing **15 synthetic checks**. Its `runId` and `workflowHead` remain `null`, and it rejects that unbound state before API access. No confirmation has been launched by preparing or packaging it. No PR is warranted until the independent complete-import and reliability evidence supports the user’s requested gain.

## Integrity and exclusions

[handoff-provenance.json](handoff-provenance.json) records full source commits, status snapshot, bundle identities, excluded asset hashes, and the public identity of the failed validation artifact. [source-aliases.json](source-aliases.json) maps every selected original path to byte-preserved content; duplicates, including criteria and fixture locks, are stored once. Original layouts can be reconstructed from that mapping or the immutable source commits. Historical status fields, absolute paths and raw observations are unchanged.

[PACK-MANIFEST.json](PACK-MANIFEST.json) hashes every file except itself. All seven final confirmation source hashes and eight initial-reader/dependency hashes were checked against existing receipts during packaging; no validation tests were rerun. Full dictionary inputs, generated/vendor bundles, bytecode caches, the artifact ZIP, and auxiliary transport/download metadata are excluded. Public GitHub references replace no source bytes. Raw localhost diagnostic request URLs remain as evidence, while signed transport URLs and credentials are excluded.

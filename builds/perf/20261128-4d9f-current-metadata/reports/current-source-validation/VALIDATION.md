# Current-parent metadata validation receipt

Candidate `81e203e084c009e79057a36d0e2106ef669ab168` has exactly the runtime from integration `fc431c38e5c614069e75652d60b3b5c50682986b`; its only followup splits properties onto separate lines in two accessor test fixtures. Parent is `f28c2801fcfd9416f220b46b9cbafeee901c1cb2`. The runtime/source inventory is in `validated-source-manifest.json`; every command, exit status, signal, Node identity, source tree and log hash is retained under `validation/` and summarized in `validation-summary.json`.

## Completed local gates

- Normal library build.
- Eleven focused metadata/canonical/source suites: 318 tests passed, including all seven new three-column integration controls.
- Main, development and benchmark TypeScript configurations passed.
- All-target dry build passed.
- Both actual Chrome release packages built successfully.
- Exact ZIP-entry audit passed: 554 identical entry names, 549 byte-identical entries, and only the intended database/scanner/arena JavaScript, canonical WASM, and corresponding shipped C source differ. No added or removed package entry.
- Four CRC tests passed after correcting the validation environment's pinned linker search path.

## Incomplete local gates and retained failures

The complete unit acquisition was terminated by **SIGKILL** after 364.59 seconds. Its log contains 423 passing-file markers, but no final Vitest JSON or complete-suite result. It is not a full-unit pass. The coordinator is running exact-runtime hosted full validation; no outcome from that run is assumed here.

Test TypeScript did not finish locally. The original npm command passed main and development configurations, then returned 137 while its test-type child printed `Killed`; that wrapper did not expose the child's terminating signal. A direct Node run with 1 GiB old-space produced explicit heap exhaustion and **SIGABRT**. A separate 2 GiB direct run received **SIGKILL** with no TypeScript diagnostic. Both remain separate observations, and no memory-pressure cause is asserted for SIGKILL.

The first scoped ESLint command reported only six formatting findings in the two accessor fixtures, all corrected by the test-only followup. The narrow corrected-file retry received **SIGKILL**. Thus local lint completion remains incomplete despite the straightforward formatting correction; normal hosted PR CI must complete it.

The partial unit log also showed four skipped CRC tests after setup failed. A separate minimal compiler probe demonstrated that extracted Clang 21.1.8 invoked `wasm-ld-21` through PATH, while the original validation PATH contained only the LLVM directory with unversioned `wasm-ld`. The exact versioned alias already existed under extracted `usr/bin`. Adding that same pinned directory to the validation-only PATH allowed all four CRC tests to pass. Product source, compiler binaries and compiler arguments were unchanged. The original driver, failed probe, compiler dry command and successful narrow control are retained.

The initial package audit expected only four runtime entries and omitted the C source which existing packaging also ships. It failed its allowlist assertion. The preserved first script/failure receipt and corrected audit make this assumption correction explicit; neither build nor package was modified to obtain the passing audit.

## Package identities

| Arm | Source | ZIP bytes | SHA-256 |
| --- | --- | ---: | --- |
| Parent A | f28c2801 | 17,291,235 | `5f333553e89ffcc71d264e82504889f6cc3194625c8e195eb9ca0c41445ad9c6` |
| Candidate B | 81e203e0 | 17,293,651 | `3d3e965e37372dc4425a88262ecc288f8b6f695687dee04fdf0e7c7ed97641f8` |

Full per-entry sizes/hashes are in `package-audit.json`. These are release package correctness/identity checks, not an import performance acquisition. Current-parent corpus parity/allocation evidence and hosted browser/full-validation evidence are separately acquired by the coordinator and other agents; earlier dcfc/55e results are not relabelled as current-parent results.

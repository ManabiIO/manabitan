# Capacity-dispatched sequence64 study: performance unqualified

This separate research record preserves the baseline-only admission census, the new Design B source and exact production artifacts, successful correctness qualification, static code inspection, and the single incomplete timing acquisition. It is not an optimization PR and makes no import-speed or memory-gain claim. The product baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. See `RESULT.md` for the disposition and exact limits.

## Verify the saved record

Run `python3 verify.py` in this directory. It verifies every part's SHA-256 and Git blob SHA-1, the assembled archive, every archive member, and each logical file identity. It independently recomputes census ownership/eligibility, direct and API-capacity check counts, routing totals, frame/result relationships, exact binary code isolation, and the incomplete zero-observation disposition. No network access, compiler, native module, browser, or benchmark executes.

To restore the logical evidence into a new directory, run `python3 verify.py --extract restored-design-b`. The archive contains `manifest.json` and content-addressed `blobs/<sha256>` members. Identical bytes are stored once; `index.json` includes every original logical file's size and SHA-256. Parts are at most 256 KiB. Historical symlink targets are recorded as metadata; selected alias files restore as regular files, and omitted payloads are not materialized.

The verifier audits saved evidence. It does not regenerate compressed frames from omitted inputs or rerun the original native correctness checks. Aggregate frame SHA values are bound to the original reports; counts, per-frame equality, and ownership arithmetic are independently checked from the retained rows.

## Scope and omissions

The record includes source/freeze/invocation files, original logs, compiled baseline/B1/probe/census WASM, all fresh correctness reports, both integration-plan versions, changed function/loop WAT, the exact partial timing JSON and termination receipt, independent reviews, and the final report. Reused baseline correctness metadata remains explicitly identified; rejected B0 was not executed in this study. The separate checked64 rejection record remains at research commit `aefc3ef11c00f4a87911b97757a7001fe75b2645`, under `dev/perf/zstd-sequence64-rejected-7c02`.

Full canonical content and dictionary payloads, SDK/package binaries, generated amalgamations, and full-module WAT are omitted. Their identities, metadata, public source pins, original source transformations, reconstruction scripts, and omission reasons remain in the index or retained receipts. This is a complete saved-result audit, not a portable one-command fresh acquisition.

The investigation ledger is an explicitly frozen snapshot supplied by the parent at **2026-11-28 07:19:07 UTC**, SHA-256 `a97cdcc29a6ab0b724b79f08d1c8c5dab96196166b9c61a3c194dd1fe878dafd`. Its browser-campaign queue status was last observed at 07:13:09 UTC. It does not assert that this status remains current.

The timing process was killed before any observation was recorded. Its exact termination phase and cause are unknown. Successful census, correctness, and code-generation evidence does not supply the missing performance qualification.

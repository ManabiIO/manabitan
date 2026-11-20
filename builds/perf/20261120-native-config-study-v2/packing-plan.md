# Final native-v2 evidence packing plan

This recipe is prepared while the fixed browser study is still completing. It is
post-measurement evidence assembly, not a runtime change or new performance
cohort. Running `pack-evidence.py` without `--execute` prints the plan and writes
nothing. Execution is gated on all four completed original cohorts, independent
audits, browser summaries, Firefox extraction receipts, and the root analysis,
analysis log and assembly-attempt receipt.

## Exact coverage

| Archive prefix | Retained source |
| --- | --- |
| `chromium-forward`, `chromium-reverse`, `firefox-forward`, `firefox-reverse` | Every file payload in each original v2 result ZIP; artifact IDs, ZIP hashes and actual counts are taken from the independently audited download receipts and checked against the original contents |
| `browser-provenance` | Complete round5 acquisition and audit scripts, download/job/log receipts, full job logs, audit outputs and script copies, source probes, per-browser summaries, official Firefox runtime identity/reuse receipts and safe extraction receipts |
| `native-component-validation` | Entire frozen native candidate component and correctness directory, including all observations, controls, source pins, patch, original setup failures, direct ABI evidence, emitted assembly, all full-unit/type/lint/dry-build/rebuild logs and receipt |
| `packaging-erratum-and-reviews` | Original packaging correction plus pre-freeze and sealed v2 reviews; this explicitly corrects the old WASM-only package claim without editing the original native notes |
| `study-tooling-v2` | Frozen manifest/preflight identities, package-map fixture checks, all local validation logs/receipts, preserved-v1 file identities, isolated workflow trigger checks and measured-source CI receipt |
| `compression-audit` | Unchanged source audit, original recorder and frozen receipt |
| `compression-source-snapshot` | Exact inspected upstream files with original notices, BSD LICENSE and GPLv2 COPYING, retained fixture/audit metadata, source mapping receipt and posthoc offline classifier/result |
| `analysis` | Root four-cell analysis, complete analysis log and assembly-attempt receipt, including unsuccessful attempts if any |
| `packing` | This plan, the exact packing recipe and the unchanged evidence utility |
| `local-toolchain`, `setup` | LLVM package/index/environment pins, pinned actionlint receipt and initial dependency/library setup logs |
| `prior-v1` | Identity, coverage and packing receipts for the separately preserved failed-v1 archive |
| `extras` | Scope/exclusion explanation and credential-pattern review receipt |

The candidate source bundle, full patch, measured driver/workflow and all 54
harness inputs are retained inside every original browser payload set. The
candidate product source is not replaced by the final documentation checkout.

## Exclusions and integrity

The original ZIP containers are excluded from the tarball; every file payload is
retained byte-for-byte, with the original ZIP SHA256, byte count and CRC-bearing
member mapping preserved. Duplicate extracted trees, Python caches and mutable
publication state are excluded. The failed-v1 archive remains separate and
unchanged. Large reproducible dependencies, full Git checkouts, the official
Firefox runtime archive and the original JMdict archive are not duplicated;
their pins and the observed verification receipts remain available.

No evidence is silently redacted. Before packing, selected text is checked for
credential patterns without printing matched values. Only previously identified
public fixture URL/test literals are classified as non-secret. A new finding
stops assembly for review. All selected file names and bytes are hashed before
and after packing, including generated pre-pack supplemental receipts. The
unchanged utility verifies every retained tar payload. A separate coverage pass
then compares every original ZIP member with its archive index record and
requires complete equality of the represented member sets. Payload counts are
derived, never assumed from an earlier study.

## Commands

After root confirms all four cells and analysis are frozen:

```sh
python3 builds/perf/20261120-native-config-study-v2/pack-evidence.py --execute --workspace /path/to/workspace
python3 dev/perf/import-study-evidence.py verify builds/perf/20261120-native-config-study-v2/native-evidence.tar.xz
```

`native-evidence.tar.xz.json`, `artifact-coverage.json`, `packing-receipt.json`,
`packing.log` and `verification.log` remain alongside the archive to avoid a hash
cycle. Any packing failure is retained separately and no output is overwritten.
An independent reviewer will check the final original-ZIP coverage afterward.

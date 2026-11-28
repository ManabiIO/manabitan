# Frozen JMdict baseline: profile core and findings

This small evidence package preserves the existing JMdict baseline receipts and later profile summaries supporting [five study findings](FINDINGS.md). It records a baseline investigation, not a candidate speedup. No import, benchmark, test, native module or trace analysis ran while preparing this package.

## Provenance

- Product source: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`, tree `d99ea4d04658f7ec1c76acdc5f3684594212a471`.
- Acquisition: [Actions run 46102820124](https://github.com/ManabiIO/manabitan/actions/runs/46102820124), JMdict job `140848885601`, attempt 1. Published research wrapper/workflow commit: `dcabc5f2bb5f720d598da3f5aebd90367ef98c4f`; only research files differ from production.
- Runtime: Node 22.22.0, Chromium 153.0.8010.12; native artifact toolchain Clang/LLD 21.1.8. This environment is distinct from the separately described local Node 24 component studies.
- Fixture: JMdict.2026-11-22, 528,299 rows, no media; ZIP SHA-256 `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`.
- Original Actions artifact: `15246484756`, 17,389,650 bytes, ZIP SHA-256 `f142fed755878a6e4f6bfbb02efb30b35084872922f11af251a2668440ee311a`. Its recorded expiry is 2026-12-12. The exact original artifact metadata is retained in [artifact-manifest.json](artifact-manifest.json).

The fixed acquisition was ordinary-before, one diagnostic trace, then ordinary-after, each attempted once. All three passed their existing semantic, restart and lookup checks. The two ordinary imports took 959.9 ms and 861.2 ms with identical code; their −10.28% difference describes those controls only. The traced import's 1,349.3 ms is explicitly non-authoritative for latency. No candidate gain or general host-noise distribution follows from these three observations.

## Measurement meanings

| Record | Meaning and limit |
| --- | --- |
| Ordinary browser import total | Elapsed end-to-end import time for that observation. |
| Exposed parse interval | The phase duration exposed on the import path; not the sum of all parser workers. |
| Summed native parser/inflate durations | Worker-reported wall durations added across concurrent workers. They are not measured CPU time and can exceed the exposed phase. |
| Compression, bulk-add, publication and finalization counters | Reported phase durations; nesting and overlap prevent adding them into a new total. |
| Native self-sample interval weights | Diagnostic attribution across overlapping profiles, retaining signed negative deltas and long scheduling intervals. They are neither measured CPU milliseconds nor promised removable latency. |
| Component CPU results cited in FINDINGS.md | Separately measured process CPU for their declared component intervals. They do not replace browser elapsed time or quantify whole-import gains. |

## Contents and exact preservation

[index.json](index.json) gives every payload's size, SHA-256, Git blob SHA-1 and original source locator. The index excludes itself to avoid a circular hash.

- `BASELINE-PROFILE-REPORT.md`, `all-dictionary-profile-compact.json`, `jmdict-receipts.json`, `native-profile-compact-corrected.json` and `artifact-manifest.json` are exact copies of the existing files. Original corrections, limitations and references remain unchanged.
- [jmdict.trace.json.gz](jmdict.trace.json.gz) preserves the existing gzip byte for byte: 457,857 bytes, SHA-256 `bc6d895b287f6e6cf5bab795f5f613bc39c0d2fc90efd0ca5115549b86a4a1be`. Its header already has mtime 0 and no stored filename. Decompression was checked against the original trace receipt: 5,014,171 bytes, SHA-256 `9713413c3406f1d664bedc5a7fa2934f6049fee4f8f5946e2bd4b63eec531e0f`. No trace event or interval was rewritten.
- [analyze-validator-stack.py](analyze-validator-stack.py) is the original attribution script, copied without executing it. It groups process/profile IDs and preserves exporter-thread relationships. [baseline-symbols.json](baseline-symbols.json) is the original 51-function name map and recorded proof that the named diagnostic module's noncustom sections match the production parser. This is the saved proof receipt; native binaries were not rebuilt or compared during packaging.
- `findings-original.md` preserves the original explanation, including its historical statement that these files had not yet been published.
- `FINDINGS.md` changes only that publication-status paragraph and baseline evidence links to point to included files. Its findings, measurements and inferences are unchanged.
- This README and the index describe packaging and provenance only.

The report, phase summary and native map include other dictionaries for context; this core contains the full tagged ordinary/trace receipts and raw trace only for JMdict. Historical paths in original reports are provenance, not a claim that every referenced file is included here. The original hotspot receipt remains unchanged; the separate corrected map uses the later complete process/profile grouping described in the report. The included analysis script is not presented as a complete generator for every later summary.

## Deliberate omissions

The full Actions ZIP, built extension, fixture, native diagnostic binaries and other dictionaries' full receipts/traces are not included. The retained source metadata identifies those inputs and the original artifact. That artifact's hosting expiry does not affect this durable copy of the JMdict trace and receipts. The package remains a saved-observation core rather than a complete fresh profiler-acquisition environment.

The package supports inspecting the preserved phase/measurement facts, raw trace, original analysis and explanation's scope. Packaging did not execute the analysis or independently reconstruct the sampling calculations. Failed and incomplete candidate studies cited in FINDINGS.md retain their separate immutable evidence and dispositions.

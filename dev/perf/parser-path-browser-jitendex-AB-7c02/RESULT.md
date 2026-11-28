# Jitendex AB: mandatory host screens passed; no speedup established

The independent saved-data audit passed for job **140904689410**, artifact **15256555705**, in [run 46113567719](https://github.com/ManabiIO/manabitan/actions/runs/46113567719). This confirms one host's correctness, sampled-memory, identical-control and nonregression screens. Workflow success and this per-host pass do not qualify the full campaign or a PR.

## Recomputed ordinary latency

| Metric | Independent result | Frozen gate | Disposition |
| --- | ---: | ---: | --- |
| Median paired B/A change | -0.885670% | ≤+3% | Pass |
| Equal-work B/A change | -0.056727% | ≤+3% | Pass |
| Descriptive bootstrap interval | [-2.167506%, +1.590214%] | Upper endpoint≤+5% | Pass |
| Identical C/A median drift | +0.422744% | Absolute value≤5% | Pass |
| Faster B/A pairs | 7/12 | No additional nonregression count gate | Retained |
| Worst B/A pair | +9.813959% | Original aggregate gates | Retained |

B's median versus the four identical-C observations was **-0.579230%**. All saved statistics were reproduced exactly from the complete original pairs, with seed 897 reset for each 10,000-resample descriptive bootstrap and sorted endpoints 249/9749. The interval includes zero, and no whole-import gain is established. The campaign's stronger speed-claim gate applies to both VNDB hosts. No outlier, tie or failed observation was filtered or replaced; hosts were not pooled and control drift was not subtracted.

## Separate sampled memory

| Metric | Median paired change | Maximum paired change | Frozen limits | Result |
| --- | ---: | ---: | --- | --- |
| Whole discovered browser-tree PSS | -2.667127% | -1.858420% | Median≤5%; every pair≤10% | Pass |
| Whole discovered browser-tree private bytes | -3.372753% | -2.174721% | Median≤5%; every pair≤10% | Pass |

The unchanged pure memory auditor revalidated **271 raw scans** and every retained marker, process-tree/readability qualification, coverage result, maximum and pair. All four ABBA observations qualified, with 10–11 stable fully read scans wholly inside each import window. The largest covered gap was 205.333747 ms, below 250 ms; both bracket limits passed. These non-atomic sampled maxima are not exact memory peaks. Instrumented durations never entered ordinary statistics.

## Complete source and semantic checks

- All **42 imports** matched the original acquisition: the exact 36-slot ordered ID/kind/pair/arm schedule, A then B exhaustive-media imports, then the exact four-slot ABBA memory schedule. The ordinary schedule contains four excluded warmups, twelve A/B pairs and four interleaved A/C pairs.
- Both 554-entry package maps and ZIP digests were rehashed against the retained identities. The only differing entries are the two registered parser/worker JavaScript files. Source commits/trees, frozen harness hashes, dependency and fixture locks, parser/codec WASM and the memory overlay match. Baseline/control is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`; candidate is `e90c4c04172b691985858609094887f9541541dd`.
- All summary/raw/canonical bindings passed the unchanged pure validators. Every import used Node 22.22.0, Chromium 153.0.8010.12/revision1243, production default flags and three parser workers. Fresh profiles are bound to the unchanged per-invocation mkdtemp harness. The browser binary digest is captured acquisition provenance; that binary is not included for independent rehashing.
- All imports retained **436,555 rows**, twelve distinct content probes, **72 lookup observations**, restart/readback and matching semantic output. Canonical storage inventories and exact logical sizes matched across all observations: **67,466,332 bytes**. Each exhaustive receipt covers all 236 unique media files and 4,992,155 bytes; both match SHA-256 `74aeb87663f4b89600affca40005fab432058227cd3fcb31c9f74d19a72a0402`. Ordinary sample checks cover 64 files.
- All ordinary sources were clean; only the exact separately hashed memory marker overlay was dirty. No writing helper CLI or acquisition runner was executed by the audit.

## Artifact and derived audit identities

The original artifact ZIP is **35,590,927 bytes**, SHA-256 `82ab640cdc6aec23a033dc3960cfe7e26bb1cc778d22c5efa602eddd4f81ff46`, bound to research commit `d36ee85feb1513af31f769175affa33b3696a307`. All **317 members/56,163,582 expanded bytes** matched original ZIP CRCs and SHA-256. Every extracted original and the ZIP were rehashed afterward and remained unchanged.

[Independent audit](independent-audit.json): `3f64181d1364ce47330af2afe4315db65dfe881cec7a7190faf35404e75568a6`. [Saved-data script](audit.py): `d59c23e793bfe7f6fcce09c500c78aad635c0cfc3a5ab718155152267b0a7a5b`. The script's identity/order/fixture-only adaptation from the previously published JMdict BA auditor is recorded in [adaptation.json](adaptation.json) and [adaptation.diff](adaptation.diff); all calculations, helpers and gates are unchanged.

No benchmark, browser, native module, test, replacement acquisition or threshold change occurred.

A local audit-launch command first used a nonexistent directory and exited 2 before the auditor executed. That setup error is retained in [audit-invocation-setup.json](audit-invocation-setup.json). Correcting only the command path ran the unchanged saved-data audit; no acquired observation was repeated.

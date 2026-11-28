# JMdict AB: mandatory host screens passed; no speedup established

The independent saved-data audit passed for job **140904689380**, artifact **15256162585**, in [run 46113567719](https://github.com/ManabiIO/manabitan/actions/runs/46113567719). This confirms one host's correctness, sampled-memory, identical-control and nonregression screens. Workflow success and this per-host pass do not qualify the full campaign or a PR.

## Recomputed ordinary latency

| Metric | Independent result | Frozen gate | Disposition |
| --- | ---: | ---: | --- |
| Median paired B/A change | -1.079949% | ≤+3% | Pass |
| Equal-work B/A change | -0.755171% | ≤+3% | Pass |
| Descriptive bootstrap interval | [-1.717099%, +0.448242%] | Upper endpoint≤+5% | Pass |
| Identical C/A median drift | -0.106520% | Absolute value≤5% | Pass |
| Faster B/A pairs | 8/12 | No additional nonregression count gate | Retained |
| Worst B/A pair | +1.770039% | Original aggregate gates | Retained |

B's median versus the four identical-C observations was **+0.150333%**. All saved statistics were reproduced exactly from the complete original pairs, with seed 897 reset for each 10,000-resample descriptive bootstrap and sorted endpoints 249/9749. The interval includes zero, and no whole-import gain is established. The campaign's stronger speed-claim gate applies to both VNDB hosts. No outlier, tie or failed observation was filtered or replaced; hosts were not pooled and control drift was not subtracted.

## Separate sampled memory

| Metric | Median paired change | Maximum paired change | Frozen limits | Result |
| --- | ---: | ---: | --- | --- |
| Whole discovered browser-tree PSS | +0.409559% | +0.805554% | Median≤5%; every pair≤10% | Pass |
| Whole discovered browser-tree private bytes | +0.467553% | +1.093740% | Median≤5%; every pair≤10% | Pass |

The unchanged pure memory auditor revalidated **307 raw scans** and every retained marker, process-tree/readability qualification, coverage result, maximum and pair. All four ABBA observations qualified, with 8–10 stable fully read scans wholly inside each import window. The largest covered gap was 120.658155 ms, below 250 ms; both bracket limits passed. These non-atomic sampled maxima are not exact memory peaks. Instrumented durations never entered ordinary statistics.

## Complete source and semantic checks

- All **42 imports** matched the original acquisition: the exact 36-slot ordered ID/kind/pair/arm schedule, A then B exhaustive-media imports, then the exact four-slot ABBA memory schedule. The ordinary schedule contains four excluded warmups, twelve A/B pairs and four interleaved A/C pairs.
- Both 554-entry package maps and ZIP digests were rehashed against the retained identities. The only differing entries are the two registered parser/worker JavaScript files. Source commits/trees, frozen harness hashes, dependency and fixture locks, parser/codec WASM and the memory overlay match. Baseline/control is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`; candidate is `e90c4c04172b691985858609094887f9541541dd`.
- All summary/raw/canonical bindings passed the unchanged pure validators. Every import used Node 22.22.0, Chromium 153.0.8010.12/revision1243, production default flags and three parser workers. Fresh profiles are bound to the unchanged per-invocation mkdtemp harness. The browser binary digest is captured acquisition provenance; that binary is not included for independent rehashing.
- All imports retained **528,299 rows**, twelve distinct content probes, **72 lookup observations**, restart/readback and matching semantic output. Canonical storage inventories and exact logical sizes matched across all observations: **43,520,477 bytes**. JMdict has no media; both exhaustive receipts match the empty inventory and SHA-256.
- All ordinary sources were clean; only the exact separately hashed memory marker overlay was dirty. No writing helper CLI or acquisition runner was executed by the audit.

## Artifact and derived audit identities

The original artifact ZIP is **35,606,138 bytes**, SHA-256 `2bc83e741b11967bc9c034da28ef87ae40df7d45be0e1b47e3fdccfbef47838f`, bound to research commit `d36ee85feb1513af31f769175affa33b3696a307`. All **317 members/57,533,278 expanded bytes** matched original ZIP CRCs and SHA-256. Every extracted original and the ZIP were rehashed afterward and remained unchanged.

[Independent audit](independent-audit.json): `5dd9fbd711c5b293a795636e01e9633c8a517c2dd80511df5a39f93e817c023d`. [Saved-data script](audit.py): `123767edfbff36f47737b9efab7b672a4812666fe0af8d2cefd65beb85d43212`. The script's identity/order/fixture-only adaptation from the previously published JMdict BA auditor is recorded in [adaptation.json](adaptation.json) and [adaptation.diff](adaptation.diff); all calculations, helpers and gates are unchanged.

No benchmark, browser, native module, test, replacement acquisition or threshold change occurred.

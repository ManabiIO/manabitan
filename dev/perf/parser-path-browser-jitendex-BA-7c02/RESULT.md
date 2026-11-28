# Jitendex BA: mandatory memory coverage failed

The independent saved-data audit completed successfully for job **140904689455**, artifact **15256069414**, in [run 46113567719](https://github.com/ManabiIO/manabitan/actions/runs/46113567719). All source, schedule and semantic checks reproduce, but this host **fails the frozen mandatory publication gates**. Baseline memory observation A1 has a covered-import-scan gap of **369.393278 ms**, above the registered **250 ms** limit. The original acquisition failure was not a misreading. This is invalid memory coverage; it is **not evidence of a memory increase**.

## Complete ordinary latency, retained descriptively

| Metric | Independent result | Frozen ordinary bound | Disposition |
| --- | ---: | ---: | --- |
| Median paired B/A change | +1.838139% | ≤+3% | Within bound |
| Equal-work B/A change | +2.892601% | ≤+3% | Within bound |
| Descriptive bootstrap interval | [-0.064187%, +4.023406%] | Upper endpoint≤+5% | Within bound |
| Identical C/A median drift | +3.153248% | Absolute value≤5% | Within bound |
| Faster B/A pairs | 3/12 | No additional nonregression count gate | Retained |
| Worst B/A pair | +15.457551% | Original aggregate gates | Retained |

B's median versus the four identical-C observations was **-0.140336%**. The control's equal-work change was **+5.352226%**, with a **+14.407869%** worst pair; the frozen control gate uses its absolute median, not these other statistics. All saved statistics were independently reproduced exactly from the full original pairs, with seed 897 reset for each 10,000-resample descriptive bootstrap and sorted endpoints 249/9749. The interval includes zero. No whole-import gain is established.

Passing the ordinary numerical bounds alone cannot pass the mandatory nonregression gate: that gate also requires valid memory coverage. It remains **false**, as do correctness-and-memory and whole-import-gain. The exact schedule and unchanged-control gates are true. No outlier, tie, failed memory slot or host was filtered, replaced, pooled or adjusted using control drift.

## Raw memory validity failure

| Memory slot, in original order | Stable complete contained scans | Maximum covered gap | Coverage status |
| --- | ---: | ---: | --- |
| B1 | 12 | 186.073497 ms | Valid |
| A1 | 11 | **369.393278 ms** | **Invalid** |
| A2 | 11 | 199.178649 ms | Valid |
| B2 | 10 | 212.140942 ms | Valid |

The unchanged pure memory auditor revalidated **all 276 raw scans**, every original marker, process-tree/readability qualification, complete coverage summary and pair. All imports exited successfully, and the saved semantic-failure list is empty. A1 meets the minimum-five-scan and pre/post bracket requirements, but its exact failure reason is `covered-import-scan-gap-over-250ms`. Failed/readability scans remain in the evidence; no missing measurement was replaced by zero.

A1's PSS and private-byte maxima correctly remain null. Consequently, the first pair is unqualified and **both complete-cohort aggregate metrics remain null**. The second pair's available measurements do not substitute for the missing valid pair. The ≥5 complete scans, ≤250 ms brackets/gap, median≤5% and every-pair≤10% requirements were not relaxed. These non-atomic sampled observations do not establish exact memory peaks, and the invalid cohort supports no aggregate memory increase or decrease claim. Instrumented durations never entered ordinary latency statistics.

## Complete source and semantic checks

- All **42 imports** match the original acquisition: the exact 36-slot ordered ID/kind/pair/arm schedule, B then A exhaustive-media imports, and the exact four-slot BAAB memory schedule. The ordinary schedule contains four excluded warmups, twelve A/B pairs and four interleaved A/C pairs.
- Both 554-entry package maps and package ZIP digests were rehashed. The only differing entries are the two registered parser/worker JavaScript files. Commits, trees, frozen harness hashes, dependency/fixture locks, parser/codec WASM and the exact marker overlay all match. Baseline/control is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`; candidate is `e90c4c04172b691985858609094887f9541541dd`.
- All summary/raw/canonical bindings passed the unchanged pure validators. Every import used Node 22.22.0, Chromium 153.0.8010.12/revision1243, production defaults and three parser workers. Fresh profiles are bound to the unchanged per-invocation mkdtemp harness. The browser binary digest is captured acquisition provenance; the executable is not included for independent rehashing.
- Every import retained **436,555 rows**, twelve distinct content probes, **72 lookup observations**, restart/readback and matching semantic output. Canonical storage inventories and exact logical sizes agree throughout: **67,466,332 bytes**. Both exhaustive receipts cover all **236 unique media files/4,992,155 bytes**, matching SHA-256 `74aeb87663f4b89600affca40005fab432058227cd3fcb31c9f74d19a72a0402`. Ordinary media checks cover 64 files.
- Ordinary sources were clean; only the separately hashed memory-marker overlay was dirty. No acquisition runner or writing helper CLI was executed by this audit.

## Artifact and derived audit identities

The original artifact ZIP is **35,601,135 bytes**, SHA-256 `8b1154e433540eb3a9cf8c0bbf24f03b180362dd7ec5a98cd8f836fb7ae0dce6`, bound to research commit `d36ee85feb1513af31f769175affa33b3696a307`. All **317 members/56,449,910 expanded bytes** match original ZIP CRCs and SHA-256. Every original member and the ZIP were rehashed after the audit and remained unchanged.

[Independent audit](independent-audit.json): `07f695da30e54321a03027d03f7b010bdc7550b262b320f25d02dadd7eb3f61d`. [Saved-data script](audit.py): `fd6b522d8025345ae80ff7a5ec26a12bfff18da27216f8e6e5a66bbc419e42f8`. [adaptation.json](adaptation.json) and [adaptation.diff](adaptation.diff) preserve the exact changes from the prior Jitendex AB auditor: identities and order, plus failure-aware memory checks that preserve invalid slots and apply the unchanged policy. All ordinary calculations, bootstrap and gate formulas are unchanged. The audit's successful execution means the saved failed result is verified; it does not mean the candidate qualifies.

No benchmark, browser, native module, test, acquisition retry, replacement observation, criterion change or threshold change occurred.

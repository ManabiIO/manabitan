# JMdict BA: mandatory host screens passed; no speedup established

The independent saved-data audit passed for JMdict BA, job **140904689347** in [run 46113567719](https://github.com/ManabiIO/manabitan/actions/runs/46113567719). It confirms this host's correctness, sampled-memory, identical-control and nonregression gates. It does not qualify the six-host campaign or a PR, and it establishes no JMdict whole-import gain.

## Recomputed per-host decisions

| Ordinary latency metric | Recomputed result | Frozen requirement | Result |
| --- | ---: | ---: | --- |
| Median paired B/A change | +0.023828% | ≤+3% | Pass |
| Equal-work B/A change | +1.804963% | ≤+3% | Pass |
| Descriptive bootstrap interval | [−3.403300%, +4.519511%] | Upper endpoint ≤+5% | Pass |
| Identical C/A median change | −1.065102% | Absolute value ≤5% | Pass |
| B/A faster pairs | 6/12 | No additional nonregression count gate | Retained |
| Worst B/A pair | +23.866401% | Retained under original aggregate gates | Retained |

All saved ratios, counts, medians, equal-work changes, worst pairs, faster counts and bootstrap endpoints were reproduced exactly from the 36 original ordinary observations. Each bootstrap independently used seed 897, 10,000 complete-pair resamples and sorted indexes 249/9749. No observation was filtered, replaced, pooled across hosts or adjusted by control drift. The saved stronger gain flag is false; the campaign's stronger speed-claim requirement applies to both VNDB hosts.

| Separate sampled-memory metric | Median paired change | Maximum paired change | Frozen limits | Result |
| --- | ---: | ---: | --- | --- |
| Whole discovered browser-tree PSS | −0.554996% | +0.554240% | Median ≤5%; every pair ≤10% | Pass |
| Whole discovered browser-tree private bytes | −0.693174% | +1.093863% | Median ≤5%; every pair ≤10% | Pass |

The original pure memory auditor revalidated **463 raw scans** and every original marker, process-tree/readability qualification, coverage calculation and maximum. All four BAAB observations qualified, with 7–10 stable fully read scans wholly within each import window. The largest covered gap was 176.184969 ms, below 250 ms. Both bracket limits passed. These are non-atomic sampled maxima, not exact peaks; their instrumented durations were excluded from all ordinary latency calculations.

## Exact provenance and semantic coverage

- The entire **36-slot ordered schedule** matched the frozen plan by ID, kind, pair and arm: four excluded warmups, twelve A/B pairs and four interleaved A/C pairs. The separate all-media order was B then A, followed by the exact four-slot BAAB memory schedule. All **42 imports** were checked.
- Baseline/control source is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`; candidate is `e90c4c04172b691985858609094887f9541541dd`. Both 554-entry package maps and archive digests were rehashed. Exactly the two declared parser/worker JavaScript entries differ. Native modules, lockfiles and frozen harness/source hashes match.
- Every summary, raw report and stored canonical receipt passed the unchanged pure validators. Node is v22.22.0, Chromium is 153.0.8010.12/revision1243, flags are production defaults and parser workers are three. The actual browser binary digest is the acquisition's captured identity; the binary itself is not in this artifact for independent rehashing.
- Every import retained **528,299 rows**, twelve distinct content probes, **72 lookup observations**, restart/readback, exact semantic output and exact canonical storage sizes. Storage was **43,520,477 bytes** throughout. JMdict has zero media; sample and exhaustive receipts both verified the correct empty inventory/digest. Ordinary sources were clean; only the exact separately hashed memory-marker overlay was dirty.
- Fresh profiles are bound to the unchanged per-invocation `mkdtemp` harness. No acquisition runner or writing helper CLI was imported or executed during this audit.

## Preserved evidence

Artifact **15256246047** is the original 35,781,708-byte ZIP, SHA-256 `3a39c24c411fadf7f1791aa119816c14c85e8a6d518b70bed74f9244b613c75b`, bound to research commit `d36ee85feb1513af31f769175affa33b3696a307`. All **317 members / 64,054,076 expanded bytes** matched their original ZIP CRCs and SHA-256 values. Every extracted file and the ZIP were rehashed after the audit and remained unchanged.

The complete independent receipt is [independent-audit.json](independent-audit.json), SHA-256 `60f676d3be3113f33a724952b706d0f6c79bca4257a2a667c8bb133e0d48e5e1`. Its retained script is [audit.py](audit.py), SHA-256 `eec86ccadfaf79cc2db559b47c95df130009196f40946167ef62b61cf5decb26`. These are derived audit records, separate from the original acquisition. No benchmark, browser, native module, test, replacement run or threshold change occurred.

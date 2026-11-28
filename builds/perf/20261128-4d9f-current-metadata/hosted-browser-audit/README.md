# Complete audit of the frozen f28 metadata browser cohort

All six cells passed their semantic audit: **252 checks** across JMdict, Jitendex and VNDB. **Five of six memory screens passed. VNDB BA is unqualified because two observation windows exceed the registered 250 ms sampling-gap limit.** The elapsed results do not establish a repeated speed gain, and the memory observations do not establish a repeated process-peak gain.

This report applies to the exact f28-versus68b sources below. It is not qualification of the later a300 integration.

## Source and evidence

| Item | Identity |
|---|---|
| Baseline | `f28c2801fcfd9416f220b46b9cbafeee901c1cb2` |
| Candidate | `68b29e5a959470e76ff67a93ec8b300cc53f1254` |
| Candidate tree | `167af1110023e4febad62921e13244b2c8bcb93c` |
| Equivalent local candidate | `81e203e084c009e79057a36d0e2106ef669ab168` |
| Browser | Chromium `153.0.8010.12` |
| Original cohort | Actions run `46135718522` |
| Preservation and final VN audits | Actions run `46139005895` |
| Public preservation commit | `e54f8f55e6a493a13f2e7ab2cd8c06317d513800` |
| Unchanged independent audit SHA256 | `83f6c2eabcd31232dade45596c5df833fe87879e095267cda250aa44780347ee` |

The complete machine index is [browser-audit-all-six.json](browser-audit-all-six.json). It retains every candidate/control ratio, full-precision statistics, cell-specific package digests, source hashes, memory totals, failed observations and archive receipts. [input-receipts.json](input-receipts.json) binds this assembly to the original first-four local audit and the exact public files used for the final two cells.

Original raw evidence, complete artifact member inventories, package inventories and the frozen audit source are published at [the preservation commit](https://github.com/ManabiIO/manabitan/tree/e54f8f55e6a493a13f2e7ab2cd8c06317d513800/builds/perf/20261128-4d9f-hosted-evidence). Every downloaded outer artifact was SHA-checked. The deterministic archives retain all original nonpackage members byte for byte; a product ZIP was omitted only after its complete archive hash and every entry matched the in-artifact proof. The preservation workflow's eight offline contract tests passed.

No browser imports were rerun to produce this report. The first four completed local audits remain unchanged. The final VN AB and BA cells were independently recomputed with the same frozen audit program during preservation, including raw memory scans, semantic receipts, schedules, exact package inventories and descriptive statistics. This assembly checks those source bindings and copies the accepted results; it does not replace an observation or relax a gate.

The original first-four input is included byte for byte as [first-four-independent-audit.json](first-four-independent-audit.json). To reproduce the assembly after fetching the preservation commit into a repository clone, run:

```sh
python3 assemble-current-browser-audit.py \
  --repository /path/to/manabitan \
  --first-four-audit first-four-independent-audit.json \
  --output /path/to/new-output-directory
```

The output directory must not already exist. The helper reads immutable Git objects and recorded observations only; it does not launch the browser or a benchmark.

## Elapsed observations

Negative changes favor the candidate. Each cell contains twelve candidate pairs and four identical-code control pairs. The registered schedule and all warmup observations remain in the raw archives. Intervals below are the protocol's descriptive bootstrap intervals, not proof of a repeatable effect.

| Dictionary / order | Median change | Equal-work change | Faster pairs | Descriptive 95% interval | Control median |
|---|---:|---:|---:|---:|---:|
| JMdict AB | +1.329624% | +0.097437% | 5/12 | [−2.060986%, +2.040667%] | +0.065123% |
| JMdict BA | −0.334945% | −6.339081% | 9/12 | [−4.836117%, +0.156270%] | +0.622673% |
| Jitendex AB | +0.291010% | +2.041304% | 5/12 | [−0.428381%, +5.140601%] | −1.705415% |
| Jitendex BA | −0.189580% | −0.617136% | 6/12 | [−2.008122%, +0.450566%] | +1.003313% |
| VNDB AB | −0.954838% | −0.592228% | 9/12 | [−2.089937%, −0.069379%] | +0.986168% |
| VNDB BA | +0.624203% | +0.098088% | 4/12 | [−1.506887%, +1.751045%] | −0.392386% |

The favorable VNDB AB result does not repeat in the opposite-order cell. JMdict BA includes the original ratio `0.620844811753908`, which strongly influences its equal-work statistic; it remains in the data. No outlier exclusion or replacement cohort was used.

## Semantic checks

Each cell independently verifies 36 scheduled import observations, two exhaustive-media observations and four memory-instrumented observations: 42 checks per cell, 252 total. These checks use the unchanged qualification receipt schema, exact fixture/source/package identities, persisted content/restart verification, lookup digests and applicable media validation.

Both exhaustive-media arms retain the expected complete media counts and bytes: JMdict 0 files; Jitendex 236 files / 4,992,155 bytes; VNDB 146,570 files / 188,131,284 bytes. This complete browser boundary is separate from earlier term-sink-only corpus oracles.

## Memory observations and coverage

The six cells retain **1,972 raw process-tree scans**. These are non-atomic sampled PSS/private observations; they are not exact process peaks. Only qualified scans in the marked import window contribute to a comparison.

| Dictionary / order | Screen | Median PSS change | Median private change |
|---|---|---:|---:|
| JMdict AB | Pass | +1.022704% | +1.301003% |
| JMdict BA | Pass | −4.791205% | −6.062897% |
| Jitendex AB | Pass | +0.715151% | +0.892379% |
| Jitendex BA | Pass | −0.991274% | −1.212183% |
| VNDB AB | Pass | +1.389111% | +1.677949% |
| VNDB BA | **Unqualified coverage** | null | null |

### Exact VNDB BA failure

The prospective rule rejects a covered import-scan gap greater than 250 ms. In the fixed reverse-order memory schedule:

| Observation | Arm | Largest covered gap | Complete scans wholly in import | Qualification |
|---|---|---:|---:|---|
| B1 | Candidate | **285.927306 ms** | 36 | Fails coverage |
| A1 | Baseline | 245.218192 ms | 36 | Qualified |
| A2 | Baseline | **277.771257 ms** | 35 | Fails coverage |
| B2 | Candidate | 246.740014 ms | 36 | Qualified |

Both failed observations report exactly `covered-import-scan-gap-over-250ms`. All four imports exited successfully, and there were zero unavailable-smaps or unreadable-address-space samples. Both memory pairs contain an unqualified member, so their paired changes and the aggregate PSS/private changes remain null.

This identifies the failed qualification rule. It does not establish the scheduling cause of the gaps or show a measured memory regression. The original four observations and all 411 raw scans remain in the VNDB BA archive.

Source: artifact `15260224001`; archive SHA256 `23b1aba7621d78cc6ec896419fabadb982c857cb0816e2d0a6e7f442a3dc3616`; original `memory/memory-comparison.json` SHA256 `8713d947f3fea97c9c2d6aa4ceaafdd39f4c683d38f2d3434487aa81f79d1d5b`. The compact extracted failures are in [vndb-ba-memory-coverage.json](vndb-ba-memory-coverage.json).

## Earlier failed memory cells remain separate

The older dcfc-versus6a05 cohort remains preserved and is not replaced by this f28 cohort:

- JMdict BA, artifact `15258559921`: baseline A2 had a **369.707434 ms** covered gap.
- VNDB AB, artifact `15259387382`: baseline A2 had a **256.299311 ms** covered gap.

Both failed the same fixed 250 ms coverage rule. Their original source identities, raw archive bindings and exact failures are retained in [retained-old-memory-failures.json](retained-old-memory-failures.json). The newer cohort does not retroactively qualify them.

## Review conclusion

The frozen candidate preserves the browser semantic checks in all six cells. Its whole-cohort prospective memory gate remains incomplete because VNDB BA is unqualified. The recorded elapsed and sampled-memory results support no repeated speed or process-peak-memory gain.

Any review case based on exact eliminated metadata backing allocations must cite the separate source-bound allocation/corpus evidence and state that narrower benefit. Later a300 runtime integration and its tests/corpus/browser observations need their own source identities and conclusions.


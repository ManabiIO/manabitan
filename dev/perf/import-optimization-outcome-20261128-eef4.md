# Import optimization outcome — 2026-11-28

**No performance PR was opened. None of the examined changes demonstrated a worthwhile, repeatable gain sufficient for promotion.** JMdict was the priority, with Jitendex and VNDB also investigated. The final index resolves 27 avenues: 19 held and 8 retired. These include implementations, compile-only rejections, read-only bottleneck/ownership checks, and duplicates; this is not a count of 27 timed implementations.

The production baseline was `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Sources and protocols were frozen before acquisition. Failed attempts, control drift, unfavorable observations and validation limitations remain part of the record. No effect estimates are pooled across hosts, dictionaries, candidates or local/hosted conditioning.

## Final native component campaigns

The [JMdict campaign](https://github.com/ManabiIO/manabitan/actions/runs/46110444607) tested the recent-signature prefilter and bounded equality tails. The separately preregistered [VNDB campaign](https://github.com/ManabiIO/manabitan/actions/runs/46114043842) tested equality tails, motivated by substantially greater deterministic comparison work. It was registered before the pending JMdict hosted results were observed.

Each candidate/host cell retained 18 fresh children: two excluded full-corpus warmups, one timed pass and one subsequent exhaustive verification per child. All prescribed source, runtime, fixture, work, transfer and output checks passed. Independent audits reconstructed every timed value and comparison from retained raw reports.

The boundary was the actual production parser-worker pipeline with resident compressed banks, including inflate/CRC, parsing, content/deduplication, lookup preparation and ownership copies. It excluded archive loading, startup, real IPC/concurrency, database/OPFS, compression, media payload import and lookup readiness. Worker wall time and calling-thread CPU were primary; process-wide CPU and internal wall timers were secondary.

**Median paired worker-wall changes, percent; negative is faster.** B is the candidate; A and C are identical baseline code. Every cell keeps all six blocks and its equal-work totals.

| Dictionary | Candidate | Host | B/A | B/C | Identical C/A |
|---|---|---|---:|---:|---:|
| JMdict | Signature prefilter | Forward | +0.522 | -1.400 | +2.090 |
| JMdict | Signature prefilter | Reverse | -0.162 | +0.012 | +1.292 |
| JMdict | Equality tails | Forward | -0.122 | -0.011 | +0.437 |
| JMdict | Equality tails | Reverse | +0.380 | -1.068 | +1.928 |
| VNDB | Equality tails | Forward | +2.515 | -0.666 | +1.962 |
| VNDB | Equality tails | Reverse | +2.764 | -0.665 | -0.265 |

JMdict supplied no replicated component gain. On each VNDB host, worker wall and thread CPU were slower versus A by both paired medians and equal-work totals; only two of six A pairs favored B. Favorable C comparisons coexisted with baseline and other-phase movement. Lookup encoding/preparation may reach the shared equality helpers and is not an unaffected control. CRC, inflate and result-copy provide clearer unchanged-source context. Overlapping phase timers were not combined into claimed CPU savings.

## Descriptor overlap: complete browser imports

The [descriptor experiment](https://github.com/ManabiIO/manabitan/actions/runs/46103114958) started pending descriptor writes before media/tag work, retaining the final publication barrier. It completed **252 full-import observations**, comprising six separate dictionary/order cells with 42 imports each and 12 ordinary timing pairs per cell.

| Dictionary | AB median change | BA median change | Outcome |
|---|---:|---:|---|
| JMdict | +0.636% | -1.854% | Sign changed by order |
| Jitendex | -0.226% | +1.108% | Sign changed by order |
| VNDB | +1.091% | +1.779% | Slower in both orders |

Semantic and core-work audits passed. Identical-code tails remained material, including a +23.596% JMdict BA control pair. Separate memory sampling failed coverage requirements in JMdict AB and both VNDB cells; those failures were retained without memory extrapolation. The experiment was held for every dictionary. Thus Jitendex also had no demonstrated review-worthy importer gain.

## Other avenues and validation limits

Worker-prepared record fields added producer work and transfer volume that outweighed consumer savings. Score-only/dense preparation did not provide a useful JMdict path; native score preparation overlapped another owner's work. A restored score-validation loop showed a small warmed component saving without a supported enclosing importer benefit. Watchdog coalescing, parser-patch composition, glossary-distance prediction, packed parent states and hint-local variants were held or retired after their respective work, code-generation, parity, timing or ownership checks. Read-only checks also excluded already-integrated ZIP/module reuse and existing storage/compression work.

CRC variants were retired after prior ownership/duplication was established. The separate [CRC corroboration campaign](https://github.com/ManabiIO/manabitan/actions/runs/46107092219) did not justify promotion; its results were not pooled with any other study. Lost early local stride artifacts remain explicitly unqualified.

Equality's exact frozen product passed its full unit suite: 670 files, 15,200 tests passed, 47 skipped, plus dry build and focused gates. Signature's original full run remained red after two unexpected worker exits; a separate two-file/65-test replay did not replace that result or contribute an additive test count. Broad test typing terminated with exit -9; its cause was not established. Descriptor's [32-gate validation](https://github.com/ManabiIO/manabitan/actions/runs/46105947005) passed after a test-only ownership-fixture correction, with measured product behavior unchanged.

## Final disposition

Both final native candidates remain held; their local product commits are not represented as published GitHub commits. No additional browser promotion follows from these component results. Held results do not prove every smaller effect absent.

An [optional offline replay](https://github.com/ManabiIO/manabitan/actions/runs/46120114225) was queued in the recorded publication receipt after a transient executor outage. It audits the same original artifacts using the unchanged strict auditor/summarizer, adds zero observations, and is not a dependency for the completed original-campaign decision.

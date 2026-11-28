# Inflater match-copy experiment: closed without promotion

**No product branch, complete-import cohort or PR is justified.** The fixed two-host study is complete. Warmed savings are only about one millisecond across the full sequential JMdict corpus, and the cold gain on AB does not replicate on BA. The earlier local cold losses and large control drift remain preserved.

Run **46106878218**, attempt **1**, experiment head `bc22226a2299b58ddb26b23d928b1b99c28422eb`; product baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Both hosts completed successfully. Every one of the **72 child observations**, command receipts and logs is retained, including all 540 warmup/measured corpus passes. The independent audit verifies exact native builds, source and fixture/capture identities, schedules, pointer geometry, output bytes/CRC digests, and paired arithmetic. All **96 focused tests** pass in the AB validation job.

## Results

Values are paired median candidate changes; negative favors the candidate. A/C are identical baseline code. Cold and warm observations are separate; no tails or controls were discarded.

| Cohort | Mode | B/A change | B/C change | C/A control drift | Candidate wins vs A / C |
| --- | --- | ---: | ---: | ---: | --- |
| Original local | cold | +5.776 ms (+3.31%) | +13.882 ms (+8.47%) | +20.284 ms (+10.97%) | 3/6 / 2/6 |
| Original local | warm | -1.959 ms (-1.15%) | -7.623 ms (-3.70%) | +3.595 ms (+2.23%) | 3/6 / 3/6 |
| Hosted AB | cold | -1.591 ms (-1.43%) | -1.393 ms (-1.26%) | +1.250 ms (+1.14%) | 4/6 / 5/6 |
| Hosted AB | warm | -0.959 ms (-0.94%) | -0.861 ms (-0.86%) | +0.385 ms (+0.38%) | 5/6 / 6/6 |
| Hosted BA | cold | +4.751 ms (+3.09%) | +0.188 ms (+0.12%) | +2.953 ms (+1.94%) | 2/6 / 3/6 |
| Hosted BA | warm | -1.166 ms (-0.83%) | -1.129 ms (-0.81%) | -0.160 ms (-0.11%) | 5/6 / 5/6 |

Hosted AB CPU: AMD EPYC 9V45 96-Core Processor. Hosted BA CPU: AMD EPYC 9V74 80-Core Processor. Both use Node v24.22.3 / V8 13.6.233.17-node.63.

The timed endpoint processes the same 53 banks / 12 production groups in one WASM instance: 171,617,523 output bytes and 15,632,849 compressed input bytes. It measures inflate plus immediate CRC, excluding parser work, worker scheduling/transport, storage and UI. It is component evidence, not a real browser import result. The change adds 18 native lines, preserves the existing maximum-overwrite bound, and changes only one function body in the exact timing module; correctness and small code size do not overcome the weak performance case.

## Preserved evidence

`inflater-hosted.tar.gz`: **207,854 bytes**, SHA256 `977afd33c2d8ba6a6378678c8c75f33b2b3bec290edc7dc391803fb84887b6e8`, **278 files**. `inflater-hosted-inventory.json` lists every member and both original ZIP member maps. `inflater-hosted.json` contains the complete disposition, host context and every paired comparison. The archive includes both independent audits and the exact auditor/packager source.

| Original artifact | Order | ZIP bytes | Original ZIP SHA256 |
| ---: | --- | ---: | --- |
| 15250090313 | AB | 194,511 | `4910d770c8678631424f3b491888bdd0aa6bcfd766cb0e04f724160c3b9da7ab` |
| 15249129886 | BA | 193,553 | `0a606c725074b888ac3cefa736f4497ef7246fb32e4d41c67be7f4d94e815b9b` |

Original ZIP identities and every extracted member were verified before packaging. Generated timing WASM duplicates and original ZIPs are omitted from the compact appendix; their exact hashes and build/source receipts remain. Neither source fixtures nor captured source bytes are duplicated.

The original local evidence remains unchanged in [`inflater-local.tar.gz`](https://github.com/ManabiIO/manabitan/blob/d602e1b003811b0ebac63e9ef2c8019f430aea21/dev/perf/import-investigation-9d6/evidence/inflater-local.tar.gz), SHA256 `b7312cb75461cfa89afee5522e5074e93a82302b2be4e1efea34799db0a7522c`. This appendix adds both prescribed hosted outcomes and closes the experiment; it does not replace the local cohort or launch any further timing.

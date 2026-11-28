# Cache source-range helper: complete six-host record

Closed without promotion: no PR for any dictionary.

No replicated worthwhile complete-import gain was demonstrated for JMdict, Jitendex or VNDB. The source-cache helper is closed without a PR. Every candidate endpoint interval includes zero, and favorable single-host changes fail to replicate on the opposite-order host. The earlier component gains do not qualify the complete import.

The preserved record has 252 semantic receipts: 192 authoritative timed imports (144 candidate-pair imports plus 48 identical-code control imports), 24 excluded warmups, 12 exhaustive-media imports and 24 separate memory imports. Thus 216 ordinary imports include the 24 warmups; 216 is not the timed-import count. All 1,924 raw memory scans remain included.

## Memory coverage failure retained

Five hosts pass the unchanged memory screen. VNDB BA fails coverage only: all four observations exceed the fixed 250 ms covered-scan-gap limit. The semantic failure list is empty. This is insufficient sampler coverage, not evidence of measured memory growth. All observed memory maxima and paired changes for that host remain null; no missing value is zero-filled. No threshold, observation, tail or result was changed or rerun.

| VNDB BA observation | Maximum covered scan gap | PSS/private maxima |
| --- | ---: | --- |
| B1 | 259.371315 ms | null / null |
| A1 | 266.956994 ms | null / null |
| A2 | 272.787439 ms | null / null |
| B2 | 267.570606 ms | null / null |

The original failed job 140863296120 and its complete 65,610-byte decoded log are retained with the source/run binding receipt. Its failure status remains visible.

## Every tail remains included

All individual candidate and control ratios remain in the original analysis and independent audits. The table below shows the largest recorded ratio in each host without excluding it or replacing the median. In particular, the JMdict BA first-pair tail and the Jitendex AB pair-12 tail remain in the endpoint statistics.

| Dictionary / host | Largest B/A change | Largest C/A control change |
| --- | ---: | ---: |
| jmdict / AB | +3.3368% | +3.1892% |
| jmdict / BA | +74.9033% | +8.4684% |
| jitendex / AB | +18.9334% | +3.9962% |
| jitendex / BA | +3.1814% | +1.0659% |
| vndb / AB | +2.3465% | +6.2825% |
| vndb / BA | +3.8655% | +1.8104% |

Phase diagnostics remain exploratory: counters overlap, and the helper-stage change does not reproduce across opposite-order hosts. They do not adjust endpoint timing, subtract control variation, establish causality or change the final disposition. The bounded read-only JMdict review is retained separately as support evidence.

## Complete-import endpoint results


Run 46107460816, attempt 1; baseline 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2; candidate dfd2523b514f291dc57f39a9f256bbc0759efd5b; workflow/tooling 5b5389ac69e07c95d11c4ff04230dbb8e0761995.

All original warmups, 12 candidate pairs and four identical-code control pairs per host remain included. The two exhaustive-media observations and four memory observations also remain intact: 42 canonical receipts per host, 252 in total. Original reports, plans, host snapshots, logs, raw scans, markers and audits are retained. Phase diagnostics are exploratory and do not modify endpoint timing.

| Dictionary | Host order | Median B/A | Descriptive 95% interval | Faster pairs | Median saving | Equal-work change | Control C/A |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| jmdict | AB | -0.5017% | [-1.5566%, +0.7515%] | 7/12 | +4.800 ms | -0.3153% | -0.8067% |
| jmdict | BA | +0.3154% | [-2.8660%, +3.5407%] | 6/12 | -2.600 ms | +6.9018% | -1.4402% |
| jitendex | AB | -0.0214% | [-1.0059%, +1.6950%] | 6/12 | +0.300 ms | +1.7607% | -0.8581% |
| jitendex | BA | -0.0359% | [-1.2700%, +0.9928%] | 6/12 | +0.400 ms | -0.0727% | -0.2972% |
| vndb | AB | -0.8447% | [-1.9832%, +0.9453%] | 9/12 | +41.200 ms | -1.1959% | -0.0122% |
| vndb | BA | +0.9324% | [-0.3280%, +1.5342%] | 4/12 | -54.450 ms | +0.5612% | +1.4267% |

Negative B/A favors the candidate; positive saved milliseconds favors the candidate. Endpoint results are not pooled across hosts or replaced by phase counters. Correctness and memory checks do not establish a speed gain.

| Archive | Bytes | SHA256 |
| --- | ---: | --- |
| jmdict-AB.tar.gz | 2,072,696 | d1dea50268b43c56dd72cdedd9efa6fd6f7258444ca6439a7e695ef74ccb4014 |
| jmdict-BA.tar.gz | 2,094,784 | c6373dceeba3e839fe345fa6278d7c4b6f41433b88397897ca0c0d8891f6c671 |
| jitendex-AB.tar.gz | 2,148,465 | 1f7acf67c27d091c9f23d901d8a19efb2792607d84f59c5252525a04ec66240b |
| jitendex-BA.tar.gz | 2,195,975 | 87ee97e2c43f5cb450c976f8bc70fa813beac0b793aee02496a7ae31dd40e8bf |
| vndb-AB.tar.gz | 2,306,043 | b833347df8d487762ee16913f8e433a88d264f762f691fd8a8b0b4c9ca7e9eed |
| vndb-BA.tar.gz | 2,278,977 | 09c09c46daf633600d96bf7a48a87ffb8cb8a7bb469ca947515a4102527a1cfe |
| checks-and-tools.tar.gz | 107,360 | 3bdb5788d62f5b0acf231cb4f65a717085f75389e115a2246b4eb2df2bebc1f6 |

The inventory retains full original artifact/member identities and both release-package maps for every host. Only the two release ZIP payloads per host and the original outer ZIP duplicates are omitted. The source packages were verified before omission; rerunning the original offline auditor requires recovering/building those exact packages. The checks archive includes the reviewed auditor, its Git-bound baseline helpers, packaging source and layout, checks evidence, and exploratory support records.

No benchmark, new qualification criterion, tail exclusion, earlier archive replacement or publication is performed by this packager.

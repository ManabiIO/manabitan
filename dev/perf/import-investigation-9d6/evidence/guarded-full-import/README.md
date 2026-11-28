# Guarded 16-byte Zstd match counting: complete six-host record

Closed: no worthwhile replicated qualified complete-import gain; no product PR.

Do not promote the guarded SIMD candidate. JMdict AB control drift exceeds the candidate point estimate; JMdict BA is nearly neutral and fails sampling coverage. Both Jitendex intervals include zero. VNDB paired medians are slower on both hosts, with coverage failures. Correctness and lower overlapping compression counters do not establish a full-import gain. All original observations and failures remain included; no replacement cohort.

Run 46109596112, attempt 1; baseline 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2; candidate 20e4af5897013ee76dfd4bed1ee6c383d71ba8e4; workflow/tooling 8936a15e8a8a2cf53cb10849181a6268c656a7bf.

All original warmups, 12 candidate pairs and four identical-code control pairs per host remain included. The two exhaustive-media observations and four memory observations also remain intact: 42 canonical receipts per host, 252 in total. Original reports, plans, host snapshots, logs, raw scans, markers and audits are retained. Phase diagnostics are exploratory and do not modify endpoint timing.

| Dictionary | Host order | Median B/A | Descriptive 95% interval | Faster pairs | Median saving | Equal-work change | Control C/A |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| jmdict | AB | -0.9187% | [-2.3783%, -0.0707%] | 10/12 | +6.450 ms | -1.2978% | -1.1733% |
| jmdict | BA | -0.1897% | [-1.9012%, +0.7671%] | 6/12 | +1.800 ms | -0.1913% | +1.5481% |
| jitendex | AB | -1.7154% | [-3.7757%, +0.7985%] | 8/12 | +28.000 ms | -1.6306% | +0.2789% |
| jitendex | BA | -0.6272% | [-1.2465%, +0.5242%] | 7/12 | +7.350 ms | -0.5384% | +0.3036% |
| vndb | AB | +0.9913% | [-0.7975%, +1.8773%] | 5/12 | -41.050 ms | +0.6175% | -1.3562% |
| vndb | BA | +0.2398% | [-1.5391%, +0.9419%] | 5/12 | -14.150 ms | -0.0862% | -1.0026% |

Negative B/A favors the candidate; positive saved milliseconds favors the candidate. Endpoint results are not pooled across hosts or replaced by phase counters. Correctness and memory checks do not establish a speed gain.

## Memory qualification

Memory observations remain separate from authoritative timing. A sampler-coverage failure leaves qualified maxima and comparison metrics unavailable; it does not demonstrate measured memory growth. The original qualification failures and null values remain unchanged.

| Dictionary | Host order | Memory screen | Unqualified observations | Semantic failures |
| --- | --- | --- | --- | ---: |
| jmdict | AB | passed | none | 0 |
| jmdict | BA | failed | B1: covered-import-scan-gap-over-250ms (maximum covered gap 407.646012 ms); B2: covered-import-scan-gap-over-250ms (maximum covered gap 283.053538 ms) | 0 |
| jitendex | AB | passed | none | 0 |
| jitendex | BA | passed | none | 0 |
| vndb | AB | failed | B1: covered-import-scan-gap-over-250ms (maximum covered gap 277.902870 ms) | 0 |
| vndb | BA | failed | B1: covered-import-scan-gap-over-250ms (maximum covered gap 260.657945 ms); A1: covered-import-scan-gap-over-250ms (maximum covered gap 271.681417 ms); A2: covered-import-scan-gap-over-250ms (maximum covered gap 265.135504 ms); B2: covered-import-scan-gap-over-250ms (maximum covered gap 252.967237 ms) | 0 |

## Native proof and candidate checks

The independent support audit verifies 885,455 direct boundary cases with zero guarded mismatches, 651 raw parity cases, 1,110 capacity/canary checks with zero status differences, and all 103 captured wrapper blocks. The superseded unguarded implementation's 768 traps and one wrong result remain recorded. Both native and checks jobs succeeded; the full suite passed 669 test files and 15,135 tests with 47 skipped, alongside all seven dry builds, main/development type checks and scoped lint. These are correctness results, not speed evidence.

| Archive | Bytes | SHA256 |
| --- | ---: | --- |
| jmdict-AB.tar.xz | 392,112 | c27d3c595310c78332e348621c4d4a73e286c7ca221e1f2501844d7a87e08b1a |
| jmdict-BA.tar.xz | 404,048 | f74d434304d625926f7ae3e5592a6a613a8f9d175bf88faefc8ef500cdf9bcc0 |
| jitendex-AB.tar.xz | 401,312 | 84d7bd76152103c4bbb98cfcae38993058daeac16388d8d081dea8c1293c9100 |
| jitendex-BA.tar.xz | 398,488 | c701da5a85fbc8cee992867bd33c627477278b31a2f4171b100e5f3629f8bd86 |
| vndb-AB.tar.xz | 432,100 | bad9a0e1a6de2fb8c90ae2219f7498ad840e097e6142d95e2e1db2fa8e8e1bad |
| vndb-BA.tar.xz | 430,460 | e85669d3d91746c559691cfaf991714cda66d0b381bd2bcb9b7c0450f0d75d5e |
| native-checks-and-tools.tar.xz | 249,292 | 27f43f37c7fb6b4a81642dc5099e982bd3f730f8abb508a94b026c5cdae93bf8 |

The inventory retains full original artifact/member identities and both release-package maps for every host. Only the two release ZIP payloads per host and the original outer ZIP duplicates are omitted. The source packages were verified before omission; rerunning the original offline auditor requires recovering/building those exact packages. The separate support archive includes every native/checks artifact file, the independent correctness review and source, Git-bound native proof tools, the reviewed full-import auditor and its baseline helpers, packaging source and layout, and labelled exploratory support records. The separate local corrected-codec timing appendix is not included in this hosted record.

No benchmark, new qualification criterion, tail exclusion, earlier archive replacement or publication is performed by this packager.

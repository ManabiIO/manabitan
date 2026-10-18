# Native lookup production qualification — 2026-09-18

Promote the existing native segmented lookup and retired-parser-workspace reuse paths. The structural win removes JavaScript compaction/encoding of large lookup groups, not another worker-count tweak. The only runtime changes are these two defaults. Other experiments remain off; explicit false retains the old path independently for either switch, and invalid truthy values remain disabled. Native algorithms, uint16 limits, bounded capacity fallback and storage formats are unchanged.

## Independent complete-import qualification

Baseline `fb7241deb70950dc113089cd774c9489ede48f8a`; [run 35388506078](https://github.com/ManabiIO/manabitan/actions/runs/35388506078). Two independent hosts per dictionary with opposite initial order; each has one excluded warmup pair, three pre-control pairs, twelve measured adjacent alternating pairs, and three post-control pairs. All observations, controls, report hashes, path receipts and fixture identities are retained in `native-lookup-qualification-20260918.json`. No tails, pairs or hosts were discarded.

| Dictionary | Host AB paired median | Host BA paired median | Faster pairs |
| ---------- | --------------------: | --------------------: | -----------: |
| JMdict     |               -11.34% |               -12.21% |        24/24 |
| JMnedict   |               -11.56% |               -11.92% |        24/24 |
| Jitendex   |                +1.01% |                -0.47% |        12/24 |

Jitendex is not a demonstrated speedup. Its BA host had a noisy pre-control (-16.08%); that host and every observation remain included. Do not pool absolute times across hosts. Controls on the JMdict/JMnedict hosts are materially smaller than the measured improvements.

The timing boundary is the schema-3 browser monotonic file-input-change through current-operation post-UI completion. Every report verifies pinned full title/revision/rows, persisted content probes, non-fallback OPFS/SQLite storage and matching effective flags. Content, record and lookup write bytes match across arms. JMdict has 15 native segments and eight scratch-reuse groups. JMnedict has 23 segments/seven reuse groups and one existing bounded scratch-capacity fallback to the portable path. This is not zero parser fallback; no storage fallback or import errors occurred.

## Regression oracles and rollout

Tests explicitly select false for the portable baseline and intentionally mismatched worker receipts. Otherwise default promotion could silently turn native-versus-portable comparisons into native-versus-native. The real worker alternates true, false, omitted, false, omitted across five requests and checks full index digests plus path counters. The earlier unit preflight exposed three old negative fixtures using omission as false; these fixtures were corrected without weakening assertions.

Exact-policy validation, the WTY control/production schedule, full Chromium lifecycle, compiler/build logs and product SHA are preserved by `import-native-finalize-20260918.yml` on the research branch. No research workflows, generic compression, three-worker defaults, extra overlap, or fixture/harness changes are in this product commit. Future `{}` comparisons use the new qualified defaults; explicitly set both switches false to measure the old route.

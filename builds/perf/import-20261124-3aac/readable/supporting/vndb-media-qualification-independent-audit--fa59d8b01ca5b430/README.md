# PR #875: independent VNDB timing qualification review

## Decision

Both independent hosts reproduce a roughly **5% complete VNDB import improvement against the frozen `bbccabd` baseline**. All four candidate comparison intervals lie below zero; unchanged-product control medians remain near zero. The timing qualification is positive. **Keep the PR on memory HOLD**: these timing results do not resolve the separately retained Jitendex private-memory failure and do not qualify the newer develop tree.

Run `45475087387` uses tooling `2fb6c247852c64be1b836aff60b3eba5eb1acc7e`. Each host retained three prespecified excluded warmups, twelve complete ABC blocks (36 measured imports), and two separate exhaustive-media diagnostics: **41 observations per host, 82 total**. Every observation succeeded. No retry, replacement, measured-tail removal, pooling of hosts, or pooling with the earlier screen was performed.

## Independently recomputed timing

Negative is faster. The 95% intervals are descriptive block-paired bootstrap intervals using the frozen 10,000 resamples and seed 20261124. Complete-import durations were rederived from each raw browser file-input-change and completion timestamp, then reconciled with both the native summary and cohort observation.

| Host / schedule | B/A paired median [95%] | B/C paired median [95%] | Identical C/A paired median [95%] |
|---|---:|---:|---:|
| Forward | −5.2703% [−6.1074, −3.7283] | −5.0548% [−6.3501, −4.1903] | +0.1091% [−0.7637, +1.5387] |
| Reverse | −4.6686% [−6.2451, −3.2300] | −5.0954% [−5.8739, −3.4104] | −0.1816% [−1.5028, +1.7646] |

| Host / schedule | B faster than A | B faster than C | Equal-work B/A | Equal-work B/C |
|---|---:|---:|---:|---:|
| Forward | 12/12 | 12/12 | −5.0998% | −5.2490% |
| Reverse | 12/12 | 11/12 | −4.8897% | −4.7269% |

The reverse host retains one B/C pair at +2.4344%. Its identical C/A comparisons range from −6.9824% to +6.5537%, while the control's paired-median interval spans zero. These observations remain included. The conclusion rests on the separately reproduced candidate comparisons, not on removing control variation or combining absolute timings across hosts.

Forward schedules are `ABC, CBA, BAC, CAB, BCA, ACB, ACB, BCA, CAB, BAC, CBA, ABC`; reverse schedules are `CBA, ABC, CAB, BAC, ACB, BCA, BCA, ACB, BAC, CAB, ABC, CBA`. Warmups are ABC forward and CBA reverse. Both hosts finish with separate A/B exhaustive diagnostics. The audit verifies every observation name, arm, block, position and exclusion against these schedules.

## Frozen source and build provenance

| Arm | Source commit | Tree |
|---|---|---|
| A/C baseline | `bbccabd520972cc351a65d9f545bd5369b6e9747` | `f81fc2c29b58f1c2329de6b8fa6b2a91015b6b07` |
| B media candidate | `fb71a03f4611bcfa71e135693bebd1fe778153bf` | `0939bd1eec85dc0b3f15ef002a8f0f5111c80103` |

All 75 frozen harness/dependency hashes match their baseline, candidate and tooling Git objects. The exact runner, workflow and storage-policy bytes match the committed tooling. Clean-source/build receipts, source identities, fixture-lock preparation and every observation's source/package/browser fields reconcile. All observations use Node 22.22.0 and Chromium 153.0.8010.12 with production defaults and no instrumentation, profiling, trace, screenshot or process sampling.

C uses A's exact product archive and all 550 package-entry hashes. The four planned A/B differences are exactly the parser worker, parser JavaScript, parser C source and parser WASM module. Corresponding A and B decompressed-entry inventories also match across the two hosts. Product ZIPs are not included in these artifacts: package and entry hash inventories are reconciled as retained receipts rather than independently rehashed from absent product bytes.

These claims apply to the frozen packages above. They are **not measurements of develop `9a677aec40f81256dd84233de84ff6a0c43aed43` or a candidate rebased onto it**. Source CI and memory qualification remain separate gates.

## Correctness and storage

Every import reports **6,648,310 rows**, successful restart, and identical canonical production lookup receipts: twelve deterministic terms across six passes, 72 receipts per observation. The offset-sensitive probe digest also matches all observations and both hosts: `230a48feb02e7586ecff364ae58aac25d63de213cdf5047f24629857f0a08094`. This is not exhaustive all-row canonical-content comparison.

All four separate A/B diagnostics verify every one of the **146,570 persisted media files / 188,131,284 bytes**, with digest `ea94d392bc833baf0bee7b3d6becc3d3517eee84ee314a44986438ac6d5217cb`. Timed imports and warmups retain the same 64-file deterministic sample.

All six non-SAH paths and sizes match exactly after normalizing only the media generation UUID, totaling **608,996,555 bytes**. All observations have exactly eight SAH files, seven empty at 4,096 bytes. The prospective storage policy permits only the active VNDB SAH file to vary within 129–131 allocation units of 4,096 bytes; all raw files and totals remain recorded.

- Forward: 39 observations total **609,553,611 bytes**. `block-03-2-A` and `block-10-1-B` total **609,561,803 bytes**, with active SAH allocations of 536,576 instead of 528,384 bytes.
- Reverse: all 41 observations total **609,553,611 bytes**, with a 528,384-byte active SAH allocation.

The two +8,192-byte observations, including one baseline, satisfy the previously frozen allocation rule. This is not a claim of identical SQLite file contents. Earlier failed cohorts remain failed and are not reclassified or pooled.

## Artifact provenance and reproduction

| Host | Artifact ID | Verified download size | ZIP SHA-256 |
|---|---|---:|---|
| Forward | 14961740611 | 1,820,683 bytes | `27ba469739e1ce52f3ad7292166736e1313daf6a2cb3389721f44092f5cb0575` |
| Reverse | 14960288837 | 1,827,658 bytes | `98e6e549b7d22cedd7d2c8dca696c9c439e317270e80f946d86a42044d0e8f9e` |

Root verified each ZIP's digest/size and atomically extracted it. This audit reconciled those download receipts with GitHub metadata and independently inspected all retained files. `artifact-provenance.json` preserves that distinction and hashes the original metadata/receipt files.

`receipt.json` retains all raw import timings, paired changes, bootstrap/equal-work calculations, observation report hashes, source/package identities, media receipts and raw allocation totals. `reconcile.py` performs the offline checks without acquisition. It accepts `--artifacts`, `--repo` and `--output` overrides for a retained artifact directory, a Git checkout containing the frozen objects, and the audit output directory.

No additional browser, import, timing or memory acquisition was performed. The roughly 5% VNDB timing improvement is supported for the frozen baseline; the PR remains on the separate memory hold.

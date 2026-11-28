# Corrected guarded Zstd: one local screen, inconclusive

**The single authorized local screen is closed as inconclusive. No follow-up local cohort or PR is justified by these results.** The corrected binary remains eligible for its separately running prospective browser qualification; this shared-host component study does not decide that outcome.

The candidate is product commit 20e4af5897013ee76dfd4bed1ee6c383d71ba8e4, WASM SHA256 13890c7e75e7a2ff5fa00bd65f1e518e15f545da85154719be6a2eaa2a773a22 (433,757 bytes). Baseline 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2 uses ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc (433,631 bytes). This is the corrected guard. The old invalid SIMD binary 97d50165… remains ineligible, and none of its timings is reused.

## Fixed protocol and scope

The complete cohort contains **19 fresh measurement children**: one warm child with four independent A/B/C/D wrapper contexts and 18 fresh cold children in all six A/B/C permutations. The warm child executes eight excluded warmup passes and 32 measured passes; cold children execute 18 first-corpus passes. Total: **50 measured passes, eight excluded warmups, 58 corpus executions and 5,974 block compressions**. Individual warmup durations are not recorded by the frozen child protocol.

Each corpus uses the same 103 production 1 MiB blocks from 12 captured JMdict groups, with 362,032 canonical pending spans and 101,143,985 retained source bytes. The production JS compression wrapper, dictionary, level, block planning and SharedArrayBuffer ownership are unchanged. Parsing, worker scheduling/messages, OPFS, lookup, UI and full-import latency are excluded. Node 24.22.3 and the exact executable/module/source identities are pinned.

## Results

Negative changes favor the numerator. All values below retain every observation. Warm and cold remain separate; no control subtraction, tail exclusion, result-based tuning or additional cohort occurred.

| Mode | Comparison | Median change | Median paired change | Faster | Equal-work change |
| --- | --- | ---: | ---: | ---: | ---: |
| Warm | B/A | -9.348 ms | -5.413% | 6/8 | -4.768% |
| Warm | B/C | -1.818 ms | -1.058% | 4/8 | +7.391% |
| Warm | D/A | -7.396 ms | -4.359% | 6/8 | -9.666% |
| Warm | D/C | +1.191 ms | +0.712% | 3/8 | +1.867% |
| Warm | C/A | -10.350 ms | -5.778% | 7/8 | -11.322% |
| Warm | D/B | -2.808 ms | -1.627% | 5/8 | -5.143% |
| Warm | mean(B,D)/mean(A,C) | -6.555 ms | -3.833% | 6/8 | -1.649% |
| Cold wrapper | B/A | -7.342 ms | -4.058% | 4/6 | +2.716% |
| Cold wrapper | B/C | +1.859 ms | +0.984% | 3/6 | +6.097% |
| Cold wrapper | C/A | -2.685 ms | -1.293% | 3/6 | -3.187% |
| Cold wrapper | B/mean(A,C) | -13.469 ms | -6.586% | 4/6 | +4.379% |

Warm B/A improves 9.35 ms, but the identical-code C/A control improves 10.35 ms. Against C, B is mixed and D loses. Cold B/A improves 7.34 ms, while B/C loses 1.86 ms and its equal-work total loses 6.10%. These contradictions and control movements prevent a useful gain claim. The original mean-arm summaries also remain present in the table and machine-readable analysis; they are not replaced by a selected favorable comparison.

## Every cold triple

| Permutation | A baseline | B guarded | C baseline |
| --- | ---: | ---: | ---: |
| ABC | 209.544 ms | 174.695 ms | 194.975 ms |
| ACB | 252.330 ms | 203.966 ms | 187.574 ms |
| BAC | 178.664 ms | 202.108 ms | 183.121 ms |
| BCA | 197.648 ms | 304.651 ms | 188.834 ms |
| CAB | 176.352 ms | 170.898 ms | 218.404 ms |
| CBA | 183.770 ms | 174.540 ms | 187.214 ms |

The 304.651 ms candidate observation in BCA remains included, alongside its 197.648 ms A and 188.834 ms C controls. Initialization timings and initialization-plus-wrapper comparisons are retained separately in analysis.json.

## Every warm round

| Round | A baseline | B guarded | C baseline | D guarded |
| --- | ---: | ---: | ---: | ---: |
| 1 | 164.123 ms | 173.031 ms | 165.976 ms | 167.585 ms |
| 2 | 194.676 ms | 221.721 ms | 172.637 ms | 196.557 ms |
| 3 | 255.071 ms | 233.128 ms | 165.554 ms | 156.503 ms |
| 4 | 183.154 ms | 158.301 ms | 170.276 ms | 179.909 ms |
| 5 | 166.226 ms | 161.616 ms | 161.068 ms | 154.679 ms |
| 6 | 192.207 ms | 154.805 ms | 159.930 ms | 169.084 ms |
| 7 | 172.342 ms | 166.095 ms | 170.278 ms | 171.050 ms |
| 8 | 172.857 ms | 160.409 ms | 165.035 ms | 160.238 ms |

The shared benchmark lock was held for the entire cohort. Parent and peer local artifact work paused during the children. Namespaced visibility and cooperative locking do not establish host isolation. Execution took 20.31 seconds after preflight; host load and memory snapshots accompany every child. These are context observations, not a process-memory qualification.

The separately retained corrected parity proof checks every compressed byte for all 103 blocks. Timed passes assert the same aggregate compressed-byte total; they do not add per-block hashing inside the timed region. All children completed, all pinned input hashes remained unchanged, and all four warmed wrapper-buffer capacities match.

## Durable evidence

guarded-local.tar.gz contains 65 files / 454,139 raw bytes; compressed size 80,928 bytes; SHA256 6cc09c15d798cf6950c398e9c8b9afbcd38205ebfaac9da8de7e139ca3a06bfe.

The archive retains the frozen plan, root release, orchestration source/review, all child outputs/logs, complete command list, host snapshots, launch log, input identities, arithmetic auditor/source and disposition, original capture report/artifact identity, corrected parity/proof receipts, compression dictionary, and unchanged JS measurement/runtime sources. Native WASM and capture payloads are omitted only with complete hashes and pinned retrieval/reconstruction references. Every archived member was read back and verified.

The separate [full browser qualification](https://github.com/ManabiIO/manabitan/actions/runs/46109596112) was running when this local study closed. Its outcome is not inferred from this diagnostic. Earlier completed-study archives and old invalid-candidate outcomes remain unchanged.

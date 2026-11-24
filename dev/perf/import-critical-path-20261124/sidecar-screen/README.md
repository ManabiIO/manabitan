# Sidecar checksum worker screen, 2026-11-24

The frozen sidecar candidate did not establish a whole-import speed improvement. Keep its implementation and evidence as an unpromoted experiment.

[Actions run 45462293621](https://github.com/ManabiIO/manabitan/actions/runs/45462293621) completed all three dictionary jobs at study `d6bcc194dbcbe97c1a7844f185db6faf0313bbfe`. The baseline was `bbccabd520972cc351a65d9f545bd5369b6e9747`; candidate `3439c2b17cb4d5245a2cee1177dec33fad2a7829`. The candidate retains owned lookup sidecar snapshots and computes their unchanged XXH32 checksums in the existing writer worker for the existing large-source eligibility path.

The independent auditor passed all **69 observations**. Each dictionary has three warmups, six fixed balanced A/B/C blocks, and exhaustive media diagnostics for A and B. A and C are separately built identical baseline controls. Timed imports use the original untraced production browser benchmark. Node 22.22.0 and Chromium 153.0.8010.12 are fixed. Source, fixture, retained runner, harness, packaged members, timing boundaries, semantic lookup/restart signatures, and persisted media checks all pass.

| Dictionary | Paired B/A median | Paired B/C median | Control C/A median | Equal-work B/A | Equal-work B/C |
| ---------- | ----------------: | ----------------: | -----------------: | -------------: | -------------: |
| JMdict     |           +0.138% |           −0.364% |            −0.280% |        −0.940% |        +0.013% |
| Jitendex   |           −1.905% |           +1.884% |            −1.801% |        +2.771% |        +6.434% |
| VNDB       |           −0.120% |           −0.055% |            −0.381% |        −0.126% |        +0.444% |

Negative values favor B. These are exploratory six-block observations on one hosted runner per dictionary, not cross-device qualification or significance claims.

VNDB is the intended worker path. Its A/B/C arm medians are 5361.95 / 5346.00 / 5341.50 ms; B is faster in three of six pairs against either control. That small effect is within the drift of identical controls. Every run retained the same 609,553,611-byte OPFS total; exhaustive media diagnostics match all 146,570 files and 188,131,284 bytes.

Jitendex contains a retained adverse first B observation: +28.71% against A and +40.02% against C. The mixed pair directions and controls do not support interpreting its median against A as a win. No observation was removed, rerun, or substituted.

The deterministic bundles retain every observation summary and complete raw JSON phase report, protocol, frozen runner/workflow, and canonical semantic signature. Their manifests verify the original GitHub ZIP SHA-256 and every retained member byte-for-byte. Full downloaded ZIPs also retain redundant HTML, progress and console logs. `audit.json` was recomputed from the bundles with the generalized auditor; historical studies still use their original default baseline.

The separate local AF_UNIX warmup failure is retained in the diagnostic/failure evidence directory. It produced zero observations and uses an earlier baseline/candidate; it contributes no values to this hosted cohort.

# Import index durability qualification

## Current decision

The adaptive implementation is ready for review with a conditional VNDB benefit. In its expensive-writeback cohort, complete-import latency was 8.888% lower by the paired median, with all eight pairs faster. The second independent VNDB cohort measured cheap initial writeback, disabled further intermediate checkpoints, and produced a paired change of similar magnitude to its unchanged-code controls, without establishing a speedup. JMdict and Jitendex stayed below the checkpoint size gate and showed no qualified speed improvement.

This is not an across-machine 8.888% claim: only one adaptive cohort exercised sustained expensive checkpointing. The earlier fixed 16 MiB implementation is rejected as a general import-speed improvement because its favorable exploratory screen did not replicate. Every observation from both versions remains in the evidence.

## Problem and implementation

The pinned VNDB import queues 401,899,752 bytes of lookup-index chunks. This counter excludes the initial and final 40-byte file-header writes. The synchronous index writer originally performs its durability flush during finalization, after parser work has ended. That finalization interval varied sharply between qualified hosts: approximately 1.9 seconds in the exploratory screen, but only 132–134 ms in the two independent confirmation cohorts.

Intermediate flushes can overlap expensive writeback with parser workers. They also incur fixed overhead and pause the import coordinator, which can make them counterproductive when writeback is already cheap. The first implementation exposed both outcomes.

The adaptive revision applies this fixed policy to each fresh, unpublished synchronous index sidecar:

1. Wait until more than 32 MiB has been successfully written before the first checkpoint.
2. After that checkpoint, use a 16 MiB cadence.
3. After every successful checkpoint, compare elapsed flush time with two milliseconds per MiB actually flushed. Permanently stop intermediate checkpoints for that writer if the measured cost is lower. Equality continues checkpointing.
4. Always perform the final durability flush after the final header update and before publication.

The byte accumulator counts actual successful writes, including partial writes and rewrites. A failed flush bypasses the adaptive decision and enters the existing sticky failure path. Ordered writes, backpressure, fallback selection, persisted formats, and publication ordering retain their existing contracts. Storage rollback still drains a bounded queued batch before calling the writer's abort method; this change makes no cancellation-speed claim.

First and last checkpoint bytes/time, aggregate checkpoint work, and the number of writers that disable checkpoints are bounded scalar diagnostics. They allow the single-sidecar VNDB fixture's decision to be checked directly. No checkpoint history or new payload buffer is retained.

The size and cost cutoffs were fixed before the adaptive campaign. There was no threshold sweep. The pinned JMdict and Jitendex sidecars are below the first-checkpoint size gate.

## Frozen sources and measurement protocol

All campaigns use baseline `5e1f8c12f7ff798ba407323aff675cb23b22af02`. The fixed-checkpoint screen used product and qualification `5e2335ef34f86b45f8e54b0dd40fa27db0f3bfc8`; its confirmation used the same product with qualification checkout `3ca96a8c8dc075a240f3bc8f5bc7de45efd5d75e`.

Adaptive product source is `32e7c9144f58268b07f92323e9c0f6f34e1189ed`, tree `28c46e332dc76ccea7bf67e1819087b6477c5a3f`. Its qualification checkout is `dba340e1548b0b88edfe96aa179c0e7d548e7547`, tree `ec61ce0c3c58f5cd3ec65486ea8a1260a967385f`. The checked-in parser WASM remains byte-identical at SHA-256 `cc749c53fc32dfb28eefbd69f99868f8c303caa1a3f1354231516dfa5a6e1b0f`. Only three packaged JavaScript files may differ from baseline: the synchronous index writer, term-record store, and dictionary database.

| Dictionary | Pinned archive SHA-256                                             | Term rows |
| ---------- | ------------------------------------------------------------------ | --------: |
| JMdict     | `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a` |   526,942 |
| Jitendex   | `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc` |   435,448 |
| VNDB       | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` | 6,648,310 |

Each confirmation provisions two separate jobs per dictionary. Every job runs two excluded warmups, eight adjacent candidate/baseline pairs, and four bracketing unchanged-code control pairs. A, C, and D use exactly the same baseline package; B uses the candidate. The second replication reverses every pair and the warmup order. The workflows verify source-tree and package-entry identity before measurement.

The first replication's fixed measured order is:

`C1 D1 D2 C2 A1 B1 B2 A2 B3 A3 A4 B4 A5 B5 B6 A6 B7 A7 A8 B8 C3 D3 D4 C4`

The second replication's order is:

`D1 C1 C2 D2 B1 A1 A2 B2 A3 B3 B4 A4 B5 A5 A6 B6 A7 B7 B8 A8 D3 C3 C4 D4`

The timing boundary is the browser's monotonic file-input change through the post-UI import-complete event. Timed observations disable tracing, screenshots, and process sampling. Host snapshots, exact package maps, dependency/fixture/harness hashes, raw reports, and logs are retained. Every observation must pass locked row counts, sampled term-output equality, and browser-restart readability. VNDB additionally checks its 146,570 media entries, packed-media activation, and five source-byte media probes before and after restart.

The primary statistic is the median of individual paired percentage changes; negative means lower latency. Controls remain separate and are not subtracted. Hosts, exploratory screens, and confirmation campaigns are not pooled to create a favorable result. These persistence checks are sampled, and the campaign does not measure peak memory.

## Rejected fixed-checkpoint results

[The initial screen](https://github.com/ManabiIO/manabitan/actions/runs/45119033602) retained four candidate pairs and four control pairs per dictionary, plus two warmups each.

| Dictionary | Candidate paired median | Faster pairs | Control paired median |     Control range |
| ---------- | ----------------------: | -----------: | --------------------: | ----------------: |
| JMdict     |                 −1.434% |          4/4 |               +0.905% | −4.35% to +33.78% |
| Jitendex   |                 −4.870% |          4/4 |               +1.414% |  −4.48% to +2.49% |
| VNDB       |                 −8.270% |          4/4 |               −0.515% |  −2.43% to +0.87% |

[Independent confirmation](https://github.com/ManabiIO/manabitan/actions/runs/45120619232) retained all 156 imports across six jobs. No import failed and no measured observation was discarded.

| Dictionary | First candidate median | First control median | Second candidate median | Second control median |
| ---------- | ---------------------: | -------------------: | ----------------------: | --------------------: |
| JMdict     |                +1.492% |              −0.790% |                 +0.964% |               −2.239% |
| Jitendex   |                −0.856% |              −3.314% |                 −1.242% |               −1.908% |
| VNDB       |                +0.246% |              −1.544% |                 +1.344% |               +0.095% |

The complete audit validates all 221 fixed work/configuration fields within every job and identical package/harness maps across the six jobs. All control tails remain in the record, including the second JMdict cohort's −49.12% control pair. Those tails are not a reason to selectively remove observations or subtract controls from candidate timings.

The timing breakdown explains why a universal cadence is inappropriate. In the exploratory VNDB screen, checkpointing shortened finalization by a paired median 1,893 ms but added 1,270.5 ms to data-bank processing, leaving a 669.5 ms paired median complete-import reduction. In the confirmations, baseline finalization was only 133.5 and 132 ms. The 23 checkpoints consumed 311.5 and 320.3 ms per candidate import, plus a final flush of roughly 5–6 ms. Data-bank processing grew by paired medians of 102.5 and 178.5 ms. The general speed claim did not replicate.

## Adaptive qualification

[The adaptive campaign](https://github.com/ManabiIO/manabitan/actions/runs/45123841069) is separate from every result above. All six jobs passed, preserving 144 measured imports and 12 excluded warmups. No import failed or was removed. The source, cutoff, schedules, and decision guards were fixed before measurement.

| Dictionary | Replication | Candidate paired median | Faster pairs | Control paired median |     Control range | Candidate checkpoint mode    |
| ---------- | ----------: | ----------------------: | -----------: | --------------------: | ----------------: | ---------------------------- |
| JMdict     |           1 |                 −0.111% |          4/8 |               −0.746% | −21.71% to +3.15% | Inactive below size gate     |
| JMdict     |           2 |                 +0.176% |          4/8 |               −1.944% | −27.58% to +4.82% | Inactive below size gate     |
| Jitendex   |           1 |                 −0.364% |          5/8 |               −1.069% |  −7.67% to +3.01% | Inactive below size gate     |
| Jitendex   |           2 |                 +1.151% |          3/8 |               +1.374% |  +0.42% to +5.14% | Inactive below size gate     |
| VNDB       |           1 |                 −8.888% |          8/8 |               −0.052% |  −1.16% to +2.50% | Periodic expensive writeback |
| VNDB       |           2 |                 −0.736% |          7/8 |               −0.750% |  −1.89% to +0.52% | Stopped after cheap probe    |

Every candidate observation in a cohort followed the listed mode. The small-dictionary candidate timings are mixed, and their controls include substantial variation; they support no speed claim. In particular, the Jitendex second cohort's +1.151% candidate change is reported alongside its +1.374% unchanged-code change, without subtracting one from the other.

For VNDB replication 1, the paired complete-import reduction was 728.4 ms. The separate baseline and candidate medians were 8,220.05 and 7,460.15 ms; their difference is not substituted for the paired statistic. Every candidate made 22 checkpoints covering 392,423,668 bytes. Median checkpoint time was 1,798.9 ms, followed by a 36.65 ms final flush. The paired data-bank interval increased by 1,120 ms while finalization decreased by 1,854 ms. This supports overlapping expensive final writeback with ongoing parser work, rather than eliminating that work.

For VNDB replication 2, every candidate stopped after one 33,973,532-byte checkpoint costing 9.3–15.5 ms. The −0.736% total-time change is essentially the same scale as the −0.750% unchanged-code control median and is not counted as a demonstrated speedup. The separate finalization medians were 714 ms for baseline and 617 ms for candidate. An inexpensive first probe can disable later checkpoints even when a later final flush still costs hundreds of milliseconds; this deliberately conservative policy does not promise optimal scheduling for every storage profile.

The verifier requires zero checkpoint work for the small sidecars. For VNDB, it verifies the first and last byte bounds, a cheap first checkpoint stopping at exactly one checkpoint, the last checkpoint's cost matching the disabled decision, and fewer than 16 MiB remaining outside completed checkpoints when periodic flushing remains enabled. Every observation's adaptive mode is retained. Expensive-to-cheap transitions are covered by focused tests; none occurred in these browser cohorts.

## Correctness validation and retained evidence

The adaptive source passes 313 focused writer, storage, ownership, publication, rollback, and recovery tests, main/test TypeScript, scoped ESLint, and all-target build checks. Tests cover the exact cutoff, cheap and expensive writeback, slow-to-cheap transitions, zero/coarse timing, short writes, rewritten bytes, sticky failures, abort, and mandatory final flush after checkpoint suspension. The frozen adaptive head's [full CI](https://github.com/ManabiIO/manabitan/actions/runs/45123840948) is green, including 14,016 unit tests across 628 files, 47 skipped tests, Chromium and Firefox extension checks, types, lint, JSON validation, and builds.

The original local full-suite toolchain-setup failures and Android helper timeout are retained. Pinned LLVM configuration resolved the compiler setup failures; the original fixed candidate's hosted full CI passed 14,004 unit tests across 628 files. An adaptive test-fixture timeout under concurrent validation is also retained. Its equivalent full-byte oracle now builds the same large pattern through 64 KiB repetitions rather than millions of JavaScript callback calls; the test timeout was not relaxed.

The [fixed-cadence archive](evidence/import-index-checkpoints-fixed-20261123.tar.gz) and [manifest](evidence/import-index-checkpoints-fixed-20261123.manifest.json) preserve all 192 timed imports and 18 warmups from the screen and confirmation, every raw report/control, frozen sources, complete analyses/scripts, exact VNDB diagnostic trace, and original validation receipts. Rendered HTML duplicates are omitted; all retained member bytes match their original workflow ZIPs. The separate trace is diagnostic and excluded from latency estimates.

- Archive: 8,574,823 bytes; SHA-256 `f895e8c75121e7e538284466c391c38a3afd06866fab789e50b7b1585b79c07c`.
- Manifest: 909,147 bytes; SHA-256 `96564196f85d16038a216d2a12d5e56871a7e16c31e7e310d36220e2884061d9`.
- Payload: 1,628 files plus `MANIFEST.json`.

The [adaptive archive](evidence/import-index-checkpoints-adaptive-20261123.tar.gz) and [manifest](evidence/import-index-checkpoints-adaptive-20261123.manifest.json) preserve all 144 timed imports and 12 warmups from the six final jobs, complete analysis and scripts, exact product/qualification snapshots, local validation receipts, and the hosted CI run/jobs metadata and full unit log. Only 156 rendered HTML duplicates are omitted; the manifest inventories their original hashes. No timed observation is omitted. Both archives were independently verified against their manifests and original workflow artifacts.

- Archive: 5,248,201 bytes; SHA-256 `4c063be7b2b712e71dbc3027f874f1754789af02f06fa035abe0a1d5acd8c61d`.
- Manifest: 691,204 bytes; SHA-256 `2a8f63548a994a852a8be838baa4384c7e1c33d7fcf6384c2e741bdc16f5e6a8`.
- Payload: 1,233 files plus `MANIFEST.json`.

The final PR tree removes the temporary comparison workflow and qualification overlays. Its production files and focused tests remain byte-identical to the frozen adaptive source above.

To recompute the complete adaptive audit from the retained archive, run these Bash commands from the repository root:

```bash
mkdir -p /tmp/manabitan-adaptive-evidence
tar -xzf dev/perf/evidence/import-index-checkpoints-adaptive-20261123.tar.gz -C /tmp/manabitan-adaptive-evidence
cd /tmp/manabitan-adaptive-evidence
python3 analysis/analyze_adaptive_durability.py \
  --qualification-sha dba340e1548b0b88edfe96aa179c0e7d548e7547 \
  --require-complete \
  browser/adaptive/{jmdict,jitendex,vndb}/r{1,2} \
  > adaptive-audit.json
```

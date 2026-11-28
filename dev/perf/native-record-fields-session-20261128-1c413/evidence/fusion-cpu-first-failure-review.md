# Original CPU run: failed evidence preservation

**Disposition: FAILED / UNREVIEWABLE — no auditable numeric result or nomination.** Original run [46153880495](https://github.com/ManabiIO/manabitan/actions/runs/46153880495), attempt 1, completed with failure. Both prescribed acquisition steps succeeded, but both artifact uploads failed. The terminal artifact API returns `total_count: 0`.

## Exact execution identity

- Producer: `3ca60b3f80733e0a07e26a6141a9cad6febfdb55`
- Tree: `ab4af038a8e9da0bb6080b493166b6dd6e735eab`
- Sole parent: `01eb863506012136e417167f445b2708d9136293`
- Branch: `test/native-whole-import-cpu-screen-20261128-1c413`
- Raw plan SHA256: `1faa5618f7f5b3f537d41c9fa0f4c78870b7a8418685baf2639e01b09d598d4d`
- Workflow SHA256: `ecfa8c30ba79de2f3c16afbd4cd14b47bb06ac87cf5f060c5b7b32ea82d7a8b7`
- Preparation reference SHA256: `f6ec3995fed659b2d89f501125331cd644d41ba65e491a54592fc1a459c64d8e`
- Pre-acquisition freeze: remote blob `c68479339d2cd3930d1aeaf2184152cb6eedb1c1`, reread and verified by exact Git blob identity.

Run, attempt-specific job metadata, producer metadata, and the freeze agree. The run started from this producer after the recorded freeze. No other attempt is substituted.

## Terminal failure

| Replication | Job | Acquisition step | Upload step | Final job |
|---|---:|---|---|---|
| R1 | 141006157502 | success | failure | failure |
| R2 | 141006157198 | success | failure | failure |

The uploader discovered 1,662 files per job, then rejected a literal vertical bar in the production raw term-record filename. R1's rejected member is:

```
study-results/R1/observations/000-warmup-A/disk/root/manabitan-term-records/dict-25|JMdict%20%5B2026-11-22%5Draw-block-v2%3Ajmdict.mbtr
```

R2 rejected the corresponding `000-warmup-C` member. The frozen workflow passes raw directories directly to `actions/upload-artifact`; that action's path validation rejects `|`. Neither upload created an artifact. This is an evidence transport failure, not an auditor disk-capacity or extraction limit. There is no artifact ID or signed archive download available to acquire.

## Complete available evidence checked

Both full completed decoded job logs are preserved, each 346,123 UTF-8 bytes and 2,724 lines:

| Replication | Full decoded log SHA256 |
|---|---|
| R1 | `1217e5fd42637c4ced8f58a09c83ba90265ac54a413e04e26616eb29bfa66420` |
| R2 | `a188686d0db93d35e26034600a38d20c4efad79d004cd1fd23d4348c19db0b81` |

Each log contains exactly 42 JSON launch-progress records, with indices 0–41, matching the frozen six untimed warmups and 36 measured entries in their exact prescribed order. Each arm occurs twice in warmups and twelve times in measured blocks. The records are emitted **before** each child process; they are launch records, not raw observation receipts. The acquisition steps' success reports that the orchestrator reached completion, but it does not provide independent access to its checks or their inputs.

The jobs used different recorded runner IDs (R1 `1000093765`, R2 `1000093764`), and both logs report Node v22.22.0 and the pinned fixture SHA256 `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`. Setup, pure checks, and prepared-source/capacity preflight steps are marked successful. Their file-based detailed receipts are unavailable.

The complete final artifact response is preserved and contains zero artifacts. Initial and terminal run/job/artifact metadata, exact producer/freeze metadata, full logs, source files relevant to preservation, the audit script, and the complete structured audit are included in the accompanying archive.

## Why no performance conclusion is available

The exact frozen `screen.mjs` redirects each child's stdout/stderr into files. It logs only replication, index, phase, and arm to job stdout. It writes `acquisition.json`, raw clock values, work/check receipts, and `summary.json` to files under the failed-upload tree. None of those data appear in the available job logs.

A successful acquisition process does not require `summary.nominationGatePassed` to be true: the script records that boolean and exits normally either way. Therefore job-step success cannot be used as a positive or negative numeric result. Activity timestamps in the job log are not CPU samples and were not used to infer performance.

Unavailable originals include raw CPU start/end receipts, acquisition and summary reports, per-observation source/host/affinity/work/output/owner/field/worker/activation/lifecycle receipts, complete raw sinks and retained field buffers, child logs, and prepared-runtime/capacity result files. The required complete artifact audit and independent numeric recomputation cannot be completed from the available originals. Source assertions are not substituted for those missing receipts.

## Preservation and scope

The archive preserves every byte of the available originals received through the completed-log and metadata APIs. Its manifest distinguishes original provider evidence from frozen source and auditor-created reports. All archive members are regular files with safe relative paths; each member is read back and checked by byte count, SHA256, and Git blob identity. Those calculated Git IDs are content identities, not claims of separate remote publication.

This audit executed no product import, acquired no new timing sample, retried or canceled no job, created no ref or PR, and attempted no artifact download because none exists. This first cohort remains permanently failed and unreviewable. No later study may be combined with it or substituted for its missing originals. No replacement run or observation is authorized by this report.

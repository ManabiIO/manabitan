# VNDB media catalog retention: final review evidence

**Closed without a product PR.** The compact catalog reduced retained worker heap plus reported backing storage by **14,913,942 bytes (14.223 MiB, 53.7005%)** at `catalogReady`. This measured saving is accepted as real. The required whole-process memory screen remains unqualified after the one predefined coverage follow-up, so the change is withheld.

**The original 16 MiB primary criterion and the overall registered promotion rule both failed.** The original VNDB process-memory screen also failed, and the separate follow-up did not satisfy the required coverage gate. These failures remain unchanged. A possible engineering exception for the 14.223 MiB resource saving was considered, but it was not granted because the required process-memory prerequisite remains unmet. The sampling failures do not establish a memory regression.

## Proposed change and claim scope

The four runtime files keep fewer ZIP entry objects and raw-filename views simultaneously retained. The compact catalog still holds decoded filename strings and a byte arena; hydration is confined to the current media batch. Selected images are still hydrated over all 144 batches, so this evidence does not claim fewer total object allocations.

The measured benefit is retained JavaScript heap plus reported backing storage in the actual nested VNDB source-media extension worker during packing, after forced collection at fixed checkpoints. Worker termination and post-import memory behavior are unchanged. There is no complete-import speed, whole-process peak RSS/PSS, or permanent installed-dictionary memory claim.

## Primary extension-worker observations

The frozen primary cohort ran three fresh-context blocks in ABC, BCA, CAB order, with seven fixed checkpoints and two forced collections per checkpoint. All nine observations completed, all capability checks passed, and every final descriptor/index/source-span output matched the independent full-payload parity run. The fixture contains 146,570 selected images; all payloads were independently inflated and CRC checked in both parity arms.

At `catalogReady`, the median control total was 27,772,432 bytes and the candidate median was 12,858,490 bytes: **14,913,942 bytes (14.223 MiB, 53.7005%) lower**. The third candidate block was another 76 bytes lower. All candidate observations were below both controls; the largest within-block control spread was zero at this checkpoint.

| Checkpoint        | Median saving vs A, bytes | Median saving vs C, bytes | Registered role    |
| ----------------- | ------------------------: | ------------------------: | ------------------ |
| `beforeCatalog`   |                   -11,306 |                   -11,306 | Descriptive        |
| `catalogReady`    |                14,913,942 |                14,913,942 | 16 MiB floor: FAIL |
| `beforeFirstRead` |                14,775,646 |                14,775,646 | 8 MiB floor: PASS  |
| `afterRead1`      |                14,775,514 |                14,775,514 | 8 MiB floor: PASS  |
| `afterRead72`     |                14,768,162 |                14,768,110 | 8 MiB floor: PASS  |
| `afterRead144`    |                14,874,650 |                14,874,794 | 8 MiB floor: PASS  |
| `afterPack`       |                14,892,290 |                14,892,454 | Descriptive        |

The original primary floor was 16,777,216 bytes. All four active-packing checkpoints passed their separate 8,388,608-byte floors and every-candidate-below-both-controls checks. Every candidate saving versus either control at these measured checkpoints exceeded 14 MiB; the minimum was 14,767,618 bytes (14.0835 MiB), at `afterRead72`. These fixed checkpoints do not continuously measure all 144 batches. `afterPack` remains descriptive. The small pre-catalog candidate overhead is retained above. These secondary findings do not turn the failed primary rule into a pass.

The JSON includes all nine observations and every raw heap/backing/native-memory input at all seven checkpoints. `checkpointColumns` names the table columns. Native-memory nulls preserve the original absence of an instantiated/observed native allocation; they are not measured zeros. Native allocation sizes matched at corresponding checkpoints. Only `usedSize + backingStorageSize` defines the primary metric; other heap/native fields are recorded separately.

## Ordinary complete imports

Each frozen dictionary cohort includes all 20 observations: four warmups, six A/B pairs, and two A/C identical-code control pairs. Separate exhaustive-media and four instrumented process-memory observations follow the timing cohort. No observation was trimmed or replaced. Changes below are B/A percentages; negative values are faster.

| Corpus   | Paired median | Equal-work | Faster pairs | Control median | Separate memory gate |
| -------- | ------------: | ---------: | -----------: | -------------: | -------------------- |
| JMDICT   |      -0.7773% |   -0.7666% |          3/6 |       +1.3997% | Pass: 4/4 qualified  |
| JITENDEX |      +0.0348% |   +3.2208% |          3/6 |       +0.1130% | Pass: 4/4 qualified  |
| VNDB     |      -1.0722% |   -0.9541% |          5/6 |       -1.9622% | FAIL: 2/4 qualified  |

VNDB completed all 26 raw import/semantic reports, exhaustive media, restart and expected parallel/early-payload activation checks. Its ordinary process-memory gate nevertheless failed: **B1 had a 399.792045 ms covered-scan gap and A2 had a 308.60082 ms gap**, exceeding the fixed 250 ms limit. A1 and B2 qualified, but each fixed pair contains one failed member, so both paired PSS/private aggregates remain null. A1 and B2 are not cross-paired. This is a coverage disqualification, not evidence of a memory regression; it still leaves the required ordinary process-memory prerequisite unmet.

The JMdict result is inconclusive; its three faster pairs and favorable median do not establish a speedup. Jitendex pair 4 was **1,580.7 ms baseline versus 1,922.9 ms candidate (+21.6486%)**, and the all-six-pair equal-work result is **+3.2208%**. Both remain in the reported statistics. Its source-packed catalog route was inactive in both arms. Descriptive phase counters locate most additional time in term processing, but they do not establish a cause or justify discarding the pair. The flat paired median is not a proof of nonregression.

Every corpus audit verifies 26 raw import reports, the exact source/package/browser identities, every packaged member hash, unchanged harness and fixture bindings, semantic receipts, restart/exhaustive-media checks, and the separate process-memory qualification evidence. The completed VNDB audit confirms the registered parallel/early-payload route, 146,570 entries and 195,649,882 packed source bytes in both arms. Its candidate paired median of −1.0722% is smaller than the favorable −1.9622% identical-code control drift, so it supplies no latency claim. No product PR is being opened.

All 20 raw timing values, exact paired/control statistics and all four memory qualification rows per completed corpus are included in the JSON. `ordinaryProtocol.timingObservationColumns` and `memoryObservationColumns` name the compact row columns. Shared memory-observer strings are recorded once; no per-observation numeric input or qualification failure is omitted. Full memory scan files and semantic reports remain in their digest-bound raw artifacts. Process-memory regression-screen passes are not evidence of lower process peaks.

## Quality, source identity and retained attempts

Hosted validation at product head `931eff9fb194df34b67cb4f5f952f437aa8c084b` passed scoped ESLint, all four TypeScript projects, **669 unit files / 15,154 passed tests** with 47 skips, and all target dry builds. Actual logs include failure-propagating shell settings. The six reviewed source blobs comprise four runtime files and two test files; their full Git blob and SHA-256 identities are in the JSON.

The initial lint-failed run stopped before measurements. The incomplete local unit exit 137 and type-check exit 134 receipts remain preserved; later hosted gates supplied the passing quality evidence. The original HTTP/headless-shell nine-observation cohort was classified as sensitivity-only before outcomes and remains separate. It does not replace the full executable/extension-context primary cohort, get pooled with it, or alter the failed threshold. All primary partial checkpoint files remain alongside their completed records.

## Evidence and reproduction references

- [Compact exact evidence](media-catalog-retention-20261128.json): all raw checkpoint/timing inputs, source and file blobs, fixture/browser/harness/package digests, artifact IDs/SHA-256, quality counts, original outcomes, the separately added follow-up and final closure decision.
- [Frozen ordinary workflow](https://github.com/ManabiIO/manabitan/blob/931eff9fb194df34b67cb4f5f952f437aa8c084b/.github/workflows/media-catalog-lab-4a779.yml) and [ordinary run 46108057559](https://github.com/ManabiIO/manabitan/actions/runs/46108057559).
- [Frozen primary extension-memory workflow](https://github.com/ManabiIO/manabitan/blob/ead4110b13e45e373155236f1dff430c972e6b1b/.github/workflows/media-catalog-extension-memory-lab-4a779.yml) and [primary run 46109767804](https://github.com/ManabiIO/manabitan/actions/runs/46109767804).
- [Frozen ordinary qualification script](https://github.com/ManabiIO/manabitan/blob/9e10d3b3fcf66d344ab31bc42c9b522fa5215da2/dev/perf/import-qualification-20261125-a7f7.py). Exact primary and ordinary command templates are recorded under `reproduction` in the JSON.

The primary uses Node 22.22.0 and full Chromium 153.0.8010.12, with executable SHA-256 `8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e`. Its diagnostic head changes only the harness/workflow relative to the ordinary product head; reviewed runtime bytes match. Original and instrumented package member-map digests, overlay source hashes and context capability bindings are retained. Canonical JSON hashes in this packet use sorted keys, ASCII JSON, and separators without spaces.

This packet was assembled from completed evidence only. It launches no new import, timing, memory sample, or qualification cohort.

## Separate predefined memory-only coverage follow-up

Exactly one separate VNDB coverage cohort was registered and completed: A1, B1, B2, A2, with the original source revisions, full Chromium executable, marker overlay, sampler, 250 ms coverage/bracket limits, SAH allocation policy and paired memory limits unchanged. It added no latency comparison, warmup, exhaustive-media rerun, per-observation retry or replacement cohort. The experiment stopped after those four scheduled outcomes.

The plan was recorded at 2026-11-28 08:10:39 UTC before the workflow event at 08:11:29 UTC. [Run 46124641451](https://github.com/ManabiIO/manabitan/actions/runs/46124641451) is bound to [diagnostic head 860d5518820ae080b01c1e1f2ce84d3a345ce336](https://github.com/ManabiIO/manabitan/commit/860d5518820ae080b01c1e1f2ce84d3a345ce336), whose parent is the unchanged ordinary product head. All six product/test blobs are unchanged; all 554 prior package members per arm must match before acquisition. The plan and runner SHA-256 values and all five diagnostic blob identities are recorded in the JSON.

**The follow-up failed its fixed coverage requirement.** A1 had a 330.034337 ms covered-scan gap, exceeding the unchanged 250 ms limit. B1, B2 and A2 qualified. Every benchmark exited successfully, all four canonical/activation bindings passed, both 554-member packages matched the original runtime bytes, and the independent audit recomputed all 487 raw scans and their markers without an integrity error.

| Observation | Maximum covered-scan gap, ms | Qualified | Sampled PSS maximum, KiB | Sampled private maximum, KiB |
| ----------- | ---------------------------: | --------- | -----------------------: | ---------------------------: |
| A1          |                   330.034337 | No        |       Unqualified / null |           Unqualified / null |
| B1          |                   195.346063 | Yes       |                1,164,597 |                      941,864 |
| B2          |                   191.799526 | Yes       |                1,157,318 |                      937,656 |
| A2          |                   210.688681 | Yes       |                1,227,932 |                      998,824 |

Pair 1 remains unqualified, with null change values. The valid second pair has sampled PSS change −5.750644% and private change −6.124002%, but **both aggregate metrics remain null** because not all four observations qualified. The valid pair is not used alone to pass the screen, and no observation is cross-paired with the original cohort. The JSON preserves all four full summary rows, fixed pairs, null aggregates, raw-scan audit, package identities and artifact digest.

The follow-up is artifact `15257037141`, SHA-256 `3e5e3a3a49fb093c5a3eef24f7b826912fc3529fba452c31185ba86c84bd36ab`. Its independent audit receipt SHA-256 is `fbb8793aeecba51a439efb1c0477569cced5866271c64194dc0e8e7cc07a860e`.

## Final decision and preserved history

**CLOSE_WITHOUT_PR.** The measured 14.223 MiB retained-worker reduction is accepted as a real resource saving, but the prospective whole-process screening prerequisite remains unqualified after the single allowed follow-up. No product PR, repeat cohort or additional measurement is proposed. This is an evidence-qualification decision, not a finding that the candidate increases memory.

The immutable original packet remains preserved at 59,324 bytes with SHA-256 `0740c0492bc25dd0e90e4ebaf465c97e81b101f9b5bbde7ffbc31faa395d49b9` and original administrative status `HOLD_FAILED_VNDB_PROCESS_MEMORY_GATE`. The final packet adds the separate follow-up and `reviewDecision`; only its top-level administrative status changes to record closure. Every original measurement, per-cohort outcome and registered-rule failure remains unchanged.

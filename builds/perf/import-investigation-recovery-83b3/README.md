# Recovery completed; investigation resumed

The executor returned at 05:12 UTC. The independently verified [complete 153-file evidence bundle](../import-owned-columns-83b3-followup/README.md) is now published, including the full native-symbol proof, both held experiments, exact checksum inputs, source attribution and all recorded failures. Its 11,294,013-byte archive has SHA-256 `78af8326b7fdf03799c22f914bfee2d861e9ae4ad2a4566a63fd57f793e31a46`.

This supersedes the **remote-availability limitations** in the historical interruption snapshot below. Its dated recovery receipt and the #830 preparation handoff remain unchanged records of that moment. Local investigation has resumed; the interruption produced no timed #830 observations. The product source still equals PR #820 head `f65f4ef97ebf2f37a5b1b79ca7733d7b362ec963`.

---

# Import investigation evidence and executor interruption

This evidence-only branch preserves the completed compressed-input JMdict diagnostic and the separately reviewed hosted-artifact reader for [PR #820](https://github.com/ManabiIO/manabitan/pull/820). Product source is unchanged from candidate `f65f4ef97ebf2f37a5b1b79ca7733d7b362ec963`. This branch does not restart or replace that candidate's pending CI or browser acquisition.

## Available evidence

- [Complete compressed-input acquisition evidence](../20261128-compressed-worker-profile-83b3/README.md): all 53 JMdict banks, 528,299 rows and 12 current policy-3 groups; 13 CPU profiles, complete output and ownership receipts, both setup failures, the original and revised resource plans, exact sources, and independent readback. Its already-published v3 parity reference and separate native-symbol proof are reproduction dependencies; the latter is still a local recovery target.
- [Hosted-artifact reader](../import-owned-columns-83b3-analysis-source/README.md): source and reviewed intake protocol. No artifact from the ownership qualification had been analyzed when the local executor became unavailable.
- [Current #830 preparation handoff](../20261128-inflight-validation-830/preparation-handoff.json.txt) and [exact upstream patch](../20261128-inflight-validation-830/upstream.patch.txt): observed contract checks and a proposed experiment, with no new timing result.
- [Recovery status](recovery-status.json.txt) and [uploaded-file map](uploaded-file-map.json.txt) distinguish verified remote objects from files that remain in the unavailable local workspace.

The compressed diagnostic is a baseline-only Node observation. It is not a browser import, candidate comparison, throughput estimate or predicted saving. The actual compressed path includes decompression and CRC; no validation was skipped. Instrumentation and adapter work are excluded from product attribution as documented in the diagnostic.

## Completed experiments that were not promoted

The fixed request-batching cohort reduced JMdict compression requests from 103 to 48 but did not establish a useful timing gain: the paired candidate-minus-controls median was +3.154 ms (+4.24%), and the candidate beat both identical-code controls in 1/12 rounds.

The fixed aligned-checksum cohort had a first-pass paired median of -0.0366 ms (-0.1816%) and a warmed median of +0.6591 ms (+5.73%). Identical-code variation exceeded the small first-pass difference. No additional unchanged-cohort rounds were run.

These are recorded local findings, not new runtime proposals. Before the executor outage, their complete raw observations, controls, patches and failures were independently verified in a 153-file evidence bundle. The full bundle had not yet been uploaded, so this branch does **not** claim to contain those complete experiments.

The corrected canonical-sink diagnostic also verified that the actual parent's ownership receipt adopts 101,143,281 content bytes. The earlier adapter's omitted ownership registration had caused an extra cache copy outside its timed codec replay; that copy must not be attributed to production.

## Interruption and outstanding work

The local executor became unavailable after the completed diagnostics and packaging review. The complete 153-file archive remains a local recovery target: 11,294,013 bytes, SHA-256 `78af8326b7fdf03799c22f914bfee2d861e9ae4ad2a4566a63fd57f793e31a46`. No remote durability is claimed for that archive or for the complete native-symbol-proof folder. The compressed report retains the proof's hash and mappings, but it does not replace the complete release/names binaries and section proof.

A current-source port of the exact final [PR #830](https://github.com/ManabiIO/manabitan/pull/830) patch passed 293 focused tests and scoped type checking. Its lint process was killed before completion. The outage occurred before actual fast-path admission proof, protocol freeze or timing. The proposed cold A/B/C cohort was never acquired, and no speedup or runtime promotion follows from its passing tests.

A baseline JMdict browser trace from [the separate #973 diagnostic run](https://github.com/ManabiIO/manabitan/actions/runs/46104197268) remains available as artifact `15248139923`. Its complete outer ZIP hash and safe member inventory were checked locally; independent package-member binding and CPU-profile reconstruction remain unfinished. Reported chunk-emitter thread IDs must not be treated as sampled worker identities without joining profile records correctly. No browser CPU attribution is claimed here.

The ownership candidate's qualification remains bound to its original runtime SHA and frozen workflow. Cumulative private-buffer allocation savings do not establish peak-memory or complete-import latency improvement.

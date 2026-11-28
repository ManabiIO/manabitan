# Current import investigation evidence

The [three completed ownership browser cells](../import-owned-columns-83b3-hosted/README.md) now have durable raw observations and independent readbacks. Neither independent JMdict host demonstrates a latency improvement; Jitendex leans slower. VNDB is still pending in this snapshot. All controls, slow tails, memory scans and original non-package artifact members are preserved. PR #820 remains draft/HOLD, with its deterministic allocation benefit kept separate from latency and peak-memory claims.

The separate [current-source #830 update](https://github.com/ManabiIO/manabitan/pull/830) is published at `049cb11e6963604435998aa060e1400cc00365cb`. Its [complete component evidence](https://github.com/ManabiIO/manabitan/tree/049cb11e6963604435998aa060e1400cc00365cb/dev/perf/inflight-validation-830-20261128-83b3) supports a 16.9997 ms paired median direct-registration saving, faster than both controls in all twelve rounds. Its broader sink timing is inconclusive and its separate browser qualification is pending. The [reviewed offline reader](../import-inflight-validation-830-83b3-analysis-source/README.md) is frozen before the first artifact analysis.

The [supplementary source reviews](../20261128-source-screen-followup-83b3/README.md) prove that the normal import callbacks wait through batch removal before the next sink registration. That supports #830's empty-batch expectation without claiming observed browser admission. They also close the current-policy JMdict polynomial-power-cache lead: its affected deferred helper has zero calls in the recorded groups, and the broader existing #910 candidate already has a historical final-source HOLD screen.

The [prospective artifact intake and packaging helpers](../import-inflight-validation-830-83b3-artifact-tools/README.md) are independently reviewed and frozen before #830 intake. They bind each actual run/attempt/head/job/artifact and its upload log, preserve failed outcomes, and leave the qualification reader and browser acquisition unchanged.

All additions on this branch are evidence under `builds/perf/`. Product bytes still match PR #820 head `f65f4ef97ebf2f37a5b1b79ca7733d7b362ec963`; neither PR head is changed by this publication. Dated recovery and profiling snapshots below retain their original history and are superseded only where this current index says so.

---

# Current profiling evidence and interpretation

The [complete offline browser readback](../20261128-browser-jmdict-profile-83b3/README.md) is now available. Its compact archive preserves the full previously acquired JMdict baseline trace, original receipts, exact source bindings, all 37,824 samples, failed first analysis and independent recomputation. This is a baseline diagnostic, not a new acquisition or candidate timing result.

The [additive sampling correction](../20261128-browser-jmdict-profile-83b3/SAMPLING-NOTE.md) supersedes the earlier attribution of initial `inspector/post` gaps to profile-stop overhead. Those initial intervals are unassigned gaps before the first observed sample. Sampled-stack weights also do not establish on-CPU time or removable import latency. The original profiles, tables and archived bytes remain unchanged.

This branch remains evidence-only and retains PR #820 product source `f65f4ef97ebf2f37a5b1b79ca7733d7b362ec963`. The recovery history below records earlier states of the investigation; the newly linked material supersedes its unfinished-browser-readback statements.

---

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

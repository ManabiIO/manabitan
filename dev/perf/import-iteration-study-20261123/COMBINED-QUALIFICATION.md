# Combined import qualification

This research campaign compares PR #801 (`1e235059a4c05c2509e8757fccba43a2d60222df`) with the frozen combination of PRs #809, #810 and #811 (`62891eb93d64877a404c9fc8025e0e051f6b5cfb`, tree `0fd0a2a237b66eb95061d3072d07d2c432abe1a5`). The exact combined tree has already passed 782 focused tests and the build check. No additional runtime change is introduced by this campaign.

Both arms receive the same five benchmark harness files from this workflow revision. Package differences must be exactly the five expected runtime JavaScript files. The immutable runtime sources, dependency lock, fixture hashes, package inventories and harness hashes are retained in each artifact.

Each dictionary has two independent fresh-runner replications. Each replication retains two warmups, two A/A control pairs before measurement, eight alternating AB/BA pairs, and two A/A control pairs afterward. Replication 2 reverses the initial arm order. No observation is removed for its timing. Timing ends at import completion before readback.

Every observation must preserve its physical probe digest across restart. Each arm must retain a stable physical digest across observations. Complete public exact-lookup responses for 12 source-derived terms must be nonempty, have no degraded dictionary availability, and match before restart, after restart, and across arms. These are sampled semantic checks, not exhaustive all-term browser readback.

Only physical reference offsets, raw encoded reference previews and their independently recomputed readable-preview counters may differ across arms. Every other physical field must match. See READBACK-QUALIFICATION.md for the original failed campaigns and the source of this storage-layout distinction. Those failures remain separate evidence.

The combined candidate does not invoke the external memory sampler. Original owned-shared memory reports excluded renderer processes and cannot establish whole-tree memory. A separate repaired memory-only campaign addresses that limitation without contaminating these uninstrumented timings.

This branch is an integration and evidence snapshot, not a production pull request or merge.

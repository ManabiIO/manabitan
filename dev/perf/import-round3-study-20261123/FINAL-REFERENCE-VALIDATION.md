# Final content-reference validation screen

This separate screen compares develop `5e1f8c12f7ff798ba407323aff675cb23b22af02`
with the final corrected #809 source `77123e6cdb3101d7c0a3ef22ace4ebb2c004f72e`.
The source package may differ only in `dictionary-database.js` and
`term-record-opfs-store.js`. The final candidate adds the builtin ArrayBuffer
byte-length getter to establish private backing storage before the existing
consecutive-reference shortcut. Missing or failed private-buffer proof selects
the original per-row path. Each run checks current metadata again after awaits.

The earlier factory-origin correction and its separate browser campaign remain
preserved at their original revision. Their measurements are historical and are
not used to qualify these final source bytes. The final follow-up passed 246
focused tests, scoped lint, main and test type checks, an all-target build dry
run, and a separate read-only review. The fresh checkout initially lacked its
generated libraries; those initial environment failures and the successful
checks after restoring unchanged libraries are both retained.

The full fixed experiment is unchanged: JMdict, Jitendex and VNDB each have two
26-observation replications, one warmup per arm, four A/A control pairs and eight
counterbalanced candidate pairs per replication. The second replication
reverses each candidate pair. All observations, controls and failures remain
retained. The UI timing boundary, pinned fixtures/browser/Node, package/source
guards and exact semantic and physical pre/post-restart readback are unchanged.
There is no process-memory sampling or selection of replacement observations.

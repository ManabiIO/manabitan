# Record-validation hosted evidence

The final six timing cells in [run 45124794707](https://github.com/ManabiIO/manabitan/actions/runs/45124794707) use research source `c0c2fdc79c9b4364e1a7fdfc915e5fd13ef332bc`, baseline `5e1f8c12f7ff798ba407323aff675cb23b22af02` and candidate `cf1e18d59d08da729d4b2fe45c7a07021f42360a` (PR #822). All six complete cells pass the raw source/package/clock/work/readback audit. The [round report](../20261123-r2-qualification/README.md) interprets the complete timing and control results without dropping slow observations.

The cohort contains 252 successful imports: 36 excluded warmups and 216 measured imports, comprising 72 candidate/parent pairs and 36 unchanged-code controls. Each observation has a fresh browser profile; forward and reverse cells use separate hosted jobs. Twelve persisted-content probes and full browser restart checks pass on every import, without claiming exhaustive persisted-output equality. No benchmark observation was retried or removed.

The archive preserves all expanded bytes from the six provider ZIPs, including preparation/source hashes, all observations, warmups, logs, completion receipts, raw analysis and the independent audit. Earlier partial artifact-list snapshots are retained as download history; they are not incomplete or replacement benchmark cohorts. Original ZIP hashes and inventories remain recorded.

- Archive: `raw-evidence.tar.xz`
- Bytes: 1,627,612
- SHA-256: `e99a655f2e811b9df0329750fb4834854e81fb6c993b5747f87ea628bd1b432f`
- Members: 1,696

The [manifest](manifest.json), [member index](raw-members.json) and [provider ZIP inventory](original-zips.json) bind the original bytes. Verify before extraction:

```sh
python3 dev/perf/import-r2-evidence-20261123.py verify builds/perf/20261123-r2-record-hosted
```

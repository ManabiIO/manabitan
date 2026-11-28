# Independent browser evidence audit

This pack audits existing observations. It contains no new import benchmark and makes no latency or process-memory claim.

## Frozen six-cell browser cohort

The original run is `46139342690`, tooling `0740b2d462a4be47f4ac0fdd20469d4f72cb52bc`, product source `16c1b9fb1e850fec5d1c3e1dba792b9c8a293e97`, product tree `c9bd2df5331c144d4988be32f29a64045a407786`. The exact artifact identifiers, outer ZIP digests, sizes and complete raw member inventories are retained.

The audit independently checked every outer archive, every member and every release-package entry. All 582 extracted package entries are identical across the six hosts. Package ZIP digests differ because the container bytes differ; each observation is checked against its own exact package digest. Source and tooling commits/trees, critical harness source hashes, fixture lock, ordinary SQLite bundle/wrapper, original and overlaid harnesses, and the observer/validator/normalizer identities are bound to the frozen public Git objects. The overlay is reproduced from the retained original harness and compared byte for byte.

The unchanged qualification validator, narrow storage normalizer and activation validator were rerun against every available raw report. The four complete Japanese-dictionary cells pass, including exact cross-arm and cross-host normalized semantic receipts. Each of their eight imports includes orderly restart, 72 lookup observations and the complete media check.

| Dictionary | Orders completed | Term bytes saved | Persisted activation when enabled |
| --- | --- | ---: | --- |
| JMdict | off-on and on-off | 41,004 | Five format4 chunks, 210,000 format4 rows, SQLite floor13 |
| Jitendex | off-on and on-off | 0 | All 22 chunks remain format2, SQLite floor10 |
| VNDB | Neither original cell completed | Not qualified by these cells | Raw activation is retained as a diagnostic only |

Both original VNDB cells reproduce the exact registered failure: the fixed 37-unit SAH allocation requirement rejected an actual 77-unit allocation. Each cell completed its first browser import successfully, then stopped at that gate. Its second scheduled import did not run. There were seven 4096-byte empty files and one 315,392-byte active file. The original37-unit gate was not relaxed during this audit. Raw activation receipts can be checked independently, but those diagnostic checks do not turn either failed cell into a successful cohort.

`format16c/audit-index.json` contains the complete compact result, and each cell contains an `independent-audit.json`. The complete original nonpackage members, including HTML reports, logs, observer sources, raw reports and original failures, remain in the archive.

## Distinct parent-only calibration

Run `46140891339`, artifact `15261649240`, observed unmodified parent `a300da36d00df8e353c5679b1528b50a1299b75f` with default null flags. This separate parent observation is retained under `parent-a300/`.

Its outer archive, all package entries, source identity, default flags and raw report digest were independently checked. Its full semantic receipt was recomputed with the observed 77-unit allocation as a calibration input. It verifies 72 lookups and all media and records exactly315,392 active SAH bytes. This supports the separately prospective exact 77-unit contract; it does not retrospectively qualify either failed 37-unit candidate cell.

The prospective VNDB-only derivative is source-reviewed at tooling `6650e56034b7c4e92451a7032fbf93ffd76d999f`, candidate `85a8aa49f76fbabd2dc494aad247f74774ff2573`. Its five source blobs are checked against that public tree. The runner adds only a source-bound exact parent allocation, schema2/candidate-tree proof and helper retention; the existing semantic validator, observer and term-file expectations remain unchanged. The workflow has both opposite VNDB orders and explicit Bash/pipefail. No outcome of that new acquisition is asserted in this pack, and no16c observation is relabeled as85a8.

## Reproduction

Download the six original GitHub Actions ZIPs by the artifact IDs in `audit-format16c.py`, using the exact archive filenames and hashes there. Place them next to the pinned-source receipt and execute:

```sh
python3 audit-format16c.py --artifacts ARTIFACT_DIRECTORY --pins pinned-source-receipts.json --output NEW_AUDIT_DIRECTORY
```

The separate calibration helper expects the fixed filenames and `independent-audit-1` directory used in this retained execution. It imports the same unchanged validator from that audited directory and reads the separately pinned parent ZIP. Its source and complete outputs are included.

The archive is deterministic: sorted member paths, fixed tar metadata and XZ compression. Its member manifest was verified by reopening the completed archive and hashing every member. Only each already-verified product `package.zip` is omitted from the compact archive; the original CI artifact retains it, and the compact pack retains its complete entry inventory, byte length and exact ZIP digest. No raw report, log or failed observation is omitted. Python bytecode caches are derived files and are not archived.

## Limits

This verifies the recorded correctness and storage receipts at their exact sources. It does not establish an elapsed-time gain, peak or settled process-memory gain, interrupted publication behavior, arbitrary corruption recovery or older-reader rejection. Those are separate gates. The original VNDB failures remain failures, and the parent calibration remains an observation of the parent only.

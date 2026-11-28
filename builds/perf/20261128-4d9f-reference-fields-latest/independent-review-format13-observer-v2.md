# Independent source review: reference fields format 4 / schema floor 13

## Reviewed identity and boundary

Reviewer: parser_analysis, 2026-11-28. This is an independent source review, not an execution or performance result.

- Base commit: `a300da36d00df8e353c5679b1528b50a1299b75f`, tree `5fe9ee5a3e2c27ce4e099cb3d6a598077027eac4`.
- Reviewed public candidate: `16c1b9fb1e850fec5d1c3e1dba792b9c8a293e97`, tree `c9bd2df5331c144d4988be32f29a64045a407786`, direct parent a300da36.
- Format integration manifest: Git blob `65b1143fc746d05ee903ddaf3d16035cdb873721`.
- Database implementation: `df112949e5092ded1ce1f584bff4ff56be18480e`.
- Record-store implementation: `fcf4b908938d818a456574352446d95e71623713`.
- Content-reference iterator tests: `a574cb93ee42cae2445dea91fd510ff0d8d028b6`.

The reviewer fetched the public commit/tree through the GitHub API and compared every path in the twelve-file integration manifest against that tree. All twelve matched. The four observer files also matched the immutable sources listed below. No runtime or test source was modified by this review.

**Finding: no source blocker found in the reviewed floor/epoch, bounded iterator, or observer serialization changes.** Hosted execution and current-source corpus/browser qualification remain separate gates. Prior f28 or dcfc observations must not be relabeled as a300 qualification.

## Schema floor and online content roots

The earlier format4 prototype used floor12. Base a300 already assigns floor12 to positive online-content epochs, so that earlier assignment cannot be retained.

The candidate keeps the base migration floor unchanged and distinguishes:
- floor10/11 with epoch0;
- floor12 with a positive online epoch;
- floor13 with either epoch0 (format4 without an online root) or a positive epoch (both capabilities).

The open path rejects negative or nonintegral epochs, a positive epoch below12, and epoch0 at exactly12. A supported floor13 is not incorrectly required to have a positive epoch. Unsupported future floors remain rejected before recovery or payload mutation.

The actual record-store end-import metrics supply the number of reference-table chunks to publication. A requested experimental flag alone does not raise the floor. When an actual format4 chunk was emitted, the existing transaction raises the required floor to13 before publishing the import receipt. Packed-media-only publication retains its requirement11.

The two existing online publication paths still require12 through the common monotone version helper. That helper now accepts a current13 and does not lower it to12. Importing packed media also preserves a previously installed13. The change therefore does not reintroduce the old floor12/epoch collision or downgrade a database with format4 records.

## Authoritative content-reference iterator

The new iterator handles format4 in the authoritative index, alongside the existing formats1/2/3. Cold/scoped/repair support is retained by the integrated reader changes; this review particularly examined the new a300 online-optimization iterator because it did not exist in the old f28 qualification.

### Validation before references escape

The iterator uses the common strict field-layout decoder. For format4 it checks the entire authoritative field region, through aligned streamed checksum pages, before emitting references:
- Every table offset is checked with the existing safe content-offset rule, including offsets for unselected and unused table entries.
- The two-byte length representation admits its existing null sentinel.
- Odd reference-table padding must be zero.
- Every row reference key must be in the reference table.
- Every row score key must be in the score table.
- The complete field checksum must match.

Four-byte-aligned page offsets and lengths keep uint32 and uint16 values whole. The score-key column can begin at an offset congruent to2 modulo4 for odd row counts; validation starts at the actual column boundary and steps by2. It does not skip the first or last score key in that case. Truncated or malformed unused values therefore fail before a batch can hide them behind a sparse selection.

The minimum plausible index-size guard is reduced to accommodate a legal four-byte-per-row representation. The existing maximum-size guard and complete framing/checksum requirements remain; the smaller lower bound does not replace those checks.

### Bounded gathering and ordering

After verification, the iterator reads the selected rows' reference IDs and score keys and sorts a private Uint32Array containing packed (reference ID, row ordinal) pairs. Existing limits on returned batch size and reference-table count keep the packing within uint32; numeric Uint32Array sorting preserves the intended order.

Only duplicate or consecutive distinct selected reference IDs are coalesced. A pair of far-apart selected IDs cannot cause a min-to-max table read. At most six table bytes are read per selected unique reference, in addition to the four row-key bytes per returned row. This is the stated ten source-byte-per-row input budget, plus the existing descriptor charge; it is not a claim that total live JavaScript allocation is ten bytes per row.

The scatter writes decoded offsets and lengths back to the original row order. Returned record IDs and interior cursor suffix ownership therefore remain stable despite the private sort.

All awaited reads continue through the existing ownership/generation guard. The new path does not create foreground cache state, trigger repair, or mutate the durable cursor schema. Previously portable cursors, interrupted verification, stale-owner handling, and per-block interior continuation are retained.

### Source tests examined

The added iterator cases cover all four formats; safe large offsets and null lengths; JSON cursor transfer to a fresh store; interrupted verification; format2 and format4 interior cursors; odd row counts; sparse selected references whose full table exceeds the byte budget; malformed unselected offsets; reference/score sentinels; odd padding; checksum/truncation; and ownership preemption during gathering.

The database tests in the manifest cover the new floor/epoch matrix and monotone publication paths. This note does not claim those tests were executed by the reviewer.

## Browser observer v2

Reviewed blobs:
- `activation_overlay.py`: `3d3c7039f9b9a0fba4e3880e325350866ed4352c`.
- `storage-activation.mjs`: `b20a22dd097a8f551e890120851e2a7e0cdc0852`.
- `test_activation_overlay.py`: `eabdcd09be181acdd09b845669e98c6dbc5823e1`.
- `storage-activation.contract.mjs`: `b528451127b29c28370460b6eced025d7d673c9a`.

The public candidate retains the exact original E2E source, Git blob `142825fbd36090d693de416801eac50312194ef2`, SHA256 `d0ae122bd22f7b460cedb11f06d2cb018224674abf9669e0fed567b5f3a870cf`. The overlay requires that digest and unique insertion anchors. The original release package is unchanged by this tooling overlay.

### The previous missing-serialization failure is addressed

The E2E harness writes an explicit `createReportJsonSummary` projection. Merely assigning a field to the in-memory report was insufficient. Version2 adds `referenceFormatActivation` to that actual projection.

The Python contract extracts the actual overlaid projection function and executes it in Node, then checks that successful, running, and failed observer witnesses survive JSON serialization without altering the existing benchmark object. This tests the boundary missed by version1.

The six older a723 browser observations with missing serialized activation evidence remain failed activation acquisitions. Version2 does not retroactively qualify their absent witness.

### Read-only observation and limits

The observer runs after ordinary restart, persisted-content probes, lookup validation, media verification, and the final OPFS inventory. It performs bounded file reads without creating files/directories or acquiring write handles.

It verifies authoritative index framing and exact file exhaustion, descriptor/index generation linkage, complete row intervals, per-format dimensions and counts, and the format4 strict-size-saving condition. It binds the installed floor to the uniquely associated SQLite main database through the pinned SAH-pool association header and digest, and rejects a live WAL, hot rollback journal, changed main header, or changed file size.

The validator requires the expected floor/counts/rows, includes format4's floor13 requirement, and preserves the ordinary semantic validator rather than weakening its field schema. The receipt is explicitly not eligible as timing evidence.

This supplemental observer reads headers and dimensions, not every field value or lookup payload. Full decoded corpus/file parity is a separate oracle. It also does not independently establish the database's online epoch; the runtime open and publication tests cover that separate relationship. These limits are appropriate and must remain explicit in publication.

## Remaining gates

- Execute the exact current integration's focused/full unit, type, lint, build, and native-asset gates.
- Run current-source corpus and browser qualification with the exact source/package identities.
- Retain all earlier failures and source boundaries.
- Make no elapsed-time or process-peak-memory claim from this source review or from the header observer.

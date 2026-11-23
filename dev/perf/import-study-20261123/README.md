# Import pipeline study, 2026-11-23

This study measures complete production-default imports of the locked JMdict,
Jitendex and VNDB archives. The first candidate moves some synchronous index
flushes into the ordered write pipeline. Its frozen source is
`e31032d575e329e6021b96359a74e825707004b3`; the baseline is
`5e1f8c12f7ff798ba407323aff675cb23b22af02`. The only permitted packaged product
difference is `js/dictionary/term-record-import-index-writer.js`.

## Predeclared acquisition and decisions

Every observation launches a fresh persistent Chromium profile, imports one
dictionary, verifies its content, restarts the browser and verifies persistence.
The authoritative boundary is the browser's file-input change through post-UI
import completion. Builds, downloads, content readback, restart and media checks
are outside that interval. Traces, process sampling, experimental flags and
headed fallback are disabled. Node is pinned to 22.22.0; Chromium is selected by
the unchanged dependency lock. Both source trees use exactly the same overlaid
measurement files and verified archive bytes.

| Stage          | Excluded warmups | Measured order               | Imports per corpus |
| -------------- | ---------------- | ---------------------------- | -----------------: |
| Discovery      | A, B, C          | ABC, BCA, CAB                |                 12 |
| Confirmation 1 | A, B, C          | ABC, CBA, BCA, ACB, CAB, BAC |                 21 |
| Confirmation 2 | C, B, A          | BAC, CAB, ACB, BCA, CBA, ABC |                 21 |

A and C use the identical baseline package. B uses the frozen candidate. Each
discovery arm appears once in every position. Each confirmation uses all six
permutations and runs on a separate hosted job. All three corpora remain in the
matrix, including corpora for which no benefit is expected.

Discovery is a screen, not a production speed claim. A corpus advances only if
median paired B/A and B/C changes are both at most -5%, both equal-work totals
improve and at least two of three pairs improve against each baseline. At least
one corpus must qualify. An apparent material regression in another corpus
blocks promotion and must be resolved in independent confirmation. No candidate
is promoted solely from discovery.

For confirmation, freeze the runtime SHA, dependency lock, measurement source
files and expected packaged member differences before launching either of the
two replications. Set `stage` to `confirmation` and name the retained discovery
campaign in `confirmationOf`. Both replications must independently retain at
least a 5% median improvement against A and C, improve equal-work totals and
have at least five of six faster pairs against each baseline in a benefiting
corpus. No material regression may remain in the other corpora. Compare complete
packaged member maps and all measurement-source hashes across replications.
The media-readback revision below is an explicit difference from discovery;
compare that small source diff instead of asserting identical whole-harness
hashes across the two stages. The dependency lock, production package members,
timing boundary, import controls and fixed acquisition schedules remain frozen.

Report the identical-code C/A controls separately, without subtracting them.
Unstable controls make a result inconclusive and call for a separately declared
confirmation, not a corrected point estimate. Do not remove tails, replace
failed imports, extend a schedule after inspecting output, tune the metric or
retry until a preferred result appears. Every acquired observation, warmup,
failure and partial schedule remains in its original artifact. A failed command
stops that cell; missing observations cannot pass verification.

## Readback and provenance guards

The public exact-lookup responses for 12 deterministic source-derived terms are
retained in full before and after restart. Every requested term must return a
nonempty response without degraded dictionary availability. Every response field
must match across restart, warmups, arms and measured observations. The expected
entry counts are 12 for JMdict, 17 for Jitendex and 13 for VNDB. These are sampled
semantic checks, not exhaustive browser lookup of every imported term.

Physical diagnostic probes remain stable within each package and across restart.
Across packages only encoded-reference locations, raw encoded previews and their
independently recomputed preview counter may differ. Complete semantic equality
remains mandatory. The corrected sampling path is adapted from the peer's final
readback harness at `d9268d445d528da74a452e75d07872eebd9b7e00`, which qualified
PR #810; no product change from that PR is included.

All corpus row and media counts must match before and after restart. VNDB also
compares five deterministic persisted image byte streams to the locked ZIP,
including the first, one-third, two-thirds and last source images plus
`img/cc18737.webp`. Their expected sizes and SHA-256 hashes are independently
computed from the locked archive before timing.

The discovery harness at `6427e3d801f797271cd1e68b038f9babe13ac18d` has Jitendex
media-count and sampled complete-response checks, but no image-byte comparison.
This separately prepared revision adds every one of its 236 referenced images:
201 AVIF and 35 SVG files, totalling 4,992,155 uncompressed bytes. The locked ZIP
contains 249 image members; 13 unreferenced SVG files are correctly excluded.
Before timing, the Python driver independently traverses every source term bank
and requires its complete image-reference set to equal the frozen probe list.
It computes source byte lengths and hashes directly from that verified ZIP.

After import and again after browser restart, the browser harness retrieves all
236 persisted images and compares each MIME type, byte length and SHA-256 digest
with its source member. Raw media probe receipts are retained and independently
checked by the verifier. These stronger checks run after the timed import;
they do not alter runtime code or import options. The original discovery scope
and artifacts remain intact. This does not establish exhaustive all-term
semantic readback or exhaustive VNDB image readback.

The verifier recomputes authoritative timing and all comparison arithmetic from
raw reports. It rejects source/package/fixture/browser mismatches, unexpected
package members, changed measurement files, skipped verification, traces,
fallback storage, missing observations, semantic corruption and unstable
same-package physical results. Optional phase metrics retain missing pairs;
missing measurements are never substituted with zero. Phase times may overlap
and are diagnostic, not additional independent speed claims. No peak-memory
claim is supported by this study.

## Existing baseline diagnosis

These figures are medians of the twelve original A observations in each corpus
from the prior qualification. They are descriptive and do not belong to the new
candidate's discovery schedule.

| Metric                            |   JMdict | Jitendex |      VNDB |
| --------------------------------- | -------: | -------: | --------: |
| Complete import, ms               |   730.65 |  1330.45 |   8065.65 |
| Archive and index, ms             |      8.0 |     10.0 |     164.5 |
| Import data banks, ms             |    563.0 |   1151.0 |    5883.5 |
| Bulk finalization, ms             |    127.0 |    136.0 |    1934.5 |
| Term-record close region, ms      |   111.30 |   109.75 |   1912.70 |
| Term-record queued-write wait, ms |     1.65 |     5.00 |      2.65 |
| Lookup-index write calls          |        5 |        6 |        83 |
| Lookup-index written chunk bytes  | 23693336 | 23526384 | 401899752 |

The close-region ranges were 81.3-114.1 ms, 106.5-112.5 ms and 1758.8-2237.7 ms,
respectively. That region includes final pending writes, header seek/write,
synchronous flush and stream close. It is not a measurement of kernel close
alone. Chunk bytes exclude file headers and are not direct persisted file-size
stats. Per-file sizes and close counts were not retained.

Both existing JMdict and Jitendex traces contain CPU-profile frames in
`SyncImportIndexWriter._writeBytes`, `writeChunks` and its finalization closure,
establishing that the synchronous writer ran in those traced candidate imports.
The VNDB receipt reports a dedicated worker with `createSyncAccessHandle`
available, but its actual writer branch has no retained activation counter and
the previous study retained no VNDB trace. Do not infer a measured flush count
from capability alone.

## Run and verify

The workflow `.github/workflows/import-study-20261123.yml` launches the matrix
declared by `config.json` when the dedicated study branch is pushed. Each job
preserves its raw evidence even on failure. Local browser execution is currently
blocked before navigation by `process_singleton_posix.cc: socket() EPERM` with
the Chromium sandbox enabled; no sandbox or application-security bypass is used.

```sh
node --test dev/perf/import-study-20261123/verify.test.mjs
python3 dev/perf/import-study-20261123/test_media_reference.py
python3 dev/perf/import-study-20261123/run.py --matrix
python3 dev/perf/import-study-20261123/run.py --dictionary vndb --replication 1
node dev/perf/import-study-20261123/verify.mjs builds/import-study-20261123/vndb/1
```

The final command is readback and arithmetic only; it does not launch Chromium or
re-run imports. `result.json` retains every acquisition and every primary and
diagnostic pair. The original summaries, complete JSON/HTML reports, host
snapshots, logs, build identities, source snapshots and package-member maps remain
beside it.

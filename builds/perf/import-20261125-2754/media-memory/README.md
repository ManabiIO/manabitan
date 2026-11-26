# Current native media projection: memory evidence

**Memory qualification remains blocked.** Both Jitendex replications pass;
both VNDB replications fail the frozen covered-scan-gap requirement. All
correctness receipts pass. These memory diagnostics do not establish import
speed and do not supersede earlier failed cohorts.

## Frozen identity and protocol

- Workflow run: [45642179064](https://github.com/ManabiIO/manabitan/actions/runs/45642179064).
- Baseline commit: `7d1643e6147a10cb2165e9744cf0e63b59e46632`.
- Baseline tree: `99d23f16e973c7ae9feba77ca3643d1c27dfb93d`.
- Candidate commit: `7a8b25a44a3fe165107ed816377cc72bb0fac67d`.
- Candidate tree: `093a0be94fcf336ab5a0113b80fae7481855935a`.
- Scheduled observations: replication 1 `A1 B1 B2 A2`; replication 2 `B1 A1 A2 B2`.
- Memory gates: median paired increase at most 5%, every paired increase at most 10%, for both PSS and private memory; every observation and both replications must qualify.
- Coverage: at least five complete import scans, covered pre/post brackets within 250 ms, no covered scan gap above 250 ms; 25 ms wait between scans.

The observer and raw-scan auditor are byte-identical to their original
`f2f08c8ee74cdea548c5c1b494ec15bf10360b46` sources. The archived protocol,
workflow, marker overlay, tests, and implementation are the exact versions
captured by the acquisition. No new browser acquisition was performed during
the audit or archiving.

## Results

| Corpus   | Replication | Qualified observations | Median PSS change | Median private change | Result |
| -------- | ----------- | ---------------------- | ----------------- | --------------------- | ------ |
| Jitendex | 1           | 4/4                    | -2.5578%          | -3.1031%              | Pass   |
| Jitendex | 2           | 4/4                    | +1.8317%          | +2.5668%              | Pass   |
| VNDB     | 1           | 3/4                    | Null              | Null                  | Fail   |
| VNDB     | 2           | 1/4                    | Null              | Null                  | Fail   |

The four VNDB coverage failures are replication 1 A2 at 350.425804 ms, and
replication 2 B1 at 324.494085 ms, A1 at 258.866332 ms, and B2 at 275.215655 ms.
Every observation has enough complete scans and valid boundary brackets. No
observation has an unreadable import-window address space. The recorded
exited-zombie exception in Jitendex replication 2 B2 satisfies the unchanged
observer rule.

All 16 correctness observations pass. Per-arm package-member hashes match
across all four artifacts; each package contains 616 members and exactly the
four frozen baseline-to-candidate product differences. All eight correctness
receipt keys per dictionary match across replications. Actual storage is equal
in every pair, including VNDB's 528,384-byte active SAH file. The prospective
129–131-unit allowance does not conceal an actual delta in this cohort.

See [the complete independent audit](independent-current-media-audit.md) and
[its exact machine-readable results](independent-current-media-audit.json) for
all per-pair maxima, coverage, storage, package identities, and failure records.
These are sampled, non-atomic maxima, not exact peaks. Unqualified observations
and replication medians remain null. The single qualified VNDB pair cannot
replace the failed coverage.

## Archived artifacts

| Artifact ID | Corpus   | Replication | Original artifact SHA-256                                          |
| ----------- | -------- | ----------- | ------------------------------------------------------------------ |
| 15035921814 | Jitendex | 1           | `d60df0b581f6278b14e8afb6e199e41c77a2c891e470f662cff08d614dc57e6b` |
| 15036925291 | Jitendex | 2           | `a4cd351a062953176543dcb442c7b2a1e11641efdeb0992a358588d68b8769ea` |
| 15036831091 | VNDB     | 1           | `61d4ded17022539714c6892a2954d49a485a08dbbd58047f065277ed5cd21795` |
| 15035433747 | VNDB     | 2           | `79daf7b337b181b56146adbd71404c32184cc8e73b26b404f89e7ac55b506ae7` |

[Original GitHub metadata](github-artifacts.json) retains names, IDs, sizes,
creation/expiry times, download/API URLs, workflow identity, and provider
digests. Each downloaded original ZIP was checked against that metadata before
archiving. The original artifacts were scheduled to expire on 2026-12-09; this
committed text archive preserves the observation evidence independently of that
retention window.

`media-memory-45642179064.text.tar.gz` contains 338 regular UTF-8 files totaling
56,926,812 uncompressed bytes. It is 2,912,149 bytes compressed, SHA-256
`cb0e31c84c9b90f41a727e3833fda82547298cf636c2a4814203abff20044a18`.
The archive preserves every original non-ZIP artifact member verbatim, plus
the independent audit and original artifact metadata. Every retained file has
an entry in [archive-manifest.json](archive-manifest.json).

The four original Actions ZIP containers and their eight `A-product.zip` /
`B-product.zip` payloads are omitted explicitly. The manifest records each
omitted package's size and SHA-256. Original package-entry manifests, identities,
build logs, and the completed receipt audit remain included. No raw scan,
marker, failure, observation report, protocol, or textual receipt is omitted.
Reopening exact package bytes later requires the original artifact ZIPs or
matching downloaded copies; package-entry manifests alone are not a substitute
for that byte-level re-audit.

## Reproduce the raw-scan audit

From this directory, verify and extract the retained text archive:

```sh
sha256sum -c SHA256SUMS
mkdir extracted
tar -xzf media-memory-45642179064.text.tar.gz -C extracted
```

For each artifact ID, run its captured auditor against its original reports:

```sh
python3 extracted/artifacts/15035921814/source/dev/perf/import-memory-20261124-3aac/audit_memory.py extracted/artifacts/15035921814
```

Repeat for the other three IDs. This recomputes every scan qualification,
coverage gap, maximum, pair delta, and cohort gate offline. The exact observer
and protocol sources are included alongside the auditor. To rerun
`verify_receipts.py`, first supply the matching omitted `A-product.zip` and
`B-product.zip` in the extracted artifact directory, verifying their hashes
against the manifest. Then invoke the captured `verify_receipts.py` with the
same artifact-directory argument. The original independent orchestration
script is retained under `independent-audit/`; its original local paths are
preserved for provenance.

`pack_text_evidence.py` reproduces the compact archive from the original four
extracted artifacts and their original ZIPs. It verifies all source members
against their original ZIP, normalizes tar ownership/mode/timestamps, fixes the
gzip timestamp, builds twice to require identical bytes, and checks every
retained file after decompression. It leaves all original downloads untouched.

# Owned shared content: corrective browser evidence

This addendum retains two complete hosted campaigns separately. The original
24-job campaign is a separate evidence package and is not replaced here.

| Campaign | Run | Harness commit | Outcome |
|---|---:|---|---|
| Corrective semantic readback, all three corpora | 45112249581 | `a2bd2b8266898983ea1f7df0c44282495df0c0f3` | JMdict and VNDB passed; both Jitendex replications remain failed |
| Final derived-counter guard, Jitendex | 45113545482 | `d9268d445d528da74a452e75d07872eebd9b7e00` | Both replications passed |

Both campaigns compare baseline `1e235059a4c05c2509e8757fccba43a2d60222df`
with the identical runtime candidate `51f095912b11ddd158ac173698eb322e2be99d12`
from PR #810. The independent audit verifies that each arm's complete packaged
member map is identical across all eight cells. Only the parser and parser-worker
JavaScript files differ between arms. The JavaScript timing and readback harness
is identical between these two campaigns. The final Python driver adds a
post-timing derivation check; its exact source diff is included.

## Results and scope

Each replication retains 26 observations: two excluded warmups, two A/A pairs
before, eight counterbalanced A/B or B/A pairs, and two A/A pairs after. Every
original observation remains in acquisition order. Values below are medians of
the 16 paired percentage changes across both replications, not percentages
computed from aggregate means or medians. Negative values mean faster imports.

| Campaign and dictionary | Paired median | Faster pairs | A/A range | Interpretation |
|---|---:|---:|---:|---|
| Corrective JMdict | −0.604514% | 10/16 | −2.905091% to +2.009132% | Guards pass; effect is small relative to controls |
| Corrective VNDB | +1.182756% | 5/16 | −13.515637% to +3.167278% | Guards pass; no demonstrated improvement |
| Corrective Jitendex | −13.273067% | 16/16 | −15.662351% to +0.629309% | Original physical counter guard failed; descriptive only |
| Final Jitendex | −14.558087% | 16/16 | −7.008192% to +0.921263% | Both fixed replications pass their strengthened semantic and physical checks |

Final Jitendex replication medians are −14.938928% and −14.518253%, each with
all eight pairs faster. Authoritative timing starts at the file-input change and
ends at the browser's import completion; readback and browser restart follow the
timed interval. All source, package, fixture, browser version, production-default,
error, count, and restart checks are independently verified against raw reports.

The semantic checks retain complete exact-lookup responses for 12 deterministic
probe terms, including 12 JMdict entries, 17 Jitendex entries, and 13 VNDB entries.
Every response is nonempty and has no degraded dictionary-availability result.
Their complete JSON digests and values match across both arms, all replications,
both campaigns, and before/after restart. This is sampled semantic readback,
not exhaustive browser readback of every imported term.

Jitendex has exactly 25 physical differences: 12 encoded-reference offsets,
12 raw reference previews, and one derived `readablePreviewRowCount` (0 versus 1).
Every other physical field matches. The verifier recomputes each preview counter
from its own retained rows, checks that the differing counter has differing raw
preview inputs, and requires stable physical results within each package before
and after restart. The final probe has decoded glossary content in both arms.
Raw reference previews are layout diagnostics; they are not decoded glossary
availability. No directly persisted file-size stat was retained, so this package
does not present an inferred storage length as a direct measurement.

The earlier corrective Jitendex jobs disallowed that derived counter difference.
Their failure, missing `results.json`, raw observations, physical differences,
and decoded workflow logs remain intact. The final campaign does not retroactively
qualify or replace those failed jobs.

## Memory diagnostics remain unqualified

All 24 post-timing memory observations are retained and excluded from timing.
Their 2,197 scans include 2,193 scans with exactly one discovered PID. The original
sampler filters names derived from `argv[0]`, which does not establish complete
Chromium renderer/import-worker coverage when process titles are rewritten.
The recorded sums and maxima recompute correctly, but these data support no
whole-tree peak or memory nonregression claim. This limitation applies to both
campaigns independently of the valid import timing and semantic checks.

## Verify without running imports

Requirements: Python 3.10 or later, Node.js 22 or later, and approximately
220 MB of temporary disk space. No npm dependencies, fixture downloads, GitHub
access, browser, native compiler, or Manabitan runtime are needed.

Run from any directory, using the path to this package:

```sh
python3 /path/to/this/package/verify_package.py /path/to/this/package
```

To select a Node executable explicitly:

```sh
python3 /path/to/this/package/verify_package.py /path/to/this/package --node /path/to/node
```

The verifier checks every package hash and compressed raw member, extracts only
verified regular files into a temporary directory, and runs the standalone
JavaScript audit. That audit uses `JSON.stringify` to reproduce the browser's
exact semantic/physical digests. It independently checks all 208 timing
observations plus the 24 excluded memory observations: 464 before/after states,
5,568 physical counters, and 8,088 physical rows. Python separately recomputes
all pair arithmetic. Temporary extraction is removed afterward.

`readback-audit.json` contains the detailed derived receipt, including every
observation's original report/summary identities, physical differences, pairs,
controls, and qualification status. `raw-receipts.tar.xz` preserves all 1,526 raw
and source files byte-for-byte, including every warmup, control, successful and
failed observation, memory sample, full raw response, original member manifest,
API metadata snapshot, and exact harness source. Nothing is deduplicated or
filtered. `raw-members.json` identifies every retained byte stream.

Original Actions ZIP digest/size provenance and complete ZIP inventories are
retained in `original-zip-verification.json`. Collection and packaging each
independently checked the original ZIP containers and every extracted byte.
For compactness, this deliverable retains uncompressed members in one
deterministic cross-file tar/XZ stream rather than duplicating the original
ZIP containers. The portable verifier can verify every retained raw member;
rechecking an original ZIP-container hash additionally requires that original
download. Original ZIPs remain in the collection workspace, and their artifact
IDs and API URLs are included. Hosted artifacts may expire.

## Rebuild the package or repeat the original campaigns

`build_evidence_package.py` accepts the original collection directory and a new
output directory. The collection directory must include the original ZIPs and
both run-ID directories. It refuses to overwrite an existing package, verifies
the API-advertised ZIP hashes and full member inventories, then writes sorted
regular tar members with fixed metadata and a gzip header timestamp of zero.

```sh
python3 /path/to/this/package/build_evidence_package.py /path/to/original/collection /path/to/new/package
```

The exact original drivers, workflow YAML, fixture lock, dependency lock, sampler,
and JavaScript harness files are under each run's `source/` directory inside the
raw archive. `source-identity.json` records their commit and byte hashes. To repeat
browser measurements, use a fresh checkout of the corresponding immutable harness
commit and its exact workflow, including pinned Node 22.22.0, pinned Chromium,
locked archives and original matrix; do not mix corrective and final policies or
replace original observations. Reproduction of the audit requires none of that
runtime setup.

Source run URLs:

- https://github.com/ManabiIO/manabitan/actions/runs/45112249581
- https://github.com/ManabiIO/manabitan/actions/runs/45113545482

Publication should keep this addendum in its own evidence directory alongside
the earlier component and original-browser packages. It contains no runtime
patch and does not change the original failed receipts.


## XZ publication transport

This is a separate transport variant of the frozen gzip package. No raw TAR
member, order, metadata, padding byte, observation, semantic result, derived
analysis, or original failure was changed. `transport-derivation.json` records
the original gzip/package identities and identical SHA-256 hashes of the entire
uncompressed TAR from both gzip and XZ. The verifier checks that identity as well
as every original member. The original frozen package remains unchanged.

Only the transport filename, verifier, manifest and this README were adapted;
the original freezer/build helper remains byte-identical and still creates the
original gzip format. To create this publication variant from that frozen output:

```sh
python3 /path/to/this/package/convert_to_xz.py /path/to/frozen/gzip/package /path/to/new/xz/package
```

The converter uses Python standard-library `lzma` preset 6 (8 MiB dictionary),
streams the unchanged TAR bytes, independently rehashes the decompressed XZ, and
refuses to replace an existing destination. It scans support files and every raw
member for signed acquisition URL patterns without printing URLs. No tool-issued
signed download URLs or download-request scratch specifications are retained.
The variant still has the original ZIP-container provenance limitation stated
above; changing compression does not change the evidence's scope.

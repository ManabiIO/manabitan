# Original import campaign 45110694360

This package freezes all 24 cells of the original Linux Chromium comparison:
https://github.com/ManabiIO/manabitan/actions/runs/45110694360

The harness commit is `088d9c22ccd2b0dc05b240355c76320c9660ce3e`.
All 624 timed observations are retained in recorded order: 48 warmups,
384 candidate observations (192 AB/BA pairs), and 192 baseline-control
observations (96 AA pairs). Sixteen separate memory diagnostics are retained.
No observation or failed guard was removed or replaced.

## Storage and verification

`raw/original-members.tar.xz` contains every original Actions artifact file,
byte for byte, including all reports, observations, logs, identities, package
member manifests and raw memory samples. The complete original TAR byte stream is unchanged. XZ uses standard-library
LZMA preset 6 with an 8 MiB dictionary and deterministic output. Original ZIP containers are not
duplicated here. Their independently verified API digest/size and complete
member inventories remain in `acquisition/`; final API metadata and failure
job logs remain in `provenance/`.

Run `python3 source/verify_campaign.py` from this package directory. It verifies
all package files and original member bytes, reconstructs schedules, compares
raw browser boundaries/source/package/count/readback guards, recomputes paired
statistics, and verifies the original memory aggregates. It runs no imports.
The original collection/analyzer/freezer and harness sources are in `source/`.

The standalone original analyzer can be reproduced from the acquisition ZIPs:
download each artifact ID from the run through the GitHub Actions artifact API,
verify its advertised ZIP digest/size, retain the original directory layout,
and run `analyze_campaign.py` with the included final API and reference files.
Only its generated timestamp may differ. The included verifier instead works
directly with the compact lossless member archive and needs no network access.

## Interpretation and decisions

See `derived/analysis.md` and `derived/analysis.json` for every fixed pair and
baseline control. Negative percentage changes mean lower import time. Passing
guards establishes comparable evidence; it does not itself establish a speedup.
The measurement boundary is the browser file-input change through post-UI
import completion. Restart/readback and memory diagnostics are outside timing.

Twenty-two cells passed the original timing guards. Both owned-shared Jitendex
cells failed the cross-arm sampled-content digest and have no qualified
`results.json`. Their timings remain descriptive only, regardless of later
corrective campaigns. Original source/package/count/restart evidence is kept.
The original browser digest sampled 12 terms and could encode physical content
references; corrected semantic readback campaigns are separate evidence.

The original memory sampler did not establish whole Chromium/import-worker
coverage: 2,161 of 2,164 scans captured just one PID. The exact argv[0] basename
filter can omit Chromium processes after process-title rewriting. Original
readings cannot support whole-tree peak-memory or memory non-regression claims.
See `derived/memory-coverage-audit.json`; repaired memory runs are separate.

CRC word-loop decision: do not promote research commit
`930083af581bd4d8fe8dc42fe7e443e57666f8f9` to a production PR. Preserve its branch
and all local/hosted observations. Whole-import changes across the three
corpora are small and overlap baseline-control variation, so the evidence does
not justify the additional native/Wasm complexity.

The Actions artifact ZIP hashes were independently recomputed at acquisition.
Extension build ZIPs are absent: their recorded hashes were cross-checked with
every observation and complete packaged-file hash manifests. Full VNDB media
payload correctness lives in the separate component package; the browser
sampled readback here is not represented as full-payload coverage.


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

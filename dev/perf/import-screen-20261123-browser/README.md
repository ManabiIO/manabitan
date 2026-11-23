# Frozen import comparison evidence

This directory retains every result from the fixed browser comparisons listed in
`index.json`. Each `.tar.xz` archive contains the exact bytes of the complete
observation summaries and raw JSON phase reports, the final comparison state,
the protocol, and the runner and workflow used for that cohort. Compression is
deterministic; no result fields or observations are removed from those files.

Each adjacent `.manifest.json` binds every retained file by length and SHA-256,
the archive by SHA-256, and the original GitHub artifact by ID, SHA-256, API URL,
workflow run, source commit, creation time, and expiry. The original GitHub ZIPs
have a 30-day retention period. The archives in this directory preserve the
measurement and verification evidence after those artifacts expire.

The final comparison state already embeds every source/tree identity, package
member hash, and harness hash. Separate copies of those maps, intermediate
progress snapshots, HTML views, and console logs are therefore left in the
original GitHub ZIP rather than duplicated here. Every observation's complete
result JSON and raw phase-report JSON are retained.

The `media-ranges` study measures the superseded V2 source snapshot. Its full
cohort remains historical evidence. The `media-adjacent` study measures the final
PR head with the exact-adjacency guard and is the applicable media qualification.
These cohorts must not be combined or treated as interchangeable versions.

## Independent verification

From a checkout containing the frozen baseline Git object:

```sh
python dev/perf/import-screen-20261123-browser/audit_screens.py \
  dev/perf/import-screen-20261123-browser \
  --bundles --repository . \
  --output /tmp/manabitan-import-screen-audit.json
```

For added study specifications, append `--studies` with the corresponding JSON
file. The audit verifies archive/member hashes before unpacking to a temporary
directory. It checks the locked fixture and unchanged harness against baseline
Git objects; source, package, browser, and timing provenance; exact observation
order; the browser-clock timing boundary; term counts; production lookup result
hashes; restart checks; media results; and all reported comparison arithmetic.
`audit.json` records the latest completed audit of the retained bundles.

To inspect one archive manually, use `tar -xJf <archive>` in a scratch directory.
`bundle_evidence.py` is the reproducible packer; it additionally checks that every
retained member is byte-for-byte identical to the original GitHub ZIP.

## Interpretation limits

Each complete cohort has three warmups, six predeclared balanced blocks of three
arms, and two exhaustive media diagnostics: 23 observations. A and C are
independently built copies of the unchanged baseline; B is the isolated change.
Timed imports use fresh profiles and the existing release benchmark with
production defaults, without tracing, phase profiling, process sampling, or
screenshots. Diagnostic imports are excluded from the timed comparison.

These are exploratory single-runner screens, not cross-device qualification or
promotion evidence. The lexical correctness checks use 12 probe terms and 72
production lookup responses per observation; they are not an exhaustive lexical
output comparison. The final media diagnostics read all locked referenced
images for A and B. Raw persisted output digests and storage-byte counts remain
recorded diagnostics, not cross-arm equality gates. No peak-memory inference is
supported. Control variability and all individual observations must be considered
before interpreting a small timing difference as an improvement.

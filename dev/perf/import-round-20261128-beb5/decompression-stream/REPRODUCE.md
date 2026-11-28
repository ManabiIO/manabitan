# Audit and reproduce the frozen experiment

## Read-only audit of the saved campaign

The audit requires Python 3 and Git, but no browser, Node, dependency install or
benchmark execution. Obtain a clean checkout of research commit
`70f3cda48ba768979a117f58a3901334d402f700` from branch
`perf/decompression-stream-chromium-20261128-beb5`. A local commit with the exact
same tree `17ff7a2b17c9130f43c347791567a6a9b0e631a0` is also accepted. The checkout
must have its tracked source files materialized; generated `ext/lib` assets are
not needed by this auditor.

From this evidence directory, verify and extract the immutable original ZIP
into a new temporary directory, then run:

```sh
python3 -c 'import hashlib, pathlib; p = pathlib.Path("artifact.zip"); assert p.stat().st_size == 220443; assert hashlib.sha256(p.read_bytes()).hexdigest() == "b49c57e37e181d19541de6e9da21a30e267363df928dd6b99d00bca345c15591"'
python3 -m zipfile -e artifact.zip /path/to/fresh-ds-evidence
python3 audit.py /path/to/fresh-ds-evidence/jmdict \
  --source-repo /path/to/frozen-ds-research \
  --out /path/to/independent-recheck.json
```

The auditor verifies the ZIP hash/size and exact extracted contents, clean source
tree and baseline Git blobs, browser and helper hashes, locked archive/grouping,
registered schedule, conformance cases, complete journal/report agreement,
per-bank/group digests, copy counts, all phase sums and paired summaries. It
requires equality with the original independent audit except for the extraction
directory path. It does not edit the artifact or either source checkout.

`audit-original.py` is the original scratch-bound auditor. `audit.py` only adds
explicit paths, frozen-tree cleanliness and original-ZIP checks, plus the final
comparison with that original report. [auditor-portability.json](auditor-portability.json)
records both hashes and these changes. `portable-audit-verification.json` records
the completed recheck; no timing was rerun to prepare this archive.

## Exact source and original measured boundary

The artifact's `jmdict/campaign/registration.json` is the authoritative original
registration. The source checkout contains:

- `.github/workflows/decompression-stream-chromium-beb5.yml`, the complete frozen
  environment and commands, including Node 22.22.0 and exact Chromium installation.
- `dev/perf/decompression-stream-chromium/capture.mjs`, the locked full-corpus
  payload/CRC/size/SHA/row-count capture.
- `fixtures.mjs`, the malformed, trailing-data and hidden-member corpus.
- `gzip-inflater.mjs`, the fixed 64 KiB and 1 KiB prototypes.
- `worker.mjs` and `campaign.mjs`, the conformance prerequisite and all 36 fresh
  measured processes.

If a separately approved reproduction is needed in an environment that permits
normal full Chromium workers and loopback HTTP, use that frozen workflow and
README with fresh input/output directories. Its command boundary is:

```sh
node dev/perf/decompression-stream-chromium/capture.mjs \
  builds/e2e-dictionary-cache /path/to/fresh-captures
node dev/perf/decompression-stream-chromium/campaign.mjs \
  /path/to/fresh-captures /path/to/fresh-campaign 6
```

The archive itself does not trigger or authorize another timing cohort. Do not
retry selected arms, change slice sizes, omit conformance/controls or pool a new
host with the retained result. The canonical result is the saved campaign.

## Historical Node feasibility and resource analysis

`node/original-runners/` preserves the exact local feasibility runners, including
their original absolute scratch/input paths. They are provenance, not portable
entry points; adapting those paths would be a new execution. The corresponding
JSON/log files and original capture manifests are unchanged. `node/provenance.json`
binds each report to its runner and distinguishes the final frozen helper from
the earlier helper hash. The earlier helper source itself is not retained here;
no final performance or promotion conclusion depends on that preliminary version.

The resource review references immutable Chromium commit
`971a7443b0c9b0a9b2860529b33331b76077ec62`. Its tag receipt and source manifest
preserve exact primary URLs, Git blob IDs, sizes and SHA-256 hashes. The manifest
permits re-fetching those source bytes; this evidence package does not vendor
the Chromium source tree. That source inspection is not a reproducible-build
proof of the downloaded browser binary or a portable memory guarantee.

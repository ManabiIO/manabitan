# Hosted import evidence, November 22, 2026

The decisions and timing tables are in the [single experiment handoff](../../../dev/perf/import-experiments-20260914.md). This directory preserves the evidence from [workflow run 45102947664](https://github.com/ManabiIO/manabitan/actions/runs/45102947664), frozen at research commit `b6a3e6567b78a1ced6fb005ec868537542ac2f87`.

## Contents

- `hosted-evidence.tar.xz` contains every file from the retained GitHub artifact ZIPs, plus the original setup-failure log, workflow metadata, and validation logs.
- `manifest.json` records original artifact IDs, attempts, job IDs, archive sizes, and GitHub-provided ZIP digests. It also records the size and SHA-256 of every retained file and the enclosing evidence archive.
- `summary.json` retains all per-cell analyses and the setup failure, without pooling different hosted runners.
- `SHA256SUMS` checks the integrity of the files in this directory.

Artifact file bytes are unchanged. The outer archive uses deterministic tar metadata and XZ compression; the original ZIP digests identify the provider archives from which those files were read. Timing reports, failures, source snapshots, package-entry manifests, host snapshots, and warmups are all retained.

The sole setup recovery repeats the original unmeasured `parser-vndb/reverse` job at the frozen source. The initial fixture-provisioning timeout contains zero imports. Its evidence remains separate from the complete recovered cohort; completed measurements from the other cells are not repeated or replaced.

## Verify and extract

Run these commands from this directory:

```sh
sha256sum --check SHA256SUMS
mkdir extracted
tar -xf hosted-evidence.tar.xz -C extracted
```

The manifest can additionally verify every extracted file:

```sh
python3 - <<'PY'
import hashlib
import json
from pathlib import Path

manifest = json.loads(Path('manifest.json').read_text())
root = Path('extracted')
for name, expected in manifest['files'].items():
    data = (root / name).read_bytes()
    assert len(data) == expected['sizeBytes'], name
    assert hashlib.sha256(data).hexdigest() == expected['sha256'], name
print(f"Verified {len(manifest['files'])} files")
PY
```

## Reproduce the analysis

Each cell contains the exact runner and configuration used for its original attempt. Reanalyzing a complete cell needs Python 3.11 or later, without browsers, Node, or dictionary downloads. For example:

```sh
python3 extracted/attempt-1/media-vndb-forward/research-sources/dev/perf/import-qualification-20261122.py analyze \
  --case media-vndb --direction forward \
  --output extracted/attempt-1/media-vndb-forward
```

This rewrites that extracted cell's `analysis.json` deterministically. The initial failed `parser-vndb/reverse` attempt correctly exits with status 1 and produces no timing aggregates. Compare complete cells separately; the forward and reversed streams ran on independent hosted runners.

These are release Chromium imports using production defaults. Persisted title, revision, row counts, and twelve source-derived content probes are checked before and after restart. The probes are sampled correctness evidence; the timing study does not establish exhaustive database or image-payload equality, total browser memory, or lookup-latency non-regression.

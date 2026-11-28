# Offline artifact transport for #830

These helpers preserve and verify artifacts from the already registered qualification run `46114139837`, attempt `1`, at candidate `049cb11e6963604435998aa060e1400cc00365cb`. They start no workflow, browser, import, retry, or benchmark. The separate reader remains frozen at SHA-256 `593ee1c210689d8e9844763e3f87996e15330b03c888593b3b66e0411765136c`.

## Identity and outcome

`binding.py` joins the saved authenticated run, job, and artifact API records with the exact job-log fetch request/output receipt. It requires the frozen repository, pull request, base, candidate, workflow, attempt, branch, cell name, artifact name, byte count and digest. The full captured log must contain the upload action's exact successful-upload line and permanent artifact URL, including the same artifact ID, name, and size. This binds the artifact to the selected job request without assuming that the artifact API contains a job or attempt field.

The binder does not require a successful or completed run or job. A matrix run may remain active after one cell finishes; a failed or incomplete cell can still produce useful evidence. Those outcomes remain explicit metadata, independent of archive integrity. They cannot turn failed or missing qualification gates into success.

The staging directory contains the following original responses and bytes:

- `run-api.json`: the full authenticated response for the frozen workflow run, retaining attempt, workflow, source and pull-request identities.
- `<cell>-job-api.json`: the full authenticated response for the exact matrix job, including its job ID, run attempt, head, name, status and conclusion.
- `<cell>-artifact-api.json`: the original artifact record from the authenticated run-artifact listing.
- `<cell>-workflow-job.log`: the entire decoded UTF-8 response from `mcp__codex_apps__github_fetch_workflow_job_logs`, called with that exact job ID.
- `<cell>-job-log-fetch.json`: the captured tool name and request, capture time, and SHA-256/byte count of that UTF-8 output. Its `output` object has exactly `encoding`, `bytes`, and `sha256` fields. This records transport provenance; it is not an extra observation.
- `<cell>-artifact.zip`: the downloaded outer artifact, streamed from the connector's temporary file reference. The temporary signed URL is never saved in evidence or logs.

The log-fetch receipt uses `tool: "mcp__codex_apps__github_fetch_workflow_job_logs"`, `request: {"repo_full_name": "ManabiIO/manabitan", "job_id": <actual job ID>}` and `output: {"encoding": "utf-8", "bytes": <captured bytes>, "sha256": <captured SHA-256>}`. Capture these values from the actual response. Do not construct a receipt for an unperformed request.

## Extraction and readback

`extract-artifact.py` adds the identity binding ahead of the existing #820 extractor. Its entire ZIP-member traversal is AST-identical to the original: safe canonical unique paths, regular files/directories only, a 64 MiB limit per file, streamed hashing of every member, and exclusive creation of retained files. HTML and trace files remain in the verified original ZIP and are hashed during intake; both product ZIPs are retained as ZIPs. No product ZIP is expanded by this helper.

The existing explicit extractor arguments remain, with the new required `--staging` argument. Their artifact ID, size, digest, cell, and path must agree with the saved API binding. Choose a fresh `--output` at `<staging>/<cell>`. No existing extraction directory is overwritten.

After extraction, run the frozen `analyze-cell.py` against `<staging>/<cell>/import-inflight-validation-830-83b3`, with the current baseline repository, exact cell, a new report path `<staging>/<cell>-independent-analysis.json`, and `--verify-packages`. The package check must remain enabled. An incomplete report or nonzero reader exit is evidence to preserve, not a reason to alter or rerun the cohort. The helper changes none of the reader's endpoints, statistics, source guards, media checks, memory checks, schedule counts, or the VNDB 37-unit gate.

## Durable evidence package

`package-cell.py` repeats the identity and whole-outer-ZIP checks, then verifies the extraction receipt and frozen reader hash. It preserves every original non-package artifact member directly from the verified ZIP, including HTML, trace files if any, raw observations, partial attempts, logs, and all tails. Only the two known product ZIP payloads are omitted from this smaller derivative; their exact outer member hashes and the independent package-check result remain visible. The original outer ZIP remains the source for any further package readback.

The package also includes all raw transport records and the full job log, the identity receipt, independent report, exact reader/transport helpers, and fourteen frozen repository inputs. `frozen-repo-inputs.json` was derived from the frozen reader's `TOOLING` and non-build `PROVENANCE_PATHS`, and every byte was checked against baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Its hash is pinned in the packager.

The former #820 packager required twenty-eight reader-observed repository inputs, including its owned-column replay inputs. #830 has fourteen relevant inputs. They are all preserved even if an early qualification failure prevented the reader from reaching every one. Every repository input actually recorded by the reader must still match the frozen manifest, and its observed count is retained separately. This preserves incomplete evidence without manufacturing successful source or qualification checks.

The packager takes `--staging`, `--cell`, `--repo`, the explicit frozen `--reader` path, and a fresh `--output`. Tar entries, modes, ordering, timestamps and compression remain deterministic. `complete: true` means that evidence archive construction finished; job outcome, timing completeness and qualification gates are separate fields. It makes no speedup claim and performs no host pooling or control subtraction.

## Preparation and limits

The original two helpers are retained as `source-extract-artifact.py` and `source-package-cell.py`; `transport-adaptation.patch` records the changes. `preparation.json` records hashes, syntax checks, the identical extractor traversal, and the frozen-reader identity. This preparation has not acquired or analyzed a #830 artifact. The actual API/log/ZIP intake remains to be executed only once bound artifacts exist and after independent review of these helpers.

Use normal Python execution: these inherited helpers use assertions, so do not enable `python -O` or `PYTHONOPTIMIZE`. Saved API responses and tool receipts are provenance captured from the authenticated connector; the scripts verify their internal bindings and exact bytes, and do not independently authenticate a newly supplied response against GitHub.

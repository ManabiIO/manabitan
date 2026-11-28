# Offline review of the frozen VNDB equality experiment

This branch restores read-only artifact verification after the local executor
became unavailable. It uses the original VNDB experiment, source, schedules,
conditioning, warmups, timed observations and exhaustive checks.

## Original evidence

- Repository: ManabiIO/manabitan
- Original run: [46114043842](https://github.com/ManabiIO/manabitan/actions/runs/46114043842)
- Campaign commit: `8be0d1c54e537efabc25e34e01926bb898eb50df`
- Campaign tree: `f0eb884d923ad6054112a9b47e1550709f22f1ee`
- Baseline commit: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`
- Forward job: `140883726945`; reverse job: `140883726734`
- Original attempt: `1`

Each review job requires its original named job to have completed. It checks the
run, head, attempt, branch, job and unique artifact identities; verifies the
provider ZIP size and SHA-256; then supplies those original bytes to the unchanged
acquisition wrapper and auditor. Their unchanged strict summarizer rechecks every
retained raw report, prescribed pass role, work counter, transfer size, complete
output digest and copied timing value before reproducing all comparisons.

The review executes Python artifact checks, Git identity checks and the unchanged
offline summarizer. It does not invoke the benchmark preparation, campaign or
measurement scripts, instantiate the parser, compile modules, acquire dictionaries,
or install application dependencies. Source review passed independently; the
workflow checks Python syntax before accessing an artifact.

## Recovered inputs

| Input | SHA-256 | Recovery |
|---|---|---|
| Frozen auditor | `c03c9653994ff40adcba1cc8696066ed8e76f6ce43b7c8aab791566a12a72cf4` | Exact original bytes |
| Acquisition wrapper | `59d3701d5268f616957e754fa9ec130682be055da53b9df712e623132fde822a` | Exact original bytes |
| Publication manifest | `18267065b3121ca0eb0ba491e5477a4453ef11c9cd97d6a52090e2f1da56d830` | Exact original bytes |
| Publication receipt | `3d5cba2cf860ccf4ee7f279ef9296335a93e193b3652bdaa618099c0aa67bd9f` | Reserialized from the exact retained object; original raw-file hash unavailable |

The four inputs are retained in this branch so their Git objects remain
referenced. The original manifest's absolute paths are recreated on each fresh
review host, using immutable campaign and baseline checkouts. All original source
and module bindings remain enforced by the frozen auditor.

The API credential is limited to repository contents and Actions reads. It is
confined to GitHub API requests with redirects disabled. A separate request
downloads the signed provider URL without that credential. The signed URL is
neither printed nor retained. The frozen child tools receive no token and reread
a private, digest-verified local copy of the original ZIP.

## Review outputs and interpretation

Each job retains its original ZIP, raw reports, metadata, exact recovered inputs,
audit receipts, strict summaries and failures. Job logs expose every summary
comparison, arm median and observation block, plus all artifact-member and raw
child hashes. Both orders stay separate. Original partial or failed acquisitions
remain partial or failed; no replacement observation is created.

The earlier [JMdict campaign](https://github.com/ManabiIO/manabitan/actions/runs/46110444607)
completed all four candidate/host cohorts and passed its independent raw audits.
Neither candidate established a clear replicated JMdict component gain, so both
were held for JMdict. The independently registered VNDB equality campaign remains
a separate question.

These are production-worker component measurements. Archive loading, actual IPC
and concurrent worker scheduling, database/OPFS, compression, media payload import,
browser UI and first lookup are outside their measurement boundary. Internal phase
timers can overlap and are not summed into CPU savings. A review decision must
consider both identical baselines, all paired and equal-work comparisons, every
tail, and both hosts; complete-import or memory claims require separate evidence.

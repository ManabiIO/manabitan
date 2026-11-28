# Offline readback of #830 browser qualification

This reader is prepared for [run 46114139837](https://github.com/ManabiIO/manabitan/actions/runs/46114139837), attempt 1, candidate `049cb11e6963604435998aa060e1400cc00365cb`, tree `a47cc23bcfa039a9defe66db2b15d79ea2198072`, and baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. It performs offline analysis only. No artifact has been analyzed at preparation time; root review is required before the first invocation on acquired evidence.

The initial API receipt binds the workflow path, branch, PR, exact head/tree, baseline, run attempt, and queued selector job. The published workflow copy matches SHA256 `c329b82c708595ac6106610db86de7715a1886d31096609b4bc793c419208dc5`. Later job IDs and artifact identities must be recorded when GitHub assigns them.

## Exact adaptation

`source-analyze-cell-owned-columns.py` preserves the original #820 reader, SHA256 `8c80a2ea267f4430d937efb56d4456bb6f11e60ea0465aa5bb3c2aead15239d9`. `reader-adaptation.patch` records the complete preparation diff. `preparation.json` records both source hashes, source bindings, and syntax checks.

The derivative updates candidate/tree/run identities and the evidence-directory label, and permits exactly one changed package entry: `js/dictionary/dictionary-database.js`. Its baseline SHA256 is `75da1c10c8cefd238e17aaabb44fca71f39e2f4e412660420c1e675d9cc7b84b`; its candidate SHA256 is `12569a57197d4923fff7ed74fe6da071b4fff6d7a01bb9112e848c2a9d25cbbd`.

The only removed gate is the owned-columns-specific replay requirement. The #830 workflow does not acquire that replay. Its separately completed local component cohort remains separate evidence and never enters these browser statistics. This workflow also acquires no additional diagnostic trace.

Every surviving function other than the enclosing `main` has the same Python AST as the original reader. The full driver, reader, and memory auditor were reviewed. Schedule reconstruction, raw endpoint checks, receipt comparison, exhaustive media, memory overlay verification, raw memory recomputation, package verification, statistics, incomplete-attempt inventory, and final gate aggregation remain intact. No acquisition policy, threshold, import option, or browser gate changed.

## Expected schedule

| Cell | Ordinary receipts | Excluded warmups | Candidate observations | Identical-code observations | Separate exhaustive media | Separate memory |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| JMdict AB, 12 pairs | 36 | 4 | 24 | 8 | 2 | 4 |
| JMdict BA, 12 pairs | 36 | 4 | 24 | 8 | 2 | 4 |
| Jitendex AB, 6 pairs | 20 | 4 | 12 | 4 | 2 | 4 |
| VNDB AB, 6 pairs | 20 | 4 | 12 | 4 | 2 | 4 |

The four complete cells contain 136 browser imports. Warmups run in the initial and opposite orders. Candidate pairs alternate AB/BA; each third pair is followed by alternating AC/CA identical-code controls. C uses the same baseline source, package, runtime, and flags as A. Memory uses ABBA for an AB cell and BAAB for the BA cell. The two JMdict cells remain independent hosts.

## Required artifact intake

Expected artifact names are:

- `import-inflight-validation-830-83b3-jmdict-AB`
- `import-inflight-validation-830-83b3-jmdict-BA`
- `import-inflight-validation-830-83b3-jitendex-AB`
- `import-inflight-validation-830-83b3-vndb-AB`

Before invoking the reader, preserve an intake receipt binding the GitHub artifact ID/name, run ID, attempt, head SHA, job identity, creation time, reported size, and download source. Verify run 46114139837, attempt 1, and the exact candidate above. The reader's constant `runId` is a label for this frozen study; it does not replace this transport check. Keep temporary signed download URLs out of public reports.

Process one artifact at a time. Inventory its ZIP central directory before extraction: member names, compressed and uncompressed sizes, and CRC. Reject duplicate names, absolute paths, parent traversal, and symlinks. Record the extracted members' hashes and maintain their original relative paths. Verify the actual returned download-reference and byte-range capabilities before selecting a transport. A whole outer-ZIP SHA requires reading all its bytes; range-only extraction must be labeled accordingly.

Preserve all available evidence, including attempted observations that never reached `observations.json`:

- The root `registered-plan.json`, `source-identities.json`, `browser-identity.json`, `observations.json`, `analysis.json`, and build/fixture logs.
- Every ordinary directory's summary, raw report, canonical receipt, host-before/after records, log, and any partial or failure files, including all slow tails.
- Both exhaustive-media directories' complete reports, receipts, and logs.
- The memory plan, original/instrumented harness copies, observations, comparison, audit or audit failure, semantic failures, and all four memory directories' reports, raw scans, markers, logs, sampling failures, and incomplete files.
- The sibling `import-inflight-validation-830-83b3-logs` directory, especially the source guard and complete driver stdout/stderr.

Screenshots and HTML reports may remain in the original artifact during the first bounded readback. Preserve the original artifact for later inspection. Check free space and actual member sizes before staging packages or large memory files; JSON reader inputs retain the original 64 MiB per-file limit. If an evidence file exceeds that bound, stop for a separately reviewed readback plan rather than dropping samples or changing the limit silently.

## Invocation and interpretation

After root review and verified intake, pass the single cell's `import-inflight-validation-830-83b3` directory:

```sh
python3 builds/perf/import-inflight-validation-830-83b3-analysis-source/analyze-cell.py \
  --repo /workspace/scratch/83b3b3bfba02/manabitan \
  --evidence /tmp/one-cell/import-inflight-validation-830-83b3 \
  --cell jmdict-AB \
  --output /tmp/one-cell-analysis-receipts.json
```

The first pass leaves `packageBytes` pending and exits 2. For complete qualification, stage both package ZIPs within the resource budget, add `--verify-packages`, and use a new output filename. Existing derived results are never overwritten. The package pass hashes both complete ZIPs and every member, checks the exact member inventory, and requires only the database JavaScript file to differ between A and B.

The reader recomputes browser monotonic start/end durations and requires agreement with both summaries and the observation list. The frozen receipt validator checks source/runtime, fixture, semantic probes, lookup/restart, storage, post-UI completion, and media. The memory path reproduces the exact existing overlay, all four observation summaries, process-tree coverage and maxima from raw scans, and the unchanged 5% median/10% worst-pair screen. VNDB's active SAH allocation contract remains exactly 37 units.

Per cell, the output retains every chronological observation, raw endpoint readback, complete and incomplete pair, and attempted-but-unrecorded directory. It independently reproduces B/A paired ratios, median, equal-work ratio, worst pair, faster-pair count, the frozen descriptive bootstrap, and order strata. C/A controls are reported separately. No hosts are pooled, no drift is subtracted, and no warmup, media, memory, or other component duration enters the candidate estimate. Incomplete schedules and any failed source, correctness, media, or memory gate remain failures; complete-pair statistics from such a cell remain provisional. Passing all correctness and memory gates does not by itself establish a latency gain.

# Score-cache hosted evidence and retention

**The completed experiment does not support advancing the score cache to a PR.** The final V3 candidate lowers JMdict field-encoding counters, but neither independently scheduled JMdict cohort establishes a complete-import gain. All eight cohorts have now been audited; all observations and controls remain in the analysis.

## Bound sources and outcomes

The common baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. V1 was measured at `1c0239a54df4c8b30124e6cabe644e833c9af64a`, with record-store source SHA256 `9222c10f4ae48d802aedd05057df9c651f0466a1065b52a5ab502aaf5e334dd5`. V3 was measured at `02bfdeefe6d032a8598a68c196a5ccd949c5ae5d`, with record-store source SHA256 `65e3bc1c98b45175d350d79a282b6445225339fafbb9024a7f02f0379222f3c9`.

Negative percentages mean faster. These are separate per-host cohorts; no timing is pooled across source versions, hosts or schedules. The identical-code control is kept separate and is not subtracted from the candidate result.

| Product | Dictionary / order | Pairs | Paired median | Equal work | Faster pairs | Control median | Memory gate         |
| ------- | ------------------ | ----: | ------------: | ---------: | -----------: | -------------: | ------------------- |
| V1      | JMdict AB          |    12 |      −1.4202% |   −3.8210% |         8/12 |       −0.8791% | Pass                |
| V1      | JMdict BA          |    12 |      +0.6556% |   +1.2333% |         5/12 |       +1.2279% | Pass                |
| V1      | Jitendex AB        |     6 |      +0.2512% |   −0.0095% |          2/6 |       −0.5606% | Pass                |
| V1      | VNDB AB            |     6 |      −0.6388% |   −1.7653% |          5/6 |       +2.6474% | **Coverage failed** |
| V3      | JMdict AB          |    12 |      +2.3417% |   +4.7569% |         4/12 |       +1.8509% | Pass                |
| V3      | JMdict BA          |    12 |      +0.2857% |   +2.0269% |         5/12 |       −0.0284% | Pass                |
| V3      | Jitendex AB        |     6 |      +0.7737% |   +0.9162% |          2/6 |       +2.5433% | Pass                |
| V3      | VNDB AB            |     6 |      −4.6959% |   −3.3527% |          5/6 |       −1.6308% | Pass                |

The V3 JMdict first-pair candidate outliers, +40.7764% in AB and +20.8688% in BA, are included in every reported statistic. No tail was removed and no run was retried. Paired field-encoding counter differences were −13.15 ms in AB and −7.90 ms in BA; these existing production counters can overlap other work and cannot be added or subtracted to explain the complete-import duration. They establish a component effect in these observations, not an import-speed claim.

V3 VNDB has a favorable single-cohort point estimate, preserved above. Its descriptive interval is −8.0458% to +3.3029%, including zero, and its retained worst pair is +7.6213%. The full local VNDB corpus uses inline-range scores throughout: the V3 prefix probe selects the score helper in **zero of 170 groups** across 6,648,310 rows. The changed path is therefore mostly the bounded probe/guard, and the favorable point estimate is not attributed to cache hits. This local route evidence is bound to the same source and fixture; it is not browser execution coverage. No optional replicate was added to pursue this favorable result.

### VNDB V1 coverage failure

All 26 semantic observations passed, including the separate memory observations, and all 417 raw memory scans were retained. A1, B1 and B2 qualified. A2 had a maximum covered-scan gap of **267.100445 ms**, exceeding the registered **250 ms** bound. Both A2 reported maxima correctly remain null. The cohort's PSS/private median and maximum comparison fields also remain null, and `overallQualificationPassed` is false.

The failure auditor recomputes scan identities, available processes, sums, markers, bracketing and covered-scan gaps. It allows the audit to finish while retaining the failed qualification; it does not relax the memory rule. Computed maxima from A2's covered scans are retained only as audit diagnostics and are not qualified memory results. The job was reported failed after completing timing; no retry is requested or performed.

## What was independently checked

Each completed cohort was bound to its original artifact SHA256, source commit/tree, fixture lock, harness and browser identity. Both embedded release ZIPs and all 554 entries in each package were compared byte-for-byte by digest before any package payload was omitted. Only the declared record-store module differed between the arms. The remote browser executable itself is not included in the artifacts; its identity is recorded by executable hash and matching runtime version.

Raw browser monotonic events reproduce every summary duration and registered schedule. All source-derived semantic receipts, twelve probes and repeated lookup digests, full browser restart/readback results, logical OPFS storage inventories, and separate exhaustive-media receipts were compared. JMdict's 43,520,477-byte logical storage inventory and semantic output digest remain equal in both arms and across the validated cohorts. The semantic checks are the stated probe/receipt contract, not an exhaustive digest of every database record.

Memory is a separate instrumented cohort. Every raw scan is retained, including outside-window, boundary, failed and unqualified scans. Only stable fully read scans entirely inside the registered import markers can contribute to qualified sampled maxima. These are non-atomic sampled measurements, not exact peaks. Instrumented import durations are excluded from the timing comparison.

## Hosted source validation

| Exact product | Passed files | Passed tests | Skipped tests | Direct-field cases | Observer/receipt tests |
| ------------- | -----------: | -----------: | ------------: | -----------------: | ---------------------: |
| V1            |          669 |       15,137 |            47 |                 17 |                     32 |
| V3            |          669 |       15,139 |            47 |                 19 |                     32 |

Both retained unit reports explicitly report success with zero failed tests. The V3 direct-field report includes both prefix eligibility regressions. Both hosted validations completed all seven dry-build targets. Main/test TypeScript logs end without diagnostics; lint contains the existing vendor bundler warning and no ESLint failure. Saved final API receipts independently establish successful conclusions for each validation step, including the combined main/test TypeScript step. These are bound in `score-api-receipts-audit.json`; an empty diagnostic log alone is not treated as an exit-status receipt. V1 gates must not be attributed to V3.

## Compact raw evidence

The eight raw-evidence archives total **15,618,822 bytes**. Their paths, original artifact IDs and ZIP hashes, compact hashes, exact auditor hashes, outcomes, phase diagnostics and validation references are indexed in `score-hosted-evidence-index.json`.

Each new archive retains every original member except `package-A.zip` and `package-B.zip`, plus a `_review/` directory containing the independent audit, exact auditor, compactor, acquisition receipt when present, and complete original/member/package inventories. Every retained byte was rechecked after archive writing. Original package ZIP hashes and every individual entry hash/size are preserved; omitted package payloads were fully revalidated immediately before compaction.

The pre-existing V1 JMdict BA raw archive was kept unchanged to avoid a duplicate. A separate preservation audit rechecked all 326 original non-package files against the original independent audit. Its source/package entry inventories and original package verification receipt remain available; its exact auditor is retained separately and also appears in the V1 JMdict AB compact archive.

This is intentionally a raw-evidence subset of each original artifact. It does not reproduce the original ZIP container, timestamps, or omitted release payloads. Rebuilding pinned source does not by itself reproduce a ZIP container's SHA256. An independent future package-byte verification requires reacquiring the original artifact or an independently reproduced package. All raw data needed to inspect timing, semantics and memory decisions remains present.

The compaction stage deleted no original ZIP, extracted evidence, or other task directory. Earlier, the root investigator removed the redundant V1 JMdict BA original ZIP only after verifying its compact archive and preservation receipt; its original identity remains recorded. Further cleanup can act only on already verified redundant inputs after the compact archive and receipt have been retained. The six original validation payloads and their manifests are small enough to preserve in full; do not replace them with only test totals.

The saved final score API receipts establish all eight job conclusions and all ten cohort/validation artifact identities, including the API-provided SHA256 digests and workflow source commits. The V1 VNDB log retains the runner's nonzero exit after complete timing and its evidence upload. Native-job snapshots captured in the same directory are contextual queue states and are excluded from the score evidence and final-validation claims.

## Reproduction and script versions

`audit-score-hosted.py` is the retained score-specific auditor. The initial Jitendex V1 audit used its preserved earlier version, `score-v1-hosted/audit-jitendex-v1.py`. The generic auditor versions are frozen separately:

- `audit-import-hosted-0119-v1.py.txt`, SHA256 `c627fde0b2b794c2d1ddbb29b34bf4dde9275a5f613c9d2f7e0dc8869b8d4f53`, reproduces the earlier V3 Jitendex generic result.
- `audit-import-hosted-0119-3a338e76.py.txt`, SHA256 `3a338e76a29b4f9e0cfcc0e5577c4879518c7eff4fa5f32397959dd7409e416c`, adds list-length and final memory-status checks; it was rerun into a distinct V3 Jitendex result and used for both V3 JMdict cohorts.
- `audit-import-hosted-0119-gap-failure.py`, SHA256 `9f94a2653b56db80685ab49eab5cd131c7fe09911828ad6430f9ff2af6ad4d96`, additionally audits a covered-scan-gap failure without declaring it qualified. It independently retains null failed maxima and aggregate comparisons.

The full auditors take explicit cohort, original archive, archive SHA256, artifact/run IDs, source commit/hash and dictionary arguments. Their source checks disable lazy Git fetching. Reacquire the exact original artifact when repeating the full package audit; the compact archive alone is deliberately insufficient for that part.

`compact-hosted-evidence.py` takes an original artifact, completed independent audit and matching exact auditor, rechecks all package entries, then writes a raw subset and preservation receipt. Its first attempt encountered an older acquisition-receipt schema without `archiveBytes` and stopped before writing. The final version accepts that optional acquisition field while still requiring the actual original ZIP's exact size and SHA256 from the independent audit. This was a packaging preflight issue, not a benchmark retry.

Regenerate the current index, without rerunning browsers or changing observations:

```sh
python3 builds/research-0119/audit-score-api-receipts.py
python3 builds/research-0119/index-score-hosted-evidence.py
```

Keep the archived runner, fixture lock, source patch, workflow, qualification modules and raw reports together. Their original bytes and hashes are already retained in each raw archive. Preserve all script versions referenced by audit hashes; do not silently substitute a later auditor for an earlier result.

## Retained repository layout

The two `score-v*-hosted/` directories contain the eight immutable raw-subset archives. `review-and-validation.tar.gz` retains the complete source-validation payloads, independent audits, exact auditor versions, final GitHub API receipts and evidence index. Its internal paths match the research index. The adjacent manifest binds every compressed archive and every review member. Extract the review archive into a fresh directory to inspect its index and receipts; unpack each raw-subset archive separately to avoid collisions between its original runner paths. Reacquire the original Actions artifact for a full package-byte re-audit, as explained above.

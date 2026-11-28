# Descriptor and index finalization: prospective screen

This experiment has no measured candidate import-speed result and is not a pull request. Its purpose is to test a bounded scheduling change against complete JMdict imports before considering broader qualification.

## Source and hypothesis

Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The reviewed local prototype is `222f3f4087cf84981ae51d1b9ea8fd1988c0dfb6`; the unchanged runtime file SHA256 is `d727ae00a72ec752984633cda25929dac32d031d9c92a269232118c5669b24fb`. The hosted workflow freezes its exact published source at `github.sha` and permits only the declared record-store module to differ in the release package.

Current JMdict builds each lookup envelope during import. It does not perform a final lookup sort or full rebuild. In twelve ordinary baseline observations from two separate hosts, bulk-finalization medians were 25.5 ms and 22.5 ms. Descriptor preparation medians were 11.85 ms and 6.35 ms. These are existing overlapping phase measurements, not a predicted speedup. The source-bound raw baseline observations and review receipts will be retained with the completed experiment.

The candidate starts descriptor preparation, queue draining and close alongside the existing sidecar finalization, within the existing per-shard `Promise.allSettled` join. Shard pairs remain sequential. The import session stays active until every owner succeeds; failures drain both arms before propagating to rollback. Sidecar header construction, mandatory flush, byte formats, worker admission, storage settings and publication gates retain their existing behavior.

There is a real scheduling tradeoff: the former global descriptor-preparation pass could start writes for later shards before the close loop. The candidate waits for the previous shard pair before opening a later descriptor. Jitendex and VNDB must be qualified before promotion. The new `closeWritableMs` is a residual completion tail after measured descriptor preparation and queue waits; it is not directly comparable as an independent measurement of underlying close work.

## Fixed initial acquisition

The initial workflow runs source validation and one twelve-pair JMdict cohort, starting AB and alternating pair order. It uses the existing frozen observer and production-default release import harness: two excluded warmups per arm, fresh browser profiles, interleaved identical-baseline controls, complete timing events, restart/readback, fixed lookup receipts, unchanged storage checks, separate exhaustive-media checks and a separate four-observation memory cohort. No profiling or process sampling occurs inside ordinary timing runs.

Every scheduled observation is retained. No outlier trimming, replacement, threshold relaxation or optional early stop is allowed. Source-validation failures and memory-coverage failures remain failures. Memory uses the existing 250 ms covered-gap limit and 5% median / 10% individual PSS and private-byte limits. Qualified sampled maxima are not exact peaks.

Advance to independent confirmation only if this screen has both a median paired complete-import reduction of at least 1% and an equal-work reduction of at least 1%, with the semantic and memory gates passing. Report identical-code controls separately; do not subtract their drift. A screen alone never establishes the claim. A favorable screen still requires a separately scheduled twelve-pair JMdict BA cohort, Jitendex/VNDB regression qualification, and complete source validation before a PR is considered. If the initial screen does not justify that follow-up, stop and preserve its result.

## Existing local evidence

Nine new controlled-operation tests pass on the final test source. They establish overlap while descriptor opening is blocked, exact file bytes and fresh-reader lookup, unchanged non-import preparation order, publication gating, descriptor/index failure drain, rollback, independent error aggregation, sticky-error handling and sequential shard pairs. These test doubles establish ordering and correctness; their waiting times are not OPFS performance measurements.

The eight existing persistence suites passed all 333 cases on the same runtime. The first combined run had one new test-double expectation error, subsequently corrected; a combined rerun was killed with exit 137 before producing results. Official local lint attempts were also killed with exit 137 before diagnostics. A narrow style/JSDoc precheck passed, but full lint, TypeScript, build and complete-unit gates remain pending hosted validation. Node exposes no actual FileSystem/OPFS interface here, so no local mock timing is presented as browser evidence.

An independent source review found no correctness blocker and explicitly retained the multiple-shard scheduling and counter-interpretation caveats. This record does not claim full correctness qualification, a browser gain or approval for merging.

## Retained local review bundle

[LOCAL_REPORT.md](LOCAL_REPORT.md) describes the source audit, prior work, baseline phases, exact implementation and local limitations. [evidence.tar.gz](evidence.tar.gz) retains all twelve source-bound ordinary baseline observations, their extractor, independent review, the exact runtime/test patch, and every local gate attempt including failures. [evidence-files.sha256.json](evidence-files.sha256.json) binds the original member bytes. The bundle contains no dictionary payloads or release-package archives and supplies no candidate browser timing claim.

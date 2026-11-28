# Dictionary import optimization investigation — 2026-11-28

Status: completed. Neither complete-import candidate demonstrated a practical, replicated, qualified improvement. No product PR was opened, and no changes were merged.

The priority was JMdict, with Jitendex and VNDB checked on the same production defaults. The frozen baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Work used isolated source worktrees, command-line tools, GitHub Actions, and three collaborating agents. No Work mode or browser-control session was used.

## Complete-import evidence

Two newly implemented candidates reached complete browser-import qualification: a source-cache range helper and a corrected SIMD match-count specialization for Zstd. Each candidate has independent AB-starting and BA-starting hosts for all three dictionaries. Each host prescribes four excluded warmups, 12 candidate pairs, four interleaved identical-code control pairs, two exhaustive-media imports, and four separate memory imports. That is 42 semantic receipts and 32 authoritative timed imports per host.

The controls, slow observations, qualification failures, and all original reports remain included. Results are assessed separately for each host. No host pooling, control subtraction, outlier removal, threshold change, or unchanged replacement cohort was used. The prospective [promotion criteria](promotion-criteria.json) require a practical replicated gain distinguishable from control variation, together with correctness, reproducibility, package and memory qualification.

### Source-cache helper: closed without a PR

Candidate `dfd2523b514f291dc57f39a9f256bbc0759efd5b` extracts the existing range-validation loop into a narrow helper while retaining its ownership, bounds and mutation rules. The sole changed release-package member is `js/dictionary/dictionary-database.js`.

Negative percentages mean faster. Savings are median paired milliseconds; negative savings mean slower.

| Dictionary | AB median change / saving | BA median change / saving |
| --- | ---: | ---: |
| JMdict | -0.5017% / +4.80 ms | +0.3154% / -2.60 ms |
| Jitendex | -0.0214% / +0.30 ms | -0.0359% / +0.40 ms |
| VNDB | -0.8447% / +41.20 ms | +0.9324% / -54.45 ms |

All six candidate intervals include zero. The component's earlier cold savings do not establish an import improvement. JMdict and VNDB reverse direction between hosts; Jitendex's point estimates are below half a millisecond. All 252 report semantics pass. Five memory screens pass, while VNDB BA fails the unchanged 250 ms sampler-coverage limit in all four observations. Those observations retain null qualified memory maxima and paired changes; they are not evidence of measured memory growth.

The [complete six-host record](evidence/cache-source-range/README.md) retains 192 timed imports, 24 warmups, 12 exhaustive-media imports, 24 separate memory imports, 1,924 raw scans, both source packages' complete member maps, and the failed-job log. The exact candidate also passed 15,135 tests, all seven dry build targets, main TypeScript and scoped lint.

### Corrected guarded SIMD: closed without a PR

Candidate `20e4af5897013ee76dfd4bed1ee6c383d71ba8e4` changes Zstd's common-prefix match counting. Its sole changed release-package member is `lib/zstd.wasm`. The uncompressed module grows from 433,631 to 433,757 bytes, a 126-byte increase. Generated JS remains unchanged, and the tested 103-block JMdict capture compresses byte for byte identically.

| Dictionary | AB median change / saving | BA median change / saving |
| --- | ---: | ---: |
| JMdict | -0.9187% / +6.45 ms | -0.1897% / +1.80 ms |
| Jitendex | -1.7154% / +28.00 ms | -0.6272% / +7.35 ms |
| VNDB | +0.9913% / -41.05 ms | +0.2398% / -14.15 ms |

JMdict's AB identical-code control saves 8.35 ms, exceeding the candidate's 6.45 ms point estimate. The BA interval includes zero, and both candidate memory observations fail sampling coverage. Both Jitendex intervals include slowdowns. VNDB is slower in its paired median on both hosts. Its AB host has one failed memory-coverage observation; all four observations on its BA host fail the same fixed limit. Those failed observations retain null qualified memory maxima and paired changes. This is a coverage failure, not evidence of measured memory growth.

| Dictionary / starting order | Descriptive 95% interval for paired change | Identical-code control median change |
| --- | ---: | ---: |
| JMdict AB | -2.3783% to -0.0707% | -1.1733% |
| JMdict BA | -1.9012% to +0.7671% | +1.5481% |
| Jitendex AB | -3.7757% to +0.7985% | +0.2789% |
| Jitendex BA | -1.2465% to +0.5242% | +0.3036% |
| VNDB AB | -0.7975% to +1.8773% | -1.3562% |
| VNDB BA | -1.5391% to +0.9419% | -1.0026% |

Five of six candidate intervals include zero. The one interval entirely below zero, JMdict AB, accompanies a larger favorable shift in its identical-code control. Together with the second JMdict host and the resource checks, this does not establish a worthwhile import improvement. The [complete six-host record](evidence/guarded-full-import/README.md) preserves all 252 semantic receipts, 192 timed imports, 24 warmups, 12 exhaustive-media imports, 24 separate memory imports, 1,968 raw scans, and all three failed-job logs. All report semantics pass; three of six memory screens pass.

Existing ordinary phase counters show lower compression time, but those overlapping counters are exploratory. Their control variation is substantial, and they are neither CPU measurements nor adjusted import endpoints. They do not independently establish an import gain.

A separate [single local corrected-binary screen](evidence/guarded-local/README.md) is closed as inconclusive. It retained 19 fresh children, 50 measured corpus passes, eight prescribed warmups and all controls. The apparent improvement against one baseline disappeared against the other; the 304.651 ms candidate cold tail remains included. No follow-up local cohort was run.

## Native correctness work

The original experimental SIMD implementation was unsafe when an upstream cached-prefix/two-segment caller supplied an input limit before the current input pointer. Its unsigned subtraction wrapped. The actual-header probe found 768 traps and one wrong result. Those old timings and the old binary-size reduction were rejected; they are not evidence for the corrected binary.

The corrected guard preserves the original scalar behavior. The pinned native rebuild reproduced the exact corrected WASM (`13890c7e75e7a2ff5fa00bd65f1e518e15f545da85154719be6a2eaa2a773a22`). Independent local and hosted verification covered 885,455 direct boundary cases, 651 raw cases, 1,110 capacity/canary comparisons with no status differences, and 103 byte-exact production-wrapper blocks from the JMdict capture. Hosted checks passed 669 test files / 15,135 tests, with 47 skipped, plus all seven dry build targets, main/development TypeScript and scoped lint. These are correctness results, not speed results.

A different streaming-compressor variant was rejected after 72 tight-destination status differences. It was not promoted.

## Other completed lines of work

| Work | Finding and disposition |
| --- | --- |
| Private in-flight span admission | The independently developed mechanism overlapped an external candidate. Its six-host external qualification was audited rather than duplicated. No replicated import gain; both VNDB hosts fail sampling coverage. [Full independent record](evidence/external-inflight/README.md). |
| Inflater SIMD copy | Cold improvement on one isolated host did not replicate on the other; warm savings were about one millisecond. Local cold losses remain included. No full-import promotion. [Hosted record](evidence/inflater-hosted.md). |
| Direct record reference lengths | 108 actual-producer children across all three dictionaries showed no stable JMdict or VNDB gain; Jitendex's warm saving was about 0.24 ms. Runtime experiment restored. |
| Short consecutive publication runs | The actual census found only 2,317 pending rows in short runs, 0.64%, creating 938 subarrays. The absolute opportunity did not justify implementation. |
| Native reference emission | The observed JMdict ceiling was 5.8 ms before adding ABI, ownership and copy costs. Held without implementation. |
| Indexed score validation, inline hash rounds, raw ZIP copy | Exact or materially overlapping earlier studies were found. Duplicate cohorts and PRs were stopped. |
| Record validation extraction and canonical-table changes | Active or historical implementations already cover the apparent redundant loops. The final bounded source review found no distinct material operation worth another cohort. |
| Terminal flush overlap | Source inspection confirmed that content and record finalization already start together; per-shard close and lookup-index persistence already overlap. The remaining index-writer close must await admitted writes and propagate flush failures. No distinct implementation or timing cohort. [Source review](terminal-flush-review.json). |

The profiler review also rejected misleading startup hotspots: the sampled message-handler and selector-observer costs were dominated by V8 profile-startup interrupts, and the selector work preceded file-input dispatch. No profiler overhead was subtracted from import timing. The approximately 112 ms record-store close in the ordinary diagnostic reflected a real durability flush; no redundant second terminal flush was found.

The [completed-study archives](evidence/README.md) and [final dispositions](round-dispositions.json) retain source identities, raw evidence, rejected variants and overlapping-work references. Earlier archives are immutable. The pinned fixtures contain 528,299 JMdict rows, 436,555 Jitendex rows, and 6,648,310 VNDB rows; older JMdict fixtures were not pooled into the current endpoint results.

## Evidence preservation

An executor interruption cleared temporary files after the original hosted jobs completed. The same eight immutable guarded-run artifacts were reacquired and checked against their original ZIP byte counts and SHA-256 hashes. All three original failure logs were also restored. The unchanged offline import auditor and phase analyzer were run on those original reports; no import, native rebuild, performance cohort, or replacement timing ran during recovery. The final package identifies newly generated audit receipts separately from the lost temporary receipts. Its packaging source was restored byte for byte and its recovered layout received a fresh independent review.

The repository evidence branch contains the tested product identities, qualification scripts, raw measurements, complete package-member maps, build/test results, source reviews and final dispositions. It does not change the production runtime. The two experimental product branches remain available for inspection, but neither is proposed for adoption.

The final evidence publication also moves an experiment-only test out of normal test discovery into an [exact source snapshot](evidence/inflight-component-test-source.txt), because it depends on a candidate helper absent from the baseline. The [scope audit](evidence-runtime-scope.json) and [move record](evidence/inflight-component-test-archive-move.json) preserve its original identity and explain the cleanup.

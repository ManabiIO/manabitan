# Import optimization and correctness review — September 16, 2026

## Retained change

**Opened [PR #48](https://github.com/ManabiIO/manabitan/pull/48): reject stale and replayed prepared compression handles.** Ready for review, not merged. Four additional performance variants were implemented and A/B tested on complete JMdict and Jitendex imports. None justified a new performance PR after controls and independent confirmation.

Published head `068dbe8a4aec40760108248b63c903dc4ad4efe5`, tree `a55ab40bbeb3493a80fcaa62d87816e4d69dc0e0`. Baseline remains `c0a1b7ee6fa1383a0a422361d2a8b7f826499fff`, tree `a48da18d4244b00661d0c6518b2ce77b9f2f9b55`. No production/release ref changed and nothing was merged. Earlier PR #46 and #47 changes remain separate and their measurements are not counted again.

Only `dev/lib/zstd-wasm.js` and 13 new tests in `test/zstd-prepared-lifetime.test.js` are in #48. Rejected CRC/DEFLATE variants, codec/settings/storage-format changes and validation bypasses are not included.

## Correctness finding

A prepared handle contained the context's retained buffer object. That object was reused when later operations copied different input or freed/reallocated storage. The old completion check compared only that object against the context map, so it could not distinguish current preparation from an earlier operation using the same object.

Older handles could pass validation after replacement, ordinary compression, partial-copy failure or allocation failure. Repeated completion, retry after native/envelope failure, and copied handle objects also passed the old check.

**Scope:** this is a reproduced exported-wrapper lifetime-validation defect, not evidence that ordinary current imports have been corrupting data. The present worker prepares and finishes synchronously with no await between; posting its source-consumed notification does not yield to a second worker message. The fix enforces the wrapper's contract rather than relying on that caller arrangement.

Each retained context now records its exact active prepared object, reusing the object already returned rather than allocating another token. Operations that can overwrite/free/allocate buffers invalidate the prior operation first. Completion rejects stale/copied handles before native compression and consumes the active handle before native code, so exceptions, native error results and envelope failures cannot leave a replayable operation. Invalid metadata rejected before buffer mutation preserves the active handle; independent contexts and independently owned results remain valid.

## Failure-first and exact-source qualification

[Run 35140525478](https://github.com/ManabiIO/manabitan/actions/runs/35140525478) completed before publication:

| Check | Result |
| --- | --- |
| New tests on unchanged parent | 10 expected missing-rejection failures; 3 passes |
| New tests with fix | 13 passed |
| Focused wrapper/pool/initialization/dedup/block-store suite | 140 passed |
| Full unit suite | 6,533 passed; 46 existing skips |
| Options | 27 passed |
| Strict type projects | All four passed |
| Changed-file ESLint | Passed |
| Build plans; actual Chrome/Firefox packages | Passed |
| Strict Chromium import/recovery lifecycle | 86 phases passed; no skipped verification |

The RED gate checks actual assertion failures, not just a nonzero exit. Tests cover same-capacity replacement, growth, ordinary compression replacing prepared input, partial-copy and allocation failure/recovery, single-use completion, native thrown/error/envelope failures, early validation rejection, copied handles, independent contexts with heap growth and freed contexts. Successful frames use actual Zstd WASM/decompression; failures are injected at explicit native exports, not by rewriting runtime source.

Initial run 35139921065 passed RED/GREEN and all 6,533 unit tests but failed a test-only JSDoc return-type annotation. Only that annotation changed; runtime and assertions did not. Final qualification repeated the complete process. The initial failure is retained.

Runtime SHA-256 `87b9a365a746d5a24edee51f89fea3cf82a244d636cee233e771c9549ca19909`; final test `bba66332063fc9f66788957cba0d2e39b59604a6a4973dc4ba5e547c08113fe6`; generated wrapper `1b91da06782e1ef53ec3a563f0f5ea6954495f4290f66c42fe406f2918b8698f`.

## Complete-import cost of the correctness fix

Twelve alternating pairs per dictionary, six interleaved A/A pairs, one excluded full warmup per arm: **76 fresh-browser imports**. Positive means slower. Main statistic: median adjacent `100 * (B/A - 1)`; equal-work totals include all measured observations.

| Dictionary | Median paired change | Equal-work change | Median absolute A/A variation |
| --- | ---: | ---: | ---: |
| JMdict | +0.693% | +0.170% | 1.874% |
| Jitendex | +1.141% | +0.968% | 1.146% |

**Not a performance win or proof of zero overhead.** These small positive changes are comparable to controls; Jitendex's nominal B label in same-binary controls was itself +1.146% slower. No control subtraction. Correctness reproduction, not speed, justifies this patch. The Chrome-dev archive grows 200 bytes; the 45,253-byte parser WASM is unchanged.

## Four additional performance candidates

Each initial screen used six serial alternating pairs, three interleaved A/A pairs, and one excluded full warmup per arm/dictionary. Negative is faster. All are independent changes against the same baseline.

| Candidate | JMdict screen | Jitendex screen | Disposition |
| --- | ---: | ---: | --- |
| CRC slicing 8 → 16 bytes | +1.070% | -0.911% | Mixed/noisy; not promoted |
| CRC slicing 8 → 32 bytes | +0.170% | +0.529% | No demonstrated win |
| DEFLATE distance-one bulk fill | -1.679% | +0.934% | Mixed; not promoted |
| Bounded overlapping-match expansion | -1.671% | -0.776% | Independently confirmed below, then rejected |

CRC variants retain the same polynomial/validation and original smaller/scalar tails. Larger tables cost 8 KiB/24 KiB additional static data. Neither bypasses integrity checking.

DEFLATE variants handle repeated bytes and overlapping matches after existing output-range validation, only with bulk-memory and non-wrapping output. Expansion copies initialized history then doubles the established prefix with bounded non-overlapping copies. Wrapped-output behavior is unchanged. [RFC 1951 section 3.2.3](https://www.rfc-editor.org/rfc/rfc1951) permits matches that extend into bytes produced by the same match; snapshot-style copying is not interchangeable with forward match expansion.

### Independent overlap-expansion confirmation

[Run 35140940983](https://github.com/ManabiIO/manabitan/actions/runs/35140940983): new jobs, twelve pairs per dictionary with reversed starting order, six A/A pairs. Initial and confirmation cohorts are not pooled.

| Dictionary | Paired change | Equal-work change | Faster pairs | A/A signed median | Median absolute A/A variation |
| --- | ---: | ---: | ---: | ---: | ---: |
| JMdict | -2.292% | -2.759% | 8/12 | -3.703% | 3.703% |
| Jitendex | +0.661% | +0.591% | 5/12 | +0.082% | 1.273% |

JMdict's apparent gain is smaller than same-binary directional drift, with all six control pairs favoring their nominal B label. Jitendex regressed slightly and had only five faster candidate pairs. **No convincing two-dictionary gain to promote.** All observations remain, including the JMdict -11.304% candidate pair. Other CRC/distance-one screens did not receive independent confirmation and are not claimed slower on every machine.

## Additional safety testing and research

**19 new local DEFLATE tests** passed on both original parser and expansion candidate. An explicit fixed-Huffman generator selects exact distances/lengths, with independent system zlib decoding verifying streams and expected bytes. Tests cover sixteen alignments, match thresholds, maximum backward distance, physical output ends, one-byte-short capacity, truncation, incorrect CRC, stored/fixed/dynamic/RLE streams and long ASCII/Japanese/emoji repetitions. Sources and receipts are in the evidence bundle, not PR #48.

A supplementary native harness passed **4,384 checks each** on verbatim extracted baseline, CRC16 and CRC32 functions using AddressSanitizer/UndefinedBehaviorSanitizer and an independent bitwise CRC oracle. Coverage includes short/long boundary lengths, all alignments and exact upper allocation boundaries. This is not the full WASM translation unit running under native sanitizers.

Official [Zstd preprocessed dictionary documentation](https://facebook.github.io/zstd/doc/api_manual_v1.5.7.html) was reviewed for a possible subsequent direction; no CDict implementation or speedup is claimed.

## Compatibility with #46

The lifetime patch applies cleanly to the exact #46 aligned-gather source. The combined wrapper passed **47 local focused tests**, including all 14 shared-gather and 13 lifetime tests, with real WASM compression/decompression. Combined source SHA-256: `1100b6a5b067f17be43e1c24f0d23bcdb463ef9f0fd618d047c014eb3dc8bd48`.

This is focused compatibility, not a full combined-tree browser benchmark/lifecycle qualification. #48 stays independently based on develop and does not inherit #46 speedup claims.

## Measurement audit

**312 fresh-browser observations across 12 complete cells: 96 A/B pairs, 48 A/A pairs, 24 excluded warmups.** Optimization experiments account for 236 observations; correctness-fix cost testing for 76. No earlier-round observations are counted.

The independent audit re-read every raw report/summary and checked artifact checksums, fixed-plan completeness/order, recorded source/package/harness/fixture identities, actual worker flag receipts, browser timing, full row counts/title/revision, at least twelve persisted-content probes, real OPFS, and unchanged source/group/worker/dedup/content/record/lookup-index work accounting. All 12 cells passed. Native component comparisons agreed on complete corpus output digests and lookup-index byte counts. This is not exhaustive persisted-database equality or whole-process memory measurement.

Fixtures: JMdict 2026-09-06, 526,942 term rows, ZIP SHA-256 `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a`; Jitendex 2026.08.11.0, 435,448 rows, SHA-256 `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc`.

Ubuntu 24.04 x64, Node 24.20.0, Clang 18.1.3, Chromium 153.0.8010.12; fresh profiles, real OPFS-SAH-pool storage, fixed production settings and all ten experiment flags false. Timing remains file-input change through UI completion with tracing/profiling/screenshots/process sampling off. A/B packages were actually built at the same filesystem path; only intended members differ. No retries, outlier removal, control subtraction or cross-host pooling.

Two initial lifetime-screen cells failed preflight because one named test did not exist; no lifetime timings were collected in those failed cells. They are retained but not counted in the 312 observations. The corrected run uses actual test paths. Initial qualification's type-annotation failure is also retained rather than called green.

## Ordinary CI and remaining gates

[Ordinary #48 CI run 35141475702](https://github.com/ManabiIO/manabitan/actions/runs/35141475702) completed: Chromium/Firefox full-extension E2E jobs, unit/options, four type projects, build, HTML, CSS and JSON passed. Edge/Firefox Android were skipped. These are job results separate from the exact-source 86-phase qualification, not Firefox performance measurements.

**Overall CI is red.** JavaScript still reports the 38 inherited errors in unchanged `test/term-bank-composite-state.test.js`, fixed separately by unmerged #47. Markdown formatting fails in unchanged `dev/perf/composite-state-review.md` and `dev/perf/import-experiments-20260914.md`; both were reproduced locally. #48 changes neither document. #47's current one-file JavaScript cleanup does not address those Markdown failures. No failures were suppressed or represented as green.

Linux Chromium measurements do not establish Firefox/Safari/ARM/mobile/native Reader performance, cold-OS behavior or whole-browser memory gains. No existing user-data loss or release-wide speed improvement is claimed for the retained correctness fix.

## Reproduction

[CRC screens/setup failures](https://github.com/ManabiIO/manabitan/actions/runs/35139432684), [DEFLATE screens/lifetime cost](https://github.com/ManabiIO/manabitan/actions/runs/35140252368), [independent confirmation](https://github.com/ManabiIO/manabitan/actions/runs/35140940983), [initial qualification](https://github.com/ManabiIO/manabitan/actions/runs/35139921065), [final qualification](https://github.com/ManabiIO/manabitan/actions/runs/35140525478), and [immutable candidate recipes](https://github.com/ManabiIO/manabitan/tree/9af84e33dd95055a06ef0a6de693188608a8f2f3/dev/perf/crc-lifetime-20260916).

The downloadable evidence preserves original artifact ZIPs, audit script/results/checksums, exact patches, final regression tests, compatibility receipts, supplemental native sources and sanitizer logs. Actions artifacts have 30-day retention. No future background work is implied.

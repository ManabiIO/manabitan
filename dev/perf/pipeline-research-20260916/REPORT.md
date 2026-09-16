# Import pipeline research — September 16, 2026

## Published changes

**Performance PR #46:** retain the smaller alignment-only shared-source byte gather. Final qualified head `e3a92260e02bf2bf0ffa99e4b049e52f60974cd7`, tree `0d58dc24870045bd6c6bafc29b1668bb31425655`. Two files only: `dev/lib/zstd-wasm.js` and 14 new tests. Marked ready for review; not merged.

**Separate test-only PR #47:** fix the 38 inherited composite-parser-test lint errors without changing fixtures or assertions. Qualified head `498016cb7db326ac233ba1fee119d89796cda08c`, tree `caeb895edb2d8b0b8f89678b513e3b684fb26b2e`. No production code changes; not merged.

Production baseline remains `c0a1b7ee6fa1383a0a422361d2a8b7f826499fff`, tree `a48da18d4244b00661d0c6518b2ce77b9f2f9b55`. Earlier scanner optimizations are already included. The separate libdeflate proposal and previous round's observations are not mixed into these results.

## Findings and implementation

Fresh full-import profiles identified shared-source gathering into private compression memory as a more useful target than further small parser primitives. An image-metadata round-trip idea was rejected because the normal import path already skips it.

[Lemire's shared-copy analysis](https://lemire.me/blog/2025/02/07/thread-safe-memory-copy/), V8's [TypedArray.set source](https://chromium.googlesource.com/v8/v8.git/+/a0a196ea623239e178c0e9dc9e877d64d132fe0e/src/builtins/typed-array-set.tq), and the [older documented relaxed-copy implementation](https://chromium.googlesource.com/v8/v8/+/refs/heads/chromium/5073/src/base/atomicops.h) motivated inspecting alignment. They support the hypothesis, not proof of the exact machine-code path in every browser; published microbenchmark multipliers are not Manabitan import results.

The selected implementation copies an alignment-matched tail into private compression memory, moves only private bytes into position, and fills the short prefix. All ranges remain within the validated source/destination spans. Ordinary, small, already-aligned and shared-destination paths retain the original behavior. There is no new helper or typed-word view, payload allocation, padding, overread, await or retained borrowed source. The existing source-immutability/source-consumed acknowledgement contract is unchanged. This is not a concurrent snapshot protocol or a reduction in total copied bytes.

No compression quality, storage format, integrity validation, source budget, worker count, cache policy or experiment default changes.

## Complete browser-import results

Values are median adjacent `100 * (B/A - 1)`; negative is faster. Initial screens have six alternating pairs; independent confirmation has twelve pairs, reversed starting order. Both include excluded complete warmups and interleaved same-binary controls. Different hosts are never pooled. No retries or removed outliers.

| Variant | Initial JMdict | Initial Jitendex | Independent JMdict | Independent Jitendex |
| --- | ---: | ---: | ---: | ---: |
| Four-byte gather | +1.588% | -1.275% | Not promoted | Not promoted |
| Eight-byte gather | +0.048% | -3.688% | -2.162%, 11/12 faster | -4.942%, 11/12 faster |
| Aligned cache copy | -1.444% | -1.363% | -1.656%, 10/12 faster | +0.148%, 5/12 faster |
| Scalar pending descriptors | -1.667% | -0.907% | -4.569%, 7/12 faster | -0.275%, 7/12 faster |
| Typed pending hash columns | -0.839% | -0.351% | Not promoted | Not promoted |
| **Selected alignment-only gather** | **-2.037%** | **-5.854%** | **-0.710%, 9/12 faster** | **-3.084%, 11/12 faster** |

For the selected source, independent equal-work changes are -0.602% JMdict and -2.372% Jitendex. Median absolute A/A variation is 1.409% and 0.972%, respectively. **No useful general JMdict speedup is established**; its measured improvement is smaller than the observed control variation. Jitendex's +20.306% slower confirmation pair is retained rather than retried or trimmed.

A direct comparison of **A=eight-byte gather, B=alignment-only gather** measured JMdict -2.125% (4/6 faster, equal-work -5.259%) and Jitendex +0.343% (2/6 faster, equal-work -0.589%). It does not establish a consistent advantage for the larger implementation. The simpler source was selected for lower complexity, not by ranking different hosts' absolute times. The larger implementation's earlier -2.162%/-4.942% figures are not attributed to the final PR.

The other variants remain unpromoted. Cache-copy Jitendex effects cannot be attributed to that helper because the source route retains zero recent-source cache bytes. The scalar-descriptor JMdict comparison is noisy and includes a +49.267% same-binary outlier; Jitendex's result is comparable to noise.

## Audit and fixtures

All **584 observations** completed and passed independent raw-report re-audit: 544 production-comparison observations plus 40 direct-design observations, comprising 180 measured pairs, 90 A/A pairs and 44 excluded warmups across 22 cells. The selected candidate alone has 116 production-baseline observations.

Complete fixtures: JMdict 2026-09-06, 526,942 rows, ZIP SHA-256 `7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a`; Jitendex 2026.08.11.0, 435,448 rows, SHA-256 `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc`.

Ubuntu 24.04 x64, Node 24.20.0, Clang 18.1.3, Chromium 153.0.8010.12; fresh browser profiles, real OPFS-SAH-pool storage and production settings. All ten actual worker experiment receipts are false. Timing is file-input change through post-UI completion, without traces, profiling, screenshots or process sampling.

Packages were genuinely built at the same filesystem path; only intended source/module/map entries differ. The audit verifies exact fixture/source/package/harness identities, fixed-plan order, raw timing, full rows and title/revision, twelve persisted-content probes, real storage, flags, source/group/worker counts, dedup work and content/record/lookup-index write bytes. Work and maximum individual parser-worker heaps agree across arms. This is not exhaustive persisted-store equality or whole-process peak-memory measurement.

## Exact qualification

[Final selected-source qualification](https://github.com/ManabiIO/manabitan/actions/runs/35133898395): **6,534 unit tests passed**, 46 existing skips; **27 options tests**, **130 focused tests**, all four strict type projects, changed-file ESLint, all build plans, actual Chrome/Firefox packages, and **84 strict Chromium lifecycle phases**, with no skipped verification. Coverage includes import/update, lookup continuity, restart/crash recovery and deletion.

The 14 new tests check all alignments, thresholds, tails, guards, physical buffer ends, ordinary/shared backing, overlapping fallback, reordered/gapped/repeated/empty spans, invalid metadata, source reuse, shared WASM growth and destination refresh. Actual Zstd tests compare every compressed-frame/envelope byte with and without dictionaries and decompress after overwriting the original source. They also pass against the unchanged parent.

The initial smaller-source qualification failed on two ternary-formatting diagnostics after tests/types passed. Only line breaks were changed. Final qualification proves complete AST equality and byte-identical generated executable/parser WASM between measured and formatted source; source maps may differ.

- Measured source SHA-256: `88c127aa4a4339f193ae68d21b675bcd47a676328e178c31a58eb1ea009314e3`.
- Final source: `ffced26811bf43ae5b8ee3fd41390c3f55dde24abbde754ce9ca2a9b1b059bf6`.
- Identical generated Zstd executable: `fb489e79b68fda55e25cb386adf7a719cca5cf349e3273d5987b75d4f6e087b8`.
- New test: `56dd01bf78ec8a85b08d12e0f71757751a42188c14812bc740837a5be3b284c5`.

[Separate cleanup qualification](https://github.com/ManabiIO/manabitan/actions/runs/35134251170) reproduced exactly 38 parent lint errors and then passed full JavaScript lint, 52 focused tests, 6,520 unit tests, 27 options tests, all four type projects and all build plans. Complete AST comparison preserves every test literal and assertion after the explicitly reviewed Array.from-to-spread style normalization. Its first workflow lacked generated lint dependencies and failed before the intended RED phase; that setup failure is retained in run 35133956902.

At the final review, ordinary PR #46 CI run 35134583444 reported `action_required`; dedicated qualification is not a substitute for claiming normal PR CI green. PR #47 fixes the separate inherited lint debt but is not merged into #46's base. Both PRs are ready for review, not a claim of completed release qualification.

## Reproduction and remaining limits

[Profiles](https://github.com/ManabiIO/manabitan/actions/runs/35129214366), [initial screens](https://github.com/ManabiIO/manabitan/actions/runs/35130033393), [three confirmations](https://github.com/ManabiIO/manabitan/actions/runs/35130807493), [alternatives](https://github.com/ManabiIO/manabitan/actions/runs/35131081724), [selected-source confirmation](https://github.com/ManabiIO/manabitan/actions/runs/35132078813), [direct comparison](https://github.com/ManabiIO/manabitan/actions/runs/35132974171), and [final qualification](https://github.com/ManabiIO/manabitan/actions/runs/35133898395).

Exact candidate generators and the standalone benchmark driver are retained in this directory and in each raw artifact. The downloadable evidence also preserves the complete independent audit, raw artifact ZIPs, candidate patches and qualification/failure logs. Artifacts have 30-day retention.

Related older PR #29 remains closed; its adverse constrained-host observations on rejected ancestry are not erased. Fresh current-base constrained-device, Firefox/Safari/ARM/mobile/native Reader performance, cold-OS behavior, and total-browser memory gains are not established. Firefox packaging is not Firefox runtime performance. No merge, release change, or automatic future work is implied.
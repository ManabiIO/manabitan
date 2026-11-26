# Metadata parser parity — 2026-11-25

This record establishes complete parser-output equality for the current #831 candidate over **7,613,164 rows per arm**. It makes no import-speed claim. Browser timing, persistence, and memory qualification are separate.

## Source identity

- Baseline: `7d1643e6147a10cb2165e9744cf0e63b59e46632`.
- Published #831 candidate: `11bf4550a26e98ccc3df1579da7444244fe1e861`.
- Tested local candidate: `2bd40d8063ba4b1e6db3e6a53e68bd7786888594`.
- Both candidate commits have tree `49ea808e09b3d9ce26c27614c1b49ff9f0466c70`.

The JSON preserves full parser-source, native-module, fixture, fixture-lock, output, and oracle-program SHA-256 values. Source and WASM digests were checked directly against the published candidate and baseline Git objects; their fixture-lock digests also match. Native artifacts use Clang/LLD 21.1.8; parity ran on Node 24.22.3.

## Complete results

| Corpus   | Rows per arm | Candidate metadata reuses | Reused object bytes | Maximum WASM bytes, both arms | Fused fallbacks, both arms |
| -------- | -----------: | ------------------------: | ------------------: | ----------------------------: | -------------------------: |
| JMdict   |      528,299 |                   851,490 |          19,960,198 |                    61,603,840 |                          0 |
| Jitendex |      436,555 |                 1,447,741 |          42,243,721 |                    89,063,424 |                          0 |
| VNDB     |    6,648,310 |                   303,562 |          24,223,053 |                   109,969,408 |                         21 |

Every baseline/candidate output digest matches. The oracle covers canonical content and metadata, hashes, unique indexes, expression/reading plans, numeric columns, prepared lookup output when emitted, and parser media candidates. Media-candidate counts include conservative false positives and must not be read as image-file counts. The complete digests and per-arm counters are in [metadata-parser-parity-20261125.json](metadata-parser-parity-20261125.json).

There was one complete pass per arm per corpus. Group sizes were seven term banks for JMdict and ten for Jitendex and VNDB, chosen for this diagnostic execution. These are not production-planner overrides or importer performance measurements.

## Failed attempts retained in the interpretation

The initial process completed JMdict and Jitendex, then was killed with exit 137 while opening VNDB, before producing any VNDB row result. VNDB was restarted separately with file-backed ZIP reads, an entry generator, ten-bank groups, and a 640 MiB JavaScript heap cap.

The first file-backed attempt stopped on an overly strict harness assertion: baseline fallback groups legitimately omit prepared lookup indexes. The oracle was corrected to permit that optional output and hash its presence and bytes. The subsequent full VNDB pass completed with equal output and the same 21 fused fallbacks in both arms. The incomplete attempts are not passing observations. The JSON records distinct hashes for the original and corrected oracle programs.

## Limits

The equal WASM measurements describe maximum native linear-memory lengths observed by the parser. They do not measure browser RSS/PSS, JavaScript allocations, pipeline retention, or whole-import peak memory. The candidate adds a fixed 1,040-byte call-local stack cache; no memory-neutrality claim follows from the equal linear-memory sizes.

The runs parse verified ZIP term-bank JSON in process. They do not exercise the browser extension, compression-worker pipeline, database persistence, media blob writes, restart behavior, or whole-import completion. Those properties and any speed or browser-memory conclusion require the separate frozen exact-SHA browser qualification.

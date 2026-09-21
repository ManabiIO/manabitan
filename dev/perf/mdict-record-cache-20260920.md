# MDict dense record-block cache benchmark — 2026-09-20

## Decision

Enable the existing bounded record-block cache **only for MDX conversion**, with an 8 MiB byte budget and the reader's existing 64-entry ceiling. Keep the generic reader default at zero and keep lazy MDD resource lookup uncached.

This is not a new cache implementation. The correctness-reviewed cache already returns owned record bytes, enforces its byte/entry bounds, and clears on close. The change only opts the dense import-conversion path into that cache through the [MDX converter](../../ext/js/dictionary/mdx/mdx-converter.js).

## Why the workload differs from lookup

`createMdxImportData` iterates the complete MDX keyword list and fetches every definition. Entries that share a record block therefore cause repeated decompression when the generic cache default is zero. Sparse installed lookup and lazy MDD asset access do not have this property, so their mixed benchmark results are not a reason to disable caching for the dense conversion path.

## Method

- Node: v22.16.0.
- Production MDict parser and the exact bundled pako decoder.
- Correctness-fixed converter including the R5 pairing/feedback composition.
- Candidate differs only at MDX construction: `recordBlockCacheBytes: 8 * 1024 * 1024`.
- Deterministic independently generated zlib MDict fixture.
- 2,048 entries, 32 KiB record blocks, 64 keys per key block.
- Fresh parser/conversion for every sample.
- Warm-up order ABBA followed by **8 ABBA rounds**.
- Conversion-prep output was SHA-256 checked across every file in the generated Yomitan archive map; baseline and candidate hashes were identical.
- ZIP benchmark additionally calls `convertMdxToArchive`; archive sizes were identical. Raw ZIP byte identity is not asserted because ZIP metadata can vary.
- Fixture generation, hashing, and benchmark-report serialization are outside the timed interval.

## Results

- Highly compressible conversion preparation: baseline median **242.868 ms**, candidate **70.880 ms**, median paired reduction **70.65%**.
- Highly compressible conversion + ZIP creation: baseline median **283.341 ms**, candidate **79.933 ms**, median paired reduction **71.29%**.
- Less-compressible randomized-text conversion preparation: baseline median **751.744 ms**, candidate **101.949 ms**, median paired reduction **86.13%**.

Every paired round favored the cache. The less-compressible fixture is 848,452 bytes on disk versus roughly 34 KiB for the intentionally repetitive fixture, so the result is not dependent on an unusually tiny compressed source.

These are converter/ZIP preparation measurements, **not OPFS/database end-to-end import latency**. Storage publication can dilute the percentage at whole-import scope. The optimization removes redundant record decompression without changing the generated dictionary content.

## Regression gate

`test/util/mdict-import-cache-cases.js` instruments the production reader during `createMdxImportData` and verifies that a dense fixture decompresses each record block once rather than once per entry. It also verifies generated term-bank output remains present.

Do not promote caching to generic sparse lookup or MDD resource resolution without separate workload-specific evidence.

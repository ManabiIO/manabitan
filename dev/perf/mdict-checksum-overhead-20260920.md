# MDict checksum validation overhead — 2026-09-20

## Decision

Validate MDict Adler-32 checksums for headers and compressed envelopes, stacked
after the dense MDX record-block cache.

The format carries integrity values that were previously read or skipped without
verification. Corrupt metadata or record blocks could therefore progress farther
through conversion and sometimes be reported only as a later decode/range error.

## Integrity coverage

The candidate validates the vendored
[MDict parser](../../ext/js/dictionary/mdx/vendor/js-mdict/mdict-base.js):

- dictionary header bytes (the format stores this checksum little-endian);
- the v2 key header;
- decompressed v2 key-info content;
- every decompressed key block;
- record blocks in both the eager legacy path and the lazy lookup path.

Checksum mismatches use explicit `checksum mismatch` errors so the existing
client error normalization can present fresh-copy/integrity guidance.

## Regression evidence

The focused checksum suite includes:

- the standard Adler-32 `Wikipedia` vector, expected `0x11e60398`;
- one-bit corruption in each of the header, key header, key-info envelope,
  key-block envelope, and record-block envelope;
- lazy record corruption, which must reject when the definition is accessed.

Before publishing, the checksum candidate passed the retained native parser and
client suite plus the new corruption cases: **46 passed / 0 failed**.

## Performance method

Checksum work was benchmarked *on top of* the 8 MiB dense MDX record-block cache,
rather than against the uncached converter. This matters because the uncached
path redundantly decodes and checks the same record block for many entries.

Environment and workload:

- Node v22.16.0;
- production parser and bundled pako;
- deterministic 2,048-entry randomized-text MDX fixture;
- 32 KiB record blocks;
- MDX size 848,563 bytes;
- warm-up ABBA followed by 8 ABBA rounds;
- A = cache-only, B = cache + checksum verification;
- generated dictionary file maps are SHA-256 identical for every sample.

## Result

- cache-only sample median: **106.282 ms**
- cache + checksum sample median: **104.265 ms**
- paired-round median checksum overhead: **1.68%**

Individual paired-round overheads were noisy and ranged from -3.55% to +9.07%;
the median is the appropriate summary. The candidate is not claimed to make
conversion faster than cache-only; the slightly lower raw sample median is
measurement noise.

This remains a conversion-preparation benchmark, not whole OPFS/database import
latency.

## Remaining integrity work

Adler verification does not bound decompression output allocation. Zlib and
especially the vendored LZO decoder still need malformed-input/resource-limit
hardening before universal hostile-file robustness can be claimed.

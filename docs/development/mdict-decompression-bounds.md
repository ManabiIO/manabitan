# MDict decompression bounds

This change is stacked after the dense MDX record-block cache and Adler-32
integrity validation. It addresses a different failure mode: compressed MDict
blocks previously decompressed without an output bound and were compared with
their declared size only after allocation and decoding completed.

## Invariants

- Zlib output is streamed through pako and rejected before retaining a chunk
  that would take output beyond the block's declared unpacked size.
- LZO output growth cannot exceed the declared unpacked size. The wrapper starts
  with at most 16 KiB and the decoder grows geometrically, so valid larger blocks
  do not repeatedly copy an 8 KiB buffer.
- Key-info, key-block, and record-block metadata are rejected before
  decompression when the declared unpacked block exceeds the parser's configured
  ceiling.
- The default per-block ceiling is 256 MiB. It is intentionally a block limit,
  not a dictionary-total limit; large dictionaries can contain many blocks.
- Callers can lower the ceiling through `maxDecompressedBlockBytes`. A zero
  ceiling remains valid for an empty dictionary.
- Existing decoded-size and Adler-32 checks remain authoritative after
  decompression. Output bounds do not replace integrity checks.

The limit is meant to keep a small compressed input or hostile declared size
from driving unbounded browser allocation. Representative real dictionaries
must still be checked before merge because a legitimate dictionary using a
single decompressed block above 256 MiB would now be rejected.

## What this does not claim

The vendored LZO decoder still contains historical commented input/lookbehind
checks. Bounding output prevents decompression allocation from exceeding the
declared/capped size, and checksum validation rejects corrupt decoded bytes, but
this change does not claim complete malformed-LZO validation. Input and
lookbehind hardening should be evaluated separately with independent LZO
fixtures.

Likewise, the limit is per block. It does not cap total dictionary size, total
number of blocks, total keyword count, conversion ZIP size, or OPFS storage.

## Tests

`test/util/mdict-decompression-limit-cases.js` includes:

- a direct bounded-pako success case;
- a high-ratio zlib stream rejected one byte above the declaration;
- zero-length zlib output;
- an independently encoded literal-only LZO1X stream;
- LZO output rejected one byte above the declaration;
- invalid bound values;
- a native key block whose declared size is one byte too small;
- raw and zlib record blocks rejected by a low configurable ceiling;
- key-info metadata rejected before inflate; and
- an empty dictionary with a zero ceiling.

The focused MDict workflow and the existing Vitest native wrapper run this suite.

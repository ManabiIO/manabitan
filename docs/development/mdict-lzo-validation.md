# MDict LZO input validation

This change is stacked after the [MDict decompression-output bounds](mdict-decompression-bounds.md). It restores the
input and lookbehind safety checks which the vendored `minilzo-js` port kept as
comments but did not execute.

## Invariants

The decoder now checks before it:

- reads a control, offset, literal, or extended-length byte;
- copies literal bytes from the compressed input;
- copies a backreference whose starting position is before or at/after the
  current output position; or
- grows output beyond the bound established by the parent decompression-limit
  change.

Extended LZO lengths are accumulated only as safe JavaScript integers. Truncated
streams fail with an input-overrun error instead of reading `undefined` from a
typed array and allowing JavaScript coercion to continue decoding. Invalid
backreferences fail instead of reading missing output bytes as zeros.

The normal LZO EOF marker remains supported. This patch deliberately does not
add a new trailing-byte policy; compatibility for dictionaries that pad LZO
payloads should be evaluated separately before requiring complete compressed
input consumption.

## Independent positive vectors

`test/util/mdict-lzo-validation-cases.js` contains three static LZO1X byte
streams generated outside this repository with system `liblzo2`
`lzo1x_1_compress`, then independently verified with
`lzo1x_decompress_safe`. They exercise literals and backreferences without
using the vendored JavaScript compressor to generate expected inputs.

The suite also checks every truncated prefix of a backreference-heavy vector,
empty input, a truncated initial literal run, an unterminated extended literal
length, a match that points before output, all 256 one-byte controls, and the
parent output ceiling.

This is parser correctness/safety work, not a performance optimization.

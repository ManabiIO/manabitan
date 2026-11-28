# Native DEFLATE follow-up: no new candidate proposed

This bounded read-only review found substantial native decode work, but no
concrete removable operation that presently justifies another implementation
or timing cohort. Keep the current candidates separate and decide them from
their complete browser evidence. No inflater source, threshold, worker policy,
native module or benchmark was changed or executed for this review.

## What the existing Chromium evidence establishes

The profile research commit is
`44f51f85ea8269caa060d75e11971945c7c4c497`, with runtime baseline
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The ordinary JMdict observation
reports 1,053.4 ms total import and 459.3 ms summed source-inflation work. The
separate traced observation reports 1,297.9 ms total and 402.1 ms in that
source-inflation counter.

The exact production module's function-name mapping gives the following
**same-trace, summed parser-worker sample attribution**:

| Function | Scope | Retained sampled milliseconds |
| --- | --- | ---: |
| `inflate_and_join_term_banks` | Inclusive native wrapper | 402.698 |
| `libdeflate_deflate_decompress_ex` | Self | 228.037 |
| `crc32_bytes` | Self | 166.852 |
| `build_decode_table` | Self, retained top frames | 5.304 |

The ordinary 459.3 ms and traced 166.852 ms are different observations: neither
addition nor subtraction between them is a valid decomposition. The source
counter also begins **after** JavaScript allocation and compressed-input copying;
it includes native inflation, immediate CRC and wrapper checks. The earlier CRC
component deliberately used a broader owning timer and must retain that scope.

The retained attribution keeps only the top 25 self frames per worker. Two
workers retain table-building samples of 3.390 and 1.914 ms; the third omits
the function and has a 2.898 ms cutoff. Thus these rounded summaries bound
this named function at approximately **8.2 sampled ms**, not an exact CPU
duration or possible elapsed-import saving. Dynamic-header bit decoding
inlined into the main decoder is outside that particular bound. The function
profile alone cannot separate bit-reader, literal decode and history-copy cost.

The named module has SHA256
`b0177c031902070af8526928769926cb5236ee2ad10f2c804473d12476237e29`.
Its non-custom sections were independently rechecked byte-identical to the
profile's production module
`8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee`.
The profile and source hashes, exact paths, top-frame bounds and module mapping
are recorded in [review.json](review.json).

## Already removed or already reused

- **Decompressor construction:** `term-bank-inflate.c` owns one persistent,
  zero-initialized static libdeflate context per parser instance. There is no
  per-bank allocator, streaming-state construction or runtime CPU dispatcher
  to remove. Calls remain synchronous under the existing instance ownership.
- **Fixed Huffman tables:** `decompress_template.h` already retains
  `static_codes_loaded` and skips rebuilding fixed tables across blocks and
  streams until a dynamic block intervenes.
- **Decoded-bank ownership copies:** inflation writes directly into the
  parser-owned output arena. All twelve locked JMdict groups contain four or
  five banks, so the existing independent-span branch skips the joined-bank
  interior move. The one source copy here moves 15,632,849 compressed bytes into
  WASM memory; it is not another copy of the 171,617,523 decoded bytes.
- **Wide native decode/copy words:** the WASM build already selects 64-bit
  `machine_word_t`, branchless refilling, literal preloading and the upstream
  fast-loop bounds strategy. Reintroducing that selection would duplicate
  [#664](https://github.com/ManabiIO/manabitan/pull/664).

The inflater wrapper, vendor decoder, template, word definitions and JS source
wrapper are byte-identical between the profile baseline and current baseline
`dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`. This does not imply that the complete
current parser module or its generated layout is identical.

## Why the remaining ideas do not yet warrant a variant

Caching identical dynamic Huffman tables is a distinct source-level idea, but
the current implementation overlays the new header lengths/precode and the old
literal/length table in a union. A cache is not simply an omitted rebuild: it
needs separately retained state or copies, exact validated length-vector
identity and correct invalidation. There is no measured corpus repetition
census, and the named table builder accounts for only the small sample budget
above. The available evidence does not justify that additional state.

The hot decoder still contains bit-buffer refills, table loads and match
expansion. Its function-level attribution does not identify one as redundant.
Changing refill placement or integer expression widths would therefore be a
new throughput hypothesis, not a demonstrated removal of repeated work. No
variant, width sweep or speculative speed estimate is proposed.

SIMD history expansion is already covered by
[#812](https://github.com/ManabiIO/manabitan/pull/812), runtime
`5555f3efd3e0c8baa99e93b4c14e7f1889c30383`, study
`1788fa1fe889c407d24d0f4b5ca23689946fbcec`. Its 252 fresh-profile imports did
not replicate a whole-import gain: JMdict paired medians were −1.97% forward
and +0.64% reversed, and every candidate median interval crossed zero. Repeating
that implementation would not be a new opportunity.

Other relevant prior sources are the original full-buffer decoder introduction
[#41](https://github.com/ManabiIO/manabitan/pull/41), the earlier native
self-copy removal [#39](https://github.com/ManabiIO/manabitan/pull/39), and the
inactive decoder-switch cleanup
[#642](https://github.com/ManabiIO/manabitan/pull/642). Targeted PR searches
found no explicit dynamic-table cache or bit-buffer proposal; this is not an
exhaustive assertion that no earlier experiment exists.

**Decision:** no new inflater implementation or measurement is justified by
this review. The current CRC browser result also demonstrates why its favorable
Node owning-phase result cannot be used as a browser throughput guarantee.

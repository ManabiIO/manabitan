# Existing Jitendex-related work

Read-only verification on 2026-11-25 found the following relevant source state.
It does not turn this session's rejected experiments into runtime proposals.

## Unused decompression contexts: PR #891

<https://github.com/ManabiIO/manabitan/pull/891>

Exact head `b9cf94b4cc088cb4e06a4ae5cae6b29a7ae59241` changes only
`zstd-term-content.js` at runtime. The existing compression-worker realm is
marked before loading the codec and uses four workers. The patch defers an
unused decoder there, creates it if dictionary decompression is later needed,
and preserves ordinary eager initialization. Existing tests cover output
equality, deferred allocation failures and retry.

The retained probe's 95,816 bytes per context is allocator address spacing,
including overhead. The stated 383,264 bytes for four workers is arithmetic,
not a measured pool or process-memory reduction. Initial WASM memory remains
16,908,288 bytes per module. There is no established complete-import speedup
or process peak-memory reduction. All seven exact-head workflows pass, including
<https://github.com/ManabiIO/manabitan/actions/runs/45640482102>.

## Borrowed large content: merged PR #881

<https://github.com/ManabiIO/manabitan/pull/881>

Merge `55fd951d79cc8a69fbad2e41a087bbe63c5212d5` is already an ancestor of this
session's frozen baseline. Its published older-baseline Jitendex timing
observations independently reproduce paired medians of -9.734711%/-11.571353%
against A/C on one host and -9.511869%/-10.019964% on the other. Those compare
`bbccabd...` to `9bc16b4...`; they are not new gains against current `7d1643e...`.
The original failed observations remain separately disclosed by that PR.

PR #874 remains on hold with inconsistent timing confirmation on its older
private-content route. Current ordinary Jitendex groups use #881's borrowed
content path, so its older observations are not transferred to current source.

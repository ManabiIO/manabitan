# Stage 1 result: complete output parity, no timing acquired

The isolated native helper reproduces every byte emitted by all twelve actual current JMdict record-field calls: **528,299 rows, zero native fallback**. Fresh calls to the unchanged stock encoder also reproduce every captured original output. Every input column remains unchanged, score dictionary entries retain their first-occurrence order, and returned buffers remain owned and unchanged after later helper reuse and memory growth.

The source capture is one complete stock import on baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. All twelve calls pass the actual private factory-origin/synchronous-reference predicate. There are no additional sink splits. The original stock outputs remain consumed by the import; all 103 compression frames, content references, and finalized content/row/lookup payload hashes match the retained current-baseline oracle. The full capture is 12,858,712 raw bytes in 4,111,914 bytes of verified gzip containers. The snapshot retains all input columns and all consumed output bytes.

## Cost accounting

| Complete twelve-call sequence | Bytes or count |
| --- | ---: |
| Rows | 528,299 |
| Resolved unique-column entries | 366,030 |
| Native input copies | 48 |
| Input bytes copied into native memory | 8,618,752 |
| Output bytes copied into independent JS storage | 4,239,960 |
| Total JS/native boundary copy bytes | 12,858,712 |
| Hash-slot zeroing | 6,291,456 |
| Score dictionary bytes copied inside native memory | 13,376 |
| Score-key bytes copied inside native memory | 1,056,598 |
| Sum of per-call scratch extents | 9,461,250 |
| Maximum per-call scratch extent | 824,288 |
| Initial native memory | 131,072 |
| Native memory growth | 2,293,760 |
| Maximum retained native memory | 2,424,832 |
| Native score entries across calls | 3,344 |

Scratch extents are reused capacity, not cumulative simultaneously live memory. Native memory includes the stack prefix, copied inputs, table/dictionary/key scratch, output capacity and page rounding. The table has capacity bounded by the row count and compact score limit; occupied-probe work has a total budget of `4 * rowCount + slotCount`. Exhaustion falls back to the unchanged JS encoder, so a hostile score distribution cannot create an unbounded native chain.

These are explicit byte/work counts, not hardware traffic, memory-peak measurements, or speed estimates. The private native memory and boundary copies are additional costs relative to the current direct-output JS path. No runtime fetch, startup overlap, or browser behavior has been changed.

## Source, tests and review

- C SHA-256: `7344ab6d0b449a938bb848468ca0d8012baa940be02a5a07c32b419f072cbc30`.
- WASM: **1,753 bytes**, SHA-256 `8556f66c8af26ac3c0386f7ca068ffb10a5bd8949e34facde7e8451d46bf4e7a`.
- Wrapper SHA-256: `aaf1e0c405bdf8aa241d501daa69a6b4df3636a4d57b1297e7c1b6d2f4c88830`.
- Pinned Clang/LLD 21.1.8 builds 002 and 003 produce identical WASM. Bulk-memory operations are an explicit required feature.
- Final focused run: **51/51 cases pass**. It covers arbitrary int32 extremes and collisions, bounded-probe fallback, exact score ordering, null offsets and large bases, all eight ABI region/alignment/alias/memory bounds, compact length/size/cardinality boundaries, genuine internal element brands, forged typed-array prototypes, shared/resizable/accessor/proxy/shadow inputs, malformed native returns, and independent output lifetime.
- Independent C/layout review and independent wrapper/guard review found no remaining blocker. The wrapper review caused two fixes before the final pass: inherited fixed-base properties now preserve generic getter behavior, and inputs backed by the helper's own memory are rejected before growth or staging copies.

All attempts are retained. The first build predates the explicit global probe-work budget; it was never measured. The first focused run passed 46/47 cases: a deliberately colliding success test incorrectly required native activation after exhausting the correct work budget. Every compared output still matched stock. The successful-chain test was reduced to eight colliding scores, while a separate larger collision test explicitly requires the fallback. The original failing receipt and exact old wrapper/test source are preserved. The final per-region test expansion changes only tests; native C, WASM and wrapper remain unchanged from the complete captured-call parity.

## Next boundary

Stage 1 establishes feasibility and correctness of the isolated helper. A later component screen must time the complete sequence: asset read, module compilation, instantiation, memory setup/growth, live guards, every input/output copy, slot clearing, and all twelve calls in their original order. Captures, stock source imports and input reconstruction must be prepared identically outside all arms; all owning outputs must remain live through the timed sequence. Full output comparison and hashes belong after the timer. Any component nomination still requires independent whole-browser import qualification.

# Native image-path batching: complete component gate passed

The frozen path-batching candidate passed every prospective gate in the complete local VNDB projection component. All 3,060 group observations completed, all outputs and source identities matched, and the two unchanged arms remained within the 5% control bound. This supports a subsequent independent browser comparison; it does not establish a whole-import speedup or qualify a PR by itself.

## Exact corpus and work boundary

Acquisition used the unchanged current source pipeline and real parser workers at baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. A test-only hook ran after the unchanged worker result copy while the original source remained live. Every dispatched group matched the independently completed dense VNDB census, including bank lists and compressed source sizes.

| Captured quantity | Complete-corpus count |
| --- | ---: |
| Source rows | 6,648,310 |
| Actual planner groups | 170 |
| Media rows / observer native projection calls | 146,725 |
| Unique media paths | 146,570 |
| Native single-token projections accepted as image paths | 146,725 |
| Unescaped ASCII path tokens | 146,725 |
| Native projection fallbacks | 0 |
| Raw glossary bytes | 84,398,732 |
| Path-token bytes, excluding quotes | 2,391,178 |
| Compressed fixture files | 7,077,646 bytes |

Every extra native projection reproduced the already-copied production path. Raw source spans, native heap end, memory object, and memory length remained unchanged. The 146,725 calls are measured group-local work; they are deliberately separate from the 146,570 unique files.

Replay restored one group's raw spans at their original absolute WASM offsets and original source bounds. Overlapping spans had to agree byte-for-byte. Source reconstruction, native parsing, ZIP work, decompression, output hashing, and explicit GC were outside the timing intervals. No full key, content, record, or lookup columns were captured.

The component compares the existing per-row native path helper with the candidate's batch helper. Both produce equivalent path/null entries for every media row. Six fixed counterbalanced A/B/C blocks use eight complete calls per source group. The reported corpus observations sum corresponding group intervals; they are not elapsed import or elapsed replay time. A and C independently load byte-identical baseline source; B loads the exact frozen candidate. All 170 groups are included.

## Fixed paired results

Negative percentages mean faster than the indicated unchanged arm. Percentages are medians of six paired block changes.

| Comparison | Median process CPU change | Median wall-interval change | Median CPU saved per corpus | CPU faster blocks | Wall faster blocks |
| --- | ---: | ---: | ---: | ---: | ---: |
| Candidate B / baseline A | −25.47% | −30.92% | 83.101 ms | 6/6 | 6/6 |
| Candidate B / baseline C | −24.46% | −32.06% | 77.940 ms | 6/6 | 6/6 |
| Identical baseline C / A | +1.92% | +2.28% | −6.419 ms | 3/6 | 2/6 |

Median individual corpus CPU observations were A 321.063 ms, B 240.707 ms, and C 318.647 ms. Median wall-interval sums were A 256.173 ms, B 176.577 ms, and C 256.459 ms. These individual medians describe the samples; the gate uses paired statistics.

All four prospective checks passed:

1. Complete observations and exact pre/post output, fixture, source, and probe oracles.
2. At least 15% median CPU and wall improvement versus both A and C, with at least 5/6 faster blocks for each.
3. At least 15 ms median CPU saved per complete VNDB path corpus versus each baseline.
4. Identical C/A median CPU and wall drift within 5%.

The fixed cohort ran once on Node 24.22.3. No observations failed, were replaced, or were omitted. The capture is untimed. Process and optional thread CPU are recorded separately; no browser memory qualification is inferred from process diagnostics.

## Source and retained evidence

The production mechanism is the root-owned worker-only path-batching candidate. Its parser SHA-256 is `69f6f44bb25b1ade2e77ad51a5c830ac359ec3d44f364a3c0ed6131728f54518`; the worker SHA-256 is `b368f85dc737f4cd2567fa1723e69f3276f6f8c0441085af3b94ac80ed2a0057`. The checked parser WASM is unchanged at `8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee`.

- Frozen source/script/probe receipt: `frozen-inputs.json`, SHA-256 `e84184b5356d72594a6abd0d701c647d3fb5e8e364e400acf70f7bd67a71b954`.
- Complete fixture manifest: `fixtures-vndb/manifest.json`, SHA-256 `810c067eabf70271a5440775751420ce065e3bfc1ce2a47bfd2cb61c4876a8a2`.
- Complete observations and gates: `component-result.json`, SHA-256 `294fdad7cd4e052737597cc422f2d6ee0527cc48f5f067d58f5e56e2efe87c34`.
- Frozen driver: `path-component.mjs`, SHA-256 `50202feb9a645709a5bd38c2088a433cb8da964448dcb0e57afebc9b63ef7e44`.
- Frozen worker adapter: `capture-worker.mjs`, SHA-256 `3e507fe3ec39d987fba9f31d3821863ca33e03096d5751719183809d30c4cc41`.
- Frozen prospective plan: `benchmark-plan.md`, SHA-256 `80b7b1878e524a7567daa7bca90b54b6653a47c4d2130707242fa9bcfae26132`.

The next useful validation is an independent complete-browser cohort with complete-media parity, restart/storage checks, and unchanged controls. No import percentage should be projected by dividing this component saving by an unrelated browser baseline.

## Follow-up enclosing-copy correctness status

The complete component result above remains the isolated projection measurement. Subsequent local enclosing-copy attempts did not establish a complete oracle and are retained separately:

| Attempt | Outcome | Successful groups | Source rows checked | Group-local media rows checked |
| --- | --- | ---: | ---: | ---: |
| Cross-module alias comparison | Failed on the module-local empty singleton identity; complete bytes/values matched | 0 aggregate | — | — |
| Same-module ordinary persistent workers | Externally killed with exit 137 | 135 | 5,390,000 | 115,031 |
| Bounded worker adapter, initial startup | Node rejected explicit worker V8 heap arguments before parsing | 0 | 0 | 0 |
| Bounded worker adapter, corrected startup | Externally killed with exit 137 | 79 | 3,160,000 | 66,619 |

The zero-byte alias mismatch was reproduced with two real-WASM rows: native parsing and copying in different modules use different empty-array constants. The revised oracle compares the candidate's public and batched copies within the same candidate module for exact alias equality, and uses the frozen baseline copy independently for every value and byte. No alias is normalized. The source proof and diagnostic are retained as `public-false-branch-proof.json` and `zero-alias-diagnostic.json`.

The terminations remain unclassified host/adapter resource failures. An initial hypothesis that fulfilled pipeline result slots retained chunks was retracted after checking the existing cleanup, which clears both chunk and consume references. None of the partial groups is combined into a complete pass.

The distinct hosted correctness package at `../path-copy-hosted/` returns to ordinary persistent workers and requires every one of the original 170 groups, exact reference file lists and path digests, all rows, and exactly 170 prepared indexes and routes. Its reviewed digest traverses the original object graph and preserves view/backing identities while hashing only the live region of the whole-heap content view. Eight targeted graph checks and two two-row real-WASM smoke groups passed locally on Node 24.22.3. The complete hosted result is still a separate gate; this report does not claim it has passed.

The three local copy-oracle probe modules were archived and byte-verified before removing only those known untracked files from the root checkout. `loaded-copy-oracle-probes.tar.gz` and `copy-oracle-probe-archive-receipt.json` preserve their exact identities. All failed and partial receipts and their original drivers/helpers remain unchanged.

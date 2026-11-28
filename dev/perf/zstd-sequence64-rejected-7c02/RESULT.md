# Sequence64 experiment: did not qualify for publication

The private wasm32 64-bit sequence writer preserved every checked successful
compressed byte, envelope, decoded value and error/capacity contract. It did
**not** meet the performance gate frozen before measurement. This arm is held;
no PR, product reproduction or repeat timing cohort follows from this result.

The sole timed cohort used the corrected production JMdict block geometry:
103 blocks, 12 append groups, 362,032 surviving canonical records and
100,300,626 input bytes. Each group resets its block-to-context assignment modulo
four; the four contexts retain their logical destination-capacity high-water
marks across groups within that corpus. The same precomputed fresh-import
capacity map was used for every observation. Calls were serial through four
CCtx objects in one WASM instance per arm. Worker scheduling, separate worker
heaps, source alignment, allocation and full-import latency were outside scope.

## Fixed performance result

All 32 scheduled observations completed. No failures or observations were
removed, replaced or repeated. Two excluded full-corpus warmups per arm and the
eight counterbalanced orders were retained exactly. Pre/post complete frame and
envelope oracles, input identities, runtime identities and source identities all
passed.

| Comparison | Median paired CPU change | Median paired wall change | Faster observations, CPU / wall | Median CPU saving per corpus |
| --- | ---: | ---: | ---: | ---: |
| B0 / checked-in P | −2.762% | −2.720% | 5/8 / 5/8 | 4.848 ms |
| B0 / exact rebuild A0 | −1.525% | −1.701% | 6/8 / 6/8 | 2.652 ms |
| B0 / identity-copy C0 | −2.165% | −2.010% | 5/8 / 5/8 | 3.735 ms |

The frozen gate required at least 5% median paired CPU **and** wall improvement,
at least 7/8 faster observations for each metric, negative equal-work changes,
and at least 10 ms median CPU saving against **each** comparator. Those gain
requirements failed. The predeclared median control gates passed: C0/A0 CPU
−0.204%, wall −0.064%; A0/P CPU −0.520%, wall −0.345%.

Absolute median corpus CPU times were P 174.524 ms, A0 172.270 ms,
B0 170.400 ms, C0 173.017 ms. These are scoped component observations, not
whole-import timings or a qualified speedup claim.

The complete record is `component-1m-screen.json`, SHA
`12c5a6907079b795b23db9f28ca4c87e158e51b02951d9e69d05ca8a12ce1564`.
The independent arithmetic audit rederived all 10 paired metric comparisons,
40 stored numeric comparison values, eight arm medians and all six gate
booleans from the 32 observations. It also checked the schedule, complete
oracles, manifest and capacity-map binding. Its receipt is
`independent-sequence64-screen-audit.json`, SHA
`edc6c84cf89dd18d38d72e106c499d3094659c9d8d0894db0323e294d909d4b6`.

## Unchanged product and correctness identities

The runtime patch is
`ca81af91efc18fb31782ab085eecc593264af710292d9d79e3685dce102bc016`.
It changes only the private wasm32 sequence writer and uses the existing
sequence algorithm/FSE states. It does not change count matching, the global
bitstream type, generic FSE/HUF helpers, the decoder, level, dictionary,
block target or worker count. Successful bytes/sizes and return/error codes
must match; unused destination slack and bytes after an error are outside the
declared equivalence contract.

The exact product command omitted the diagnostic symbol-map flag. A0's loader
and WASM exactly reproduced checked-in P. C0 is an identity copy, not an
independent rebuild. P/A0/C0 WASM SHA is
`ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc`.
B0 is 433,771 bytes, 140 bytes larger, SHA
`b17fa89fd8b1b32281f987cd33bbdc5da868ac5e030feb5c47070a0891ec38bc`.
The exact-product build receipt is `product-result/manifest.json`, SHA
`8c5fabfe74e3e782231d70bd0eb00388e9ecd82c60535fa34509be7de87f15bf`.

Completed independent direct/SDK boundary probes, the 55 actual-product API
capacity cases, and earlier synthetic/dictionary-switch checks remain retained.
The corrected-corpus acquisition explicitly reused the previously passed
337 primitive, 340 sequence, 55 capacity and 79 synthetic cases; it did not
rerun or relabel them as newly executed tests. Only all 103 newly packed
canonical frames and their full envelopes/self/production decodes were newly
checked against unchanged P/A0/B0/C0.

All 103 frames succeeded per arm. Each arm produced 12,324,804 compressed bytes,
aggregate frame SHA
`457bec71b31b9971d02bcde1f70cc4bb3aea3dcf768518cb4dd031a6ca6dbd7a`
and envelope SHA
`f9bcbead26736ae31ae3776fb65618b457e8488e6e097b32451103d237e03747`.
The actual dictionary is 16,384 bytes, SHA
`f384a821c2f122bde518ee8a513ea76cbe9876c3534fc1fff4cacdf1ecc509cb`.

The corrected qualification is `production-corpus-result/manifest.json`, SHA
`b1c8a1db33ec9a724eb6f79350951eca287fb39f34bf0e94991be7d2cd39509e`.
Its research source manifest is
`a388fcf6636120618c3510f0aaa49229766db39ed4ebd40512b6681e44dd33de`.
Node was prospectively pinned to v24.22.3 and executable SHA
`acbe4b8d9153b841ed0697cbfc4f93e767386620edb745ab9358306c0a6f31aa`.

## Scope corrections and retained failures

Before any timing observation, an independent source audit found that the
original 31-block corpus used the standalone 4 MiB target rather than the
database's 1 MiB target. It also found that context assignment restarts at each
append group and that native output capacity follows each context's high-water
mark. The original 31-block sources, compiled artifacts and correctness results
were preserved under their actual scope. Its prepared timing cohort was never
executed.

The corrected 103-block corpus was independently reconstructed from the exact
surviving captured record stream. Every original group canonical byte stream
matched, no full hash-pair collision occurred, and the unchanged production
planner verified every block boundary. The preserved planner input and final
manifest differ only in the documented status/receipt fields. Final corpus
manifest SHA is
`5ff31df0d8c069c0da248198a399879524d5bc4dff3ab48d96c5227afa578de0`.

Earlier setup failures and their narrow repairs remain separate: the direct
probe's test-wrapper macro/linker setup and the SDK Python cache-file preflight.
The diagnostic builds and their corrected shift-opcode counting receipt are
also preserved. No compiler-only effect was attributed to this algorithm, and
no failed acquisition or measurement was silently replaced.

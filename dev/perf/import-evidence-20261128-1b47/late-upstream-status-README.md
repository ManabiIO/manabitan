# Final upstream and PR status

This is a later status appendix to the immutable experiment and validation
packets. It records repository state observed at 2026-11-28 10:02:39 UTC.
No new experiment, timing observation, or runtime validation was performed.

## Score change incorporated upstream

[PR #981](https://github.com/ManabiIO/manabitan/pull/981) merged at
2026-11-28 09:49:29 UTC as
`f28c2801fcfd9416f220b46b9cbafeee901c1cb2`, after this task's dedicated
correctness run. Its commit
`c5e7632b1e184dd5e7458fe9f7a48c54c7d9edca` records a cherry-pick from the
original score proposal `b15bad43acdfd54d541895cac1109c0e5ba51b2f`.
The resulting `ext/js/dictionary/term-record-opfs-store.js` Git blob is
`b17f72437f196aa1fd21b282c03f147aad7d633f`, identical to the proposal's file.

[PR #978](https://github.com/ManabiIO/manabitan/pull/978) was therefore closed
as superseded at 10:02:27 UTC. Its head remains
`dbaa4d72a5f6b4fcffeb92cefadb521e101df7df`; its branch, original body,
component measurements, negative browser observations, and validation evidence
remain available. GitHub correctly reports #978 as closed and unmerged:
the source entered develop through #981. This task did not perform that merge.

The measured gain remains approximately 1.57–1.60 ms per complete warm
validator pass over the captured JMdict field buffers. Neither the source
incorporation nor this status update changes the absence of a demonstrated
whole-import speedup in this task's score study.

## CRC remains a held draft

[PR #979](https://github.com/ManabiIO/manabitan/pull/979) remains open and
draft at head `961614e36859c529580fc034d6535ca89d119051`.
The comparison from the tested common baseline
`dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16` to the #981 merge has nine
changed files and does not touch any of this proposal's four product paths:
native parser source, native manifest, generated WASM, and CRC test.

The unchanged paths establish source identity only. The dedicated correctness
run [46128395334](https://github.com/ManabiIO/manabitan/actions/runs/46128395334)
tested the score and CRC heads on the dcfc baseline. It did not test the later
combined #981 runtime. Historical score and CRC performance observations remain
bound to `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
The CRC proposal has no new correctness, browser non-regression, complete-import
performance, or merge-readiness claim for the later upstream combination.
Its adverse VNDB browser timing and failed memory-coverage qualification
remain disclosed in the PR.

## Completed evidence and final disposition

The complete corrected compression results were published before this appendix
at immutable evidence commit
[`afb92e49321d176e1306e63accfed1d648d200ce`](https://github.com/ManabiIO/manabitan/commit/afb92e49321d176e1306e63accfed1d648d200ce).
That packet preserves all 52 reports and 547 memory scan rows from the two
fixed active-corpus cohorts, the validation data, independent audits, original
failures, and final decisions. Both timing cohorts failed the registered review
rule. No compression product PR was created.

All performance acquisition is complete. No JMdict whole-import speedup was
established by this task's experiments. The score source is incorporated
upstream; CRC remains a component-only review draft. All sealed evidence
archives are unchanged.

The adjacent [machine-readable status receipt](late-upstream-status-20261128-1b47.json)
records the observed source identities, PR heads, exact body readbacks, and
validation boundaries. Earlier packets describe their stated observation
times; references there to two held drafts are historical snapshots.

## References

- [Complete experiment index](README.md)
- [Score component evidence](score-restoration-README.md)
- [CRC component evidence](crc8_4-README.md)
- [Corrected compression results](corrected-compression-results-README.md)
- [Dedicated dcfc integration correctness](current-integration-correctness-README.md)

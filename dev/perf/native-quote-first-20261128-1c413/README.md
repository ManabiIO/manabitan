# Frozen quote-first native component screen

This is an independent prospective screen of one parser change against two
byte-identical baseline controls. It is based on develop
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. This research branch adds only this
kit and its workflow; it makes no product change. The earlier eight-arm screen
is a separate acquisition and is not modified by this kit.

## Frozen arms and mechanism

| Arm | Native parser                                         | Parser bytes | Change from baseline |
| --- | ----------------------------------------------------- | -----------: | -------------------: |
| A   | Baseline                                              |       67,659 |                    0 |
| B   | Quote-token dispatch before whitespace classification |       67,659 |                    0 |
| C   | Byte-identical baseline control                       |       67,659 |                    0 |

B moves the complete existing quote-token branch ahead of the whitespace branch
in `parse_composite_span_impl`. Both branch bodies are unchanged. This removes
the initial whitespace predicate from quote-token dispatch without changing
required fields, accepted JSON grammar, hint updates, nesting, buffer ownership
or storage formats. The rebuilt binary differs from baseline at the same size.
No other native candidate is combined with it.

A and C instantiate independent modules and heaps from the exact same bytes.
All arms use the unchanged baseline JavaScript parser and lookup preparation.
`plan.json` binds the source patch, C, WASM, manifest, runtime sources, fixture and
grouping helper. `prepare.mjs` rebuilds baseline and candidate with the unchanged
manifest arguments and exact Clang/LLD 21.1.8. Every rebuilt module must equal its
stored bytes; the canonical scanner must remain unchanged. The runner checks
source, kit, fixture and module identities again after acquisition.

## Input and production policy

The timed fixture is the locked JMdict 2026-11-22 archive: 15,645,766 bytes,
53 term banks and 528,299 rows, SHA-256
`3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`.
The runner checks archive size and SHA-256, ZIP-entry CRCs, index title/revision,
bank numbering and total rows, and records every bank's hash and group.

All archive filenames are inspected with the production image-type helper.
This archive has no images, so `mediaHintFastScan` is false. The unchanged lazy
byte-balancing algorithm uses an explicit three-worker/four-groups policy and a
24 MiB target, giving twelve groups. Those groups execute serially in each arm.
No browser worker concurrency is simulated.

## Fixed acquisition

The single hosted job pins Ubuntu 26.04 and Node 24.22.3. Before starting Node,
the affinity helper selects the second CPU in the initial allowed affinity, or
the sole CPU if only one exists. Initial and active affinity are recorded.

Each arm gets two full-corpus untimed warmups in orders `ABC` and `CBA`.
The twelve measured blocks are committed explicitly:

```text
ABC ACB BAC BCA CAB CBA ABC ACB BAC BCA CAB CBA
```

All six permutations occur twice. Each arm occurs four times in every position;
each directed within-block adjacency occurs four times. There are twelve
observations per arm and 36 observations in total. Between-block transitions and
the deterministic warmup order are not claimed to be balanced. Their exact
sequence remains visible in the plan and raw receipts. Explicit garbage
collection occurs immediately before every pass, outside native timers.

The primary metric is current-thread CPU milliseconds spent inside
`parse_and_encode_term_bank_token_binary_dedup`. Its wall time, all selected
native export timings and the JavaScript parser/lookup API wall are retained as
diagnostics. ZIP inflation, CRC validation, module compilation, explicit GC and
full-output hashing are outside the native-call timers. The API wall diagnostic
also excludes output hashing.

Every warmup and observation verifies the framed full-output SHA-256 against
baseline A. It covers numeric columns, dedup IDs, interned keys, exact prepared
lookup bytes and route filters, canonical content rows and both content hashes,
plus media fields and lazy byte views. Row counts and parser fallback behavior
must match. Nothing is sampled from the semantic output.

All B/A, B/C and C/A paired changes, medians, equal-work ratios and faster-pair
counts are reported. No automatic winner is chosen. Every observation and
failure is preserved: no outlier deletion, changed warmups, adaptive extra blocks,
control-based resampling or reruns. An incomplete acquisition remains incomplete.
The workflow ignores rerun attempts; a repaired protocol would be a separate
reviewed acquisition.

## Correctness and local portability

`prevalidation.json` binds the earlier source-specific correctness evidence.
All 937 locked banks and 7,613,164 rows across JMdict, Jitendex and VNDB matched
baseline, including media projections. The wider check enabled media hints and
used two-bank groups; it is correctness evidence rather than the timed policy.
The same 28 VNDB fused fallbacks were retained on both arms. All 1,087 focused
tests passed, including 25 added quote/whitespace/state/truncation boundary cases.

A separate untimed A/B stock-policy pass already matched the same full JMdict
digest with twelve groups, media hints false, zero fallbacks and zero segments.
To verify this three-arm kit without acquiring any timing:

```sh
node dev/perf/native-quote-first-20261128-1c413/prepare.mjs builds/perf/quote-first-local
node --expose-gc dev/perf/native-quote-first-20261128-1c413/run.mjs \
  builds/perf/quote-first-local /absolute/path/JMdict.zip --verify-only
```

The explicitly untimed mode runs one full pass per arm, records no CPU or wall
timings, and cannot produce timing contrasts. Hosted acquisition uses only the
committed measured protocol and preserves every observation, source stage,
rebuild receipt and failure under its exact acquisition commit.

## Interpretation boundary

This is a resident serial native component study. It does not measure full ZIP
import, worker overlap, scheduling, compression, persistence, image import or
browser UI work. A promising signal can nominate an independently acquired
complete-browser experiment. These measurements alone cannot qualify an
optimization PR or establish faster complete dictionary imports.

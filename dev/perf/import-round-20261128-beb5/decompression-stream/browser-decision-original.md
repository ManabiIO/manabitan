# JMdict native gzip decompression component: reject both variants

The frozen fresh-Chromium campaign completed all conformance checks and all 36
prescribed measured arms. Both gzip-framed DecompressionStream variants are
substantially slower than the existing production libdeflate-WASM inflation and
CRC path. Neither warrants a product hook, a resource-bound redesign, another
slice-size search, or a product PR on this evidence.

## Exact experiment

- Run: [46108692453](https://github.com/ManabiIO/manabitan/actions/runs/46108692453).
- Research source: `70f3cda48ba768979a117f58a3901334d402f700`, tree
  `17ff7a2b17c9130f43c347791567a6a9b0e631a0`, sole parent and runtime baseline
  `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
- No product-source change; only the registered research helper/workflow files.
- Browser: full Chromium `153.0.8010.12`, revision `1243`, executable SHA-256
  `8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e`.
- Host: Intel Xeon 6975P-C, four logical processors, Node 22.22.0.
- Input: every locked JMdict term bank, 53 banks / 12 unchanged groups / source
  containing 528,299 rows; 15,632,849 compressed and 171,617,523 decoded bytes.
- Each arm uses a fresh full browser process/profile and three fresh parser
  workers. The groups run serially round-robin, four per worker, with no warmups.
  This measures summed owning-phase work, not concurrent complete-import latency.

## Results

Ratios are candidate divided by baseline; values above 1 are slower. Paired
medians and equal-work sums include every prescribed pair without trimming,
control subtraction, retry, or pooling with another host.

| Fixed arm | Median work ratio | Equal-work ratio | Median paired work difference | Init-inclusive ratio | Faster pairs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Gzip, 64 KiB input slices | 1.4237 | 1.4229 | +75.795 ms | 1.2283 | 0 / 6 |
| Gzip, 1 KiB input slices | 2.4506 | 2.4459 | +258.973 ms | 1.9268 | 0 / 6 |
| Native / identical native control | 1.0239 | 1.0114 | +4.197 ms | 0.9927 | 2 / 6 by work |

The 64 KiB candidate's work ratios range from 1.3961 to 1.4541; the 1 KiB
candidate ranges from 2.3568 to 2.5190. All six pairs also lose when including
initialization. Both the first group per worker and subsequent groups are
slower: median cold/later work ratios are 1.2071/1.5340 for 64 KiB and
1.9954/2.6710 for 1 KiB.

The clock includes native allocations/input copies or DS framing/input writes
and decoded output copies, inflation, CRC, exact decoded-size checks and wrapper
checks. Module fetch/hash/compilation and three-worker initialization are
included in the separate initialization wall time; the total is that wall time
plus summed serial group work. Fixture reads and equivalent post-timer complete
byte oracles are excluded. No parsing, compression, persistence, media import,
first-hover work, or actual importer scheduling is measured.

Each DS arm copied all 171,617,523 decoded bytes into the corresponding native
destination. The 64 KiB arm made 374 framed input writes and yielded 2,756 output
chunks; the 1 KiB arm made 15,398 writes and yielded 15,293 chunks. These counts
explain the distinct exercised paths, but this study does not separately assign
the regression to browser decoding, stream scheduling, or copy cost. The full
cost is the relevant result.

## Conformance and independent audit

All 14 standalone format checks and 157 source cases passed. Each source case
checks both fixed-slice helpers, including all 12 hidden-second-gzip-member
variants and the trailing-zero/trailing-garbage cases. Complete stream acceptance,
decoded length and byte digest match the existing native path. On rejected
sources, the separate original-native replay matches the registered error
ordering and messages; direct DS exceptions are not claimed to have native error
classes. Node's separately
retained concatenating-gzip failures remain unsupported conformance, not a
browser result or a performance claim.

The independent audit verifies 329 source-file hashes, exact source/tree and
browser identities, locked corpus/grouping, the complete 36-arm schedule,
171 conformance records, every completed journal record, full output digests,
allocation/copy counters, all timing sums, and all reported pair summaries.
There were no missing arms or recorded failures. The original artifact ZIP is
retained and matches GitHub's byte size and SHA-256:

- Artifact ID: `15251391461`; 220,443 bytes.
- SHA-256: `b49c57e37e181d19541de6e9da21a30e267363df928dd6b99d00bca345c15591`.
- `artifact.zip`, `artifact-receipt.json`, complete `job.log`, extracted
  `evidence/`, and `independent-audit.json` are retained beside this decision.
- Audit script: `../../audit-decompression-stream-browser.py`.

The fixed input slices and JavaScript overflow check still do not reproduce the
existing hard declared-output allocation bound, nor guarantee process residency.
That separate resource limitation remains documented; favorable ordinary-input
conformance alone would not have resolved it. The decisive negative timing means
there is no reason to engineer around that limitation for this proposal.

The ordinary JMdict profile's 459.3 ms `parserSourceInflateMs` already contains
immediate CRC and wrapper checking. CRC sample attribution must not be added to
it again. Nor should the lower serial component timings here be compared with
that concurrently scheduled ordinary import as though they were an A/B result.

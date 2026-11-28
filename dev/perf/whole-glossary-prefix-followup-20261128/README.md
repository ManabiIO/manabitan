# Recent-first glossary witness follow-up

This is one separately registered component follow-up to the frozen prefix-first
experiment. It compares baseline develop
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` with runtime commit
`1a935bddf29c4d87606d2facd4b168af7e1a40f1`, whose exact tree is
`99563392c65e4b1655de3e504982b9a0fc496c13`. It is not a qualified browser import
improvement and does not justify a product pull request by itself.

## Single follow-up mechanism

The original candidate probes a bank-local, 256-slot table routed by the first
64 bytes of a glossary before the existing recent-row probes. Its JMdict
component result was favorable, but Jitendex, VNDB and enabled negative controls
showed overhead. That frozen study is preserved at
`47f3c3262931d0a92728c72fcd5cfb9b0ccc49a0`; its hosts and observations are not
pooled with this follow-up.

This candidate first performs the unchanged recent-row search. Only a miss can
reach the prefix table. Prefix probing additionally requires the immediately
preceding completed row to be in the same logical bank and have a glossary
length of at least the existing `GLOSSARY_PREFIX_BYTES = 64`. This is an
admission hint, never a validation authority. Current-bank source bounds and
complete equality to the previously validated span remain required before
reusing its end or hints. No new threshold or tuning parameter is introduced.

The per-row pending slot is reset before parsing. A recent hit neither hashes
the current prefix nor replaces an older table representative. The first long
row in a bank is unseeded; a second consecutive long miss can seed the table.
Alternating long and short rows can lose prefix coverage. There is no added
post-parse hashing or state to recover it. Existing cross-bank recent-row
behavior, table reset boundaries, grammar fallback, disabled flag semantics,
CRC checks and the older-witness quick-signature repair remain unchanged.

The pinned module is 68,394 bytes, 109 bytes larger than the prefix-first module
and 735 bytes larger than baseline. Additional call-local native stack state
remains 1,028 bytes. Persisted formats, exports and parser grouping are unchanged.

## Correctness and untimed admission before registration

The unchanged differential oracle passed 242 comparisons: 175 exact successful
outputs and 67 exact errors. Its cases cover disabled reuse, logical-bank and
63/64/65-byte boundaries, collisions, malformed tails, media and normalization
hints, nonlocal witnesses, ownership, and actual deferred CRC success/failure.
An independent review of the narrow follow-up diff found no remaining concrete
invariant defect; that review did not claim an independent oracle execution.

The untimed JMdict replay covered all 12 groups and 528,299 rows. Baseline,
prefix-first and recent-first outputs, semantic key plans and actual numeric
column types were identical. Their glossary witness counts were respectively
54,641, 200,168 and 143,409. Recent-first retains 88,768 additional witnesses,
61.0% of the prefix-first increment. Full-content reuse was 154,416, 159,158 and
158,576. Native heap capacity was identical and no fused fallback occurred.

All four unchanged 10,000-row synthetic cases also matched exactly. The three
negative cases had no glossary witnesses. The nonlocal positive had 9,966
prefix-first and 9,964 recent-first witnesses. The short-only fixture contains
11-byte glossaries, so the prior-length admission never permits a prefix probe.
These are correctness and coverage observations, not timing evidence.

## Frozen timing protocol

`registration.json` binds the runtime commit/tree, exact source/module hashes,
every study file, this workflow, and all prescribed counts before execution.
The timed runner, oracle and synthetic fixture helper are byte-identical to the
corrected prefix-first study. The verifier enforces that the research checkout
has no runtime difference from the registered candidate, then rebuilds baseline
and candidate release packages independently. The only permitted package member
differences are the native parser C source and parser WASM. Dependencies are
staged with hardlinks rather than a cross-checkout `node_modules` symlink.

Each dictionary runs on a separate Ubuntu 26.04 job with Node 22 and the pinned
Clang/LLD 21.1.8 native build. Every existing production-policy group for three
parser workers is replayed sequentially. Each group has three retained
verification observations, then six alternating treatment pairs and six
alternating identical-baseline control pairs. There is no concurrent worker
execution in this component experiment. Each arm owns its own native instance.

The timer includes complete native compressed-payload inflation and CRC,
validation and canonical content parsing, lookup construction, and a private
owned output copy. It excludes archive directory/payload reads, WASM compilation,
result hashing, worker transport, shared-content and image projection, native
escaped-key worker options, lookup route construction, compression/storage/media
import, browser scheduling and first hover. In particular, VNDB's synchronous
options and fallback/score-type counts are not production worker activation
counts. Score and sequence arrays are compared with their original types;
there is no coercion to expand the native path.

Each corpus also runs the unchanged first-group, flag-disabled screen with
three treatment and three identical-code pairs. The JMdict job runs all four
enabled synthetic cases with six treatment and six identical-code pairs each:
unique prefixes, common prefixes/tails with unique middles, short unique
glossaries, and the nonlocal positive using 17 distinct prefix slots. None of
these controls is dropped or replaced based on its result.

Every completed arm is appended immediately to an observation journal before
comparison checks. Reports retain caught failures and their context; CI retains
logs and artifacts even if a step fails. Verification invocations are excluded
from warm summaries. The first invocation is marked, but shares the Node VM
with other arms and is not an independent cold-start experiment. No trimming,
replacement runs, control subtraction or pooling with prefix-first hosts is
authorized. Group-summed work is not complete import wall time.

## Reproduce

Use a separate baseline checkout and matching source-bound modules in each
checkout's `ext/lib`, then run:

```sh
node --expose-gc dev/perf/whole-glossary-prefix-followup-20261128/replay.mjs \
  --baseline-root /path/to/unchanged-develop \
  --candidate-root /path/to/recent-first-candidate \
  --cache-dir /path/to/locked-dictionaries \
  --parser-workers 3 --pairs 6 --out /fresh/path/screen.json \
  jmdict jitendex vndb
```

The research workflow runs the fixed controls and strict identity checks as
well. A subsequent, separately authorized browser qualification would be needed
before claiming an import improvement or considering a pull request.

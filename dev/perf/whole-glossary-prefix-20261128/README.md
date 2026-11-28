# Whole-glossary prefix witness experiment

This is a component experiment against develop
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. It is not a qualified browser import
improvement. The runtime diff changes only the existing native parser and its
source-bound generated artifact.

## Mechanism and proof

The current parser can reuse a validated glossary from an admitted recent row,
but it otherwise validates a repeated glossary before content deduplication.
The candidate adds one 256-slot, call-local table of prior row indexes. At a
composite glossary start with at least 64 source bytes remaining in the current
logical bank, a fixed 64-byte xxHash32 routes to one candidate. The actual
current glossary length is still unknown at this point.

Only completed valid glossaries of at least 64 bytes enter the table. A table
candidate must fit entirely inside the current logical bank, pass a rejecting
last-eight-byte check, and then match every byte of its full validated span.
Only that full equality permits reuse of its end, media hint and normalization
hints. Hash or sample equality never permits reuse by itself. The existing
recent-row search and grammar parser remain fallbacks.

The table is cleared at every logical bank transition and does not survive a
native invocation or heap reset. The current `experimentalValidatedGlossaryReuse`
switch still disables all validated-glossary reuse. The new table is not
consulted on that path. Because a prefix witness can be older than the existing
four-row signature ring, the candidate recomputes the current quick signature
for such a witness instead of copying an overwritten ring slot.

The additional native stack state is 1,028 bytes. The pinned parser module grows
from 67,659 to 68,285 bytes. No persisted format or exported native signature
changes.

## Historical negative control

PR #831 tried prefix routing plus full equality for nested flat `data`/`style`
objects. It reused substantial raw bytes but regressed complete imports. This
experiment instead performs one probe per row and can skip validation of an
entire glossary. That is a different scope, not evidence of a gain. Timing must
include prefix hashing, misses, full comparisons, remaining parser work,
inflation, CRC, lookup construction and output ownership.

## Reproduce

Use the repository's pinned Clang and LLD 21.1.8 toolchain and Node 22.22.0:

```sh
node --input-type=module -e 'import {main} from "./dev/bin/build-dictionary-wasm.js"; main(["--check"])'
node --input-type=module -e 'import {copyDictionaryWasm} from "./dev/dictionary-wasm.js"; copyDictionaryWasm("ext/lib")'
node --expose-gc dev/perf/whole-glossary-prefix-20261128/replay.mjs \
  --baseline-root /path/to/unchanged-develop \
  --candidate-root /path/to/candidate \
  --cache-dir /path/to/locked-dictionaries \
  --parser-workers 3 --pairs 6 --out /fresh/path/screen.json \
  jmdict jitendex vndb
```

Each source root must have its own matching source-bound native artifact in
`ext/lib`; the JavaScript parser and lookup sources must match exactly. The
runner verifies the locked archive sizes and SHA-256 hashes, compiles independent
baseline/candidate/control instances, and executes the existing production
grouping policy sequentially. The control uses the identical baseline source.

For every group, the runner first retains three verification observations and
then alternates six treatment pairs and six control pairs. It preserves every
observation. The first invocation of each instance is marked separately. The
warm timer includes native inflation and CRC validation, native and fallback
parsing, lookup construction and a complete private owned output copy. It does
not reproduce worker shared-content transport, image projection or lookup route
construction. Archive I/O,
compilation and result hashing are outside that timer. Complete output digests
include canonical content, all metadata/IDs, media rows, every lookup byte,
semantic key-plan columns, and the actual score/sequence array type and bytes.
No numeric column is coerced to make the fast path eligible.

The research workflow rebuilds both native modules with the pinned toolchain,
builds both Chrome release packages and checks every package entry. Only the C
parser source and its WASM member may differ. It also runs the independent
242-case differential, including a production-gated deferred CRC fixture and
an invalid-signature case, before corpus timing. A separate
`--disable-glossary-reuse --max-groups 1 --pairs 3` replay measures source
overhead with reuse disabled and requires zero reuse witnesses in every arm.
The JMdict job additionally runs `--negative-fixtures --pairs 6`: fixed two-bank,
10,000-row sources with unique prefixes, identical prefixes and tails but unique
middles, short unique glossaries, and a nonlocal positive control using 17
distinct prefix slots. These fixtures use enabled reuse and the same complete
compressed-source timer. Their specifications and source hashes are retained;
they do not represent a dictionary or the production grouping policy.

An append-only journal retains every completed arm immediately, including the
current group if the process is interrupted. The JSON report also retains error
context when an exception can be caught.

`--max-groups 1 --pairs 1` is a bounded runner smoke check, not a corpus result.
This replay does not include browser scheduling, compression, storage, media
payload import or first hover. Only a subsequent strict browser campaign can
establish whether this component change is worth a pull request.

# Native media-presence projection, 2026-11-25

The fused term-bank parser already computes a conservative media hint for every
row. This change ORs those existing hints into one optional native output word.
JavaScript can then omit the media-only row projection loop and its canonical
content tracking array when every hint is zero.

The result is published only after every bank has parsed successfully. JavaScript
initializes the output word to a conservative nonzero value, so an older WASM
module that ignores the appended argument retains the existing scan. Older
callers can omit the pointer; native code never writes through a zero pointer.
Disabled hint detection and all nonfused or rejected fused parses also keep the
existing projection behavior. The row hints, dictionary validation, content
encoding, lookup representation, and media projection rules are unchanged.

## Full-corpus equality and eliminated work

The checks use the pinned archives in `test/perf/dictionaries.lock.json`, real
compressed ZIP payloads, and the production parser worker, including native CRC
and glossary-shape validation. The existing lazy source partition policy uses a
24 MiB target and at least three groups per configured parser worker. The
`groupingWorkerCount` values below exercise that policy; execution uses one worker
at a time and compares baseline and candidate separately to bound memory.

| Corpus   | Grouping workers | Groups | Term rows | Groups with scan omitted | JS row visits omitted | Temporary tracking bytes omitted |
| -------- | ---------------: | -----: | --------: | -----------------------: | --------------------: | -------------------------------: |
| JMdict   |                2 |      7 |   528,299 |                        2 |               148,299 |                          100,062 |
| JMdict   |                5 |     15 |   528,299 |                        7 |               248,299 |                          163,847 |
| Jitendex |                5 |     22 |   436,555 |                        1 |                22,555 |                           19,423 |
| VNDB     |                5 |    170 | 6,648,310 |                        0 |                     0 |                                0 |

The omitted JMdict visits are 28.1% and 47.0% of its media-hint projection loop,
depending on the existing worker policy. These counts do not describe the other
native or JavaScript row processing done during an import. The temporary byte
counts sum the eliminated `Uint8Array(uniqueContentCount)` allocations; they are
not measurements of peak process memory.

JMdict has no image paths but retains 17 projected representatives with
conservative media hints. Every group containing one of those representatives
keeps its existing scan and exact projected rows. Jitendex retains 339
representative hint rows, including 324 projected to image paths, and
236 unique image paths. VNDB
retains 146,725 references across source groups and 146,570 unique image paths;
repeated references crossing group boundaries are preserved. VNDB has the same
26 fused fallbacks in both arms. JMdict and Jitendex have none.

All compared groups have identical hashes for the complete output payload:
term columns, canonical content bytes, content deduplication metadata, projected
media rows and paths, and prepared lookup bytes and routes. Runtime timing fields
are excluded from hashing. Every group's native heap size also matches between
baseline and candidate. The checked-in receipts retain each group's source-bank
bounds, row counts, output hash, fallback count, skipped-row count, and heap size.

| Receipt                                   | Canonical content bytes compared | Aggregate equal-output SHA-256                                     |
| ----------------------------------------- | -------------------------------: | ------------------------------------------------------------------ |
| [JMdict, 2 workers](jmdict-2workers.json) |                      101,057,774 | `12967fe8f198d77002aba780bde808a256027886939ce4cec368309ea893b59d` |
| [JMdict, 5 workers](jmdict-5workers.json) |                      101,194,632 | `36c62024970697cd4929dd00b3939ed14e2f97affed9a0e441979619164abf45` |
| [Jitendex](jitendex-5workers.json)        |                      389,707,807 | `d89c75314781b136c802a76ffd1e906eb119c6f6638116cc6855d4a2e4fe5a37` |
| [VNDB](vndb-5workers.json)                |                       91,670,244 | `b0125d82665ed7ea2d5f86add4da84bfc8f57c329f3028c0da166b3ed4eb4a0c` |

Different JMdict partitioning produces different amounts of content because
content is deduplicated within a group. Equality is checked between the two arms
of each partitioning case, not between different grouping policies.

## Source and fixture identity

The baseline is `develop` at `7d1643e61`. The implementation tree was published in
PR #902 as `c721aaf38baf447893e0d36e112183566eaa856a`. The pinned LLVM and linker
21.1.8 rebuild increases the parser WASM from 63,004 to 63,044 bytes.

| Artifact              | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Baseline parser WASM  | `913da48a70eebfe8dfe8d96b60064cf0d472db3eccb2c12771686696cb78005c` |
| Candidate parser WASM | `cea3a1cc553e6a323ed7cf9f6e0ce5031013b073957d75063430fe4effbba3cb` |
| JMdict 2026-11-22     | `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f` |
| Jitendex 2026.10.03.0 | `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356` |
| VNDB 1.0.0            | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` |

The receipts were collected with Node 24.22.3. They establish output equality and
the amount of work omitted. They do not measure complete-import elapsed time,
browser storage writes, compression, or peak browser memory. Local Chromium
startup is blocked by `socket() Operation not permitted`; the hosted correctness
verification below supplies browser coverage. No complete-import speedup is
claimed here.

## Focused regression coverage

`test/term-bank-media-presence.test.js` adds 15 cases covering media-free groups,
multiple output chunks, exact column and lookup parity, mixed banks, nested and
escaped media markers, duplicate glossary reuse, disabled hints, older ABI
behavior, numeric fallback, and malformed later banks. It verifies conservative
output initialization and that failed parses do not publish an absence result.

The focused run of this suite together with `term-bank-wasm-parser.test.js`,
`term-bank-format3-row.test.js`, and `term-bank-experiments.test.js` passed all 393
tests. ESLint passed for the modified JavaScript and new test. The checked-in
WASM and manifest were regenerated with the pinned toolchain.

## Reproduce the corpus checks

Create a baseline checkout at `7d1643e61`, and run `npm ci` and
`npm run build:libs` in both checkouts. Supply the downloaded archives named in
the fixture lock; the runner verifies the entire archive SHA-256 before parsing.

```sh
node --expose-gc dev/perf/import-media-presence-parity.js \
  --dictionary jmdict \
  --baseline-root ../manabitan-media-baseline \
  --candidate-root . \
  --fixture-cache /path/to/dictionaries \
  --workers 2 \
  --output /tmp/jmdict-2workers-parity.json
```

Repeat with `jmdict` and 5 workers, `jitendex` and 5 workers, and `vndb` and 5
workers. The worker count controls source grouping; each arm still executes one
production worker sequentially. `--fixture` accepts an individual archive in
place of `--fixture-cache`. The runner exits with an error on a mismatched
archive, term-row total, group output digest, or compared output property.
New runs also record source commits, source-file hashes, and runner/bridge hashes;
the checked-in receipts above retain the original acquired results.

## Hosted verification and remaining gates

[The hosted verification for the source-identical implementation commit](https://github.com/ManabiIO/manabitan/actions/runs/45642244560)
passed using Chromium 153.0.8010.12 and the `chrome-dev` package. It reported 89
phases, `status=success`, `skippedVerification=false`, and OPFS `sahpool`
installed. Firefox verification from the same run also passed with 63 phases,
`status=success`, `skippedVerification=false`, and an empty skip reason. The
pinned native rebuild and package build checks also passed.

- Chromium verification artifact SHA-256: `3bd3857328393f0b62015ad766103f20413bb4b2aebe351ea9193a6ed5480e4c`
- Firefox verification artifact SHA-256: `bb3db7793094e42aa8c64f930c5b82709596456889dc37a3a77203849351094d`
- Package SHA-256: `959f3b3dd0c55a4b2968f904ed9e6f35c3cf98706ab0d494eb05317993d165f2`

The CI unit gate passed 14,566 tests across 647 files, with 47 tests skipped,
in 148.32 seconds. The main, test, and dev TypeScript CI gates also passed.
The local test TypeScript process had been terminated with exit 137 before
producing diagnostics; the isolated CI result supplies that validation.

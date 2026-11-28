# Record-score cache investigation

This bundle records a component optimization against frozen develop commit
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. It does **not** establish an
end-to-end browser import speedup. Hosted import qualification is a separate
gate; its timing and restart/content validation must be reported independently.

The final local candidate is `241f96bf759b36704ad34e60aa45f204c304bb85`.
Its `ext/js/dictionary/term-record-opfs-store.js` SHA-256 is
`65e3bc1c98b45175d350d79a282b6445225339fafbb9024a7f02f0379222f3c9`.
`source-bindings.json` binds every committed variant and earlier uncommitted
prototype to its source hash and a patch against the frozen baseline.

## Published source and qualification

The exact final runtime is published at `02bfdeefe6d032a8598a68c196a5ccd949c5ae5d`. The later diagnostic-only commit `9f62612a9c1997b850e40abcdf9390ee565badf5` preserves those runtime bytes. [Final-candidate browser qualification](https://github.com/ManabiIO/manabitan/actions/runs/46103360828) and its [separate candidate profile](https://github.com/ManabiIO/manabitan/actions/runs/46103981495) were pending when this component evidence was archived. The [initial V1 qualification](https://github.com/ManabiIO/manabitan/actions/runs/46102526376) is distinct and must not be attributed to V3.

`evidence.tar.gz` preserves every listed raw observation, failed attempt, source binding, patch, reproduction script, and validation log. Extract it to a separate directory to inspect its original README and `inventory.json`; `files.sha256.json.txt` verifies the archive and all members. Scripts inside the archive are historical acquisition inputs, not active product tooling. The large source dictionaries and input captures are regenerated from the pinned fixtures as described below.

## Change and boundaries

JMdict contains many repeated scores outside the existing direct table's
`[-256,255]` range. V1 used a bounded 512-slot cache plus the existing complete
score-to-ID map for collisions. It retained first-use score IDs, exact emitted
bytes, reference validation and the established legacy-field fallback. The
cache is permitted only after the existing factory-origin proof establishes
private, ordinary Int32 score columns and stable resolved references.

V2 retained the direct table inside the new helper. V3 instead probes at most
32 private scores and selects the V1 helper only if that prefix contains a
score outside the direct table. A miss simply keeps the original encoder;
later outside-range scores are still encoded correctly. Both 32- and 64-score
probes select all 12 actual JMdict groups. Their first qualifying scores occur
at positions 0–6. Neither Jitendex nor VNDB selects the cache on these locked
corpora. This is an optimization heuristic, not a promise about every future
dictionary: one early score outside the table can select the cache in a
mostly-low group.

Selected V3 calls use 3 KiB of typed cache scratch instead of the old 1 KiB
inline array, and their Map can retain up to 512 additional small-score keys.
No cache survives an encoder invocation. Unselected groups retain the old
allocations and loop. Shared, accessor-backed, proxied and otherwise unproved
inputs retain the original path.

## Retained measurements

All percentages below compare paired arms within one cohort. Negative is
faster. Raw milliseconds should not be compared across cohorts, especially
across the executor restart and Node versions.

| Variant       | JMdict warm paired median / aggregate | JMdict cold paired median / aggregate | Jitendex streamed median / aggregate | VNDB streamed median / aggregate |
| ------------- | ------------------------------------- | ------------------------------------- | ------------------------------------ | -------------------------------- |
| V1 `92eb1e7e` | −46.44% / −47.50%                     | −34.31% / −34.30%                     | +3.24% / +24.40%                     | +1.77% / −0.76%                  |
| V2 `42cc3bcb` | −28.38% / −34.78%                     | −17.35% / −22.78%                     | +4.20% / +2.36%                      | −0.24% / −2.41%                  |
| V3 `241f96bf` | −44.62% / −41.13%                     | −31.95% / −29.59%                     | +3.90% / +3.78%                      | +1.84% / +4.15%                  |

These three tables' cohorts use Node 24.22.3. Warm JMdict measures only
`_encodeArtifactRecordFields`: 20 alternating AB/BA pairs, each arm executing
12 full 528,299-row encodes per pair after one untimed parity pass and 10
warmup encodes. Input collection,
source reads, parsing, compression, storage and startup are outside that timer.
The cold cohort uses 24 pairs of fresh Node processes, with captured input
loading and module setup outside the timer; the first field encoding and its
JIT work are inside it. V3 won 21 of 24 cold pairs. Every arm's emitted field
bytes matched. CPU-time observations are retained where collected.

Jitendex/VNDB are streamed, bounded-memory screens: four alternating pairs per
production group and three encodes per timed arm after two warmups per arm.
There are 22 Jitendex groups / 88 pairs and 170 VNDB groups / 680 pairs.
Parser workers can overlap these callbacks. The small positive V3 deltas are
retained, not declared neutral or attributed conclusively to noise. They amount
to approximately 0.28 ms per Jitendex field pass and 4.03 ms per VNDB field
pass in these cohorts. Hosted whole-import evidence must decide whether this
tradeoff is acceptable.

### Earlier attempts and failures

- Hoisting resolved references alone did not produce a useful gain. Its source
  patch and warm/cold observations are retained under `record-direct-branch`.
- The first direct-cache prototype and potentially contended observations are
  retained under `direct-cache`. The initial cohort overlapped dependency
  movement; it was screening evidence only.
- The later Node 22.23.5 prototype cold cohort retained an unexplained
  approximately 845 ms candidate observation. Its paired median was −8.48%,
  but aggregate work was **+16.26%**. No observation was excluded. This source
  predates the final extracted helper and is bound separately by SHA-256.
- The old JMdict input-capture script was also tried on Jitendex and the process
  exited 137 before completion. Its media projection settings did not match
  the current production threshold; there is no complete result to interpret.
  Use that script only for the documented JMdict capture.
- The first VNDB replay stopped at planner preflight because a metadata-only
  dense ZIP catalog lacked `getData`. The repaired adapter calls the actual
  production archive catalog. All subsequent full VNDB parity checks passed.
- An executor reset temporarily removed `/tmp` dependencies and the cached
  Node executable. Setup failures and later killed lint/type-check attempts
  are kept in `validation/`. A SIGKILL is not treated as a passing gate, and
  its exact cause was not established from the available logs.

## Correctness evidence

The three full field replays use the actual source planner/native parser and
record/index encoders, but construct deterministic resolved content spans at
synthetic raw offsets. They do not prove physical compressed OPFS bytes.
All V1/V2/V3 field replays matched the frozen baseline exactly:

| Corpus   |      Rows | Groups | SHA-256 of lookup payloads plus record fields                      |
| -------- | --------: | -----: | ------------------------------------------------------------------ |
| JMdict   |   528,299 |     12 | `0d1fed2902f52de7097035ea864d72f8c759f8f06f7e742b9e2549dbf8865efd` |
| Jitendex |   436,555 |     22 | `26bdae49a35c014df04c109fc1f8ada4d8897872998871c9b7d16efa4e99e778` |
| VNDB     | 6,648,310 |    170 | `4f4fc02154520a2bb10d2cb3ed248a1bf7a7ea95a885348a1106bd51db3a0c29` |

The stronger V3 JMdict route check uses **original live parser columns**, the
actual `DictionaryDatabase` deduplication/resolved-reference factory and the
unmodified candidate module, before any capture serialization. Diagnostic
Node 22.22.0 precise coverage records 12 field-encoder calls, 12 prefix probes
and 12 cache-helper calls. Every score view is a builtin Int32Array over a
private ArrayBuffer. The receipt preserves reference shapes and score prefixes.

A related research adapter had used the invented dictionary name
`raw-token-v6`, suppressing cross-group matches. The corrected adapter imports
production `RAW_TERM_CONTENT_TOKEN_DICT_NAME` (`raw-v6`) and verifies 362,032
pending contents and 3,998 persisted matches. The corrected baseline and V3
lookup, field and checksum-envelope frames match exactly; their combined
payload/field SHA-256 is
`63c78b28234045da6d189f3cc65c430b7a53529636f916da7aba485916ff1b87`.
Persistence is still an explicit in-memory raw-byte adapter with sequential
logical offsets, not physical compressed OPFS or browser output. This repair
does not change the separately scoped synthetic-field replays.

V3's focused seven-file regression suite passed 306 tests. It includes signed
cache collisions, Int32 extremes, first-use score order, table/length fallback,
invalid references before and after fallback, hostile/shared/accessor inputs,
late outside-range scores and eligibility changes between invocations.
Runtime and test ESLint, and main TypeScript validation, passed under Node
22.22.0. Test TypeScript attempts at 1,024 MiB and 768 MiB heap limits were
killed without diagnostics; that gate remains uncompleted locally.

The full unit run reported 661 passing files / 15,010 passing tests, two
compiler-setup failures and six unexpected worker exits. All six interrupted
files passed in the targeted eight-file retry (315 tests), and the remaining
two compiler suites subsequently passed (21 tests) after repairing the local
toolchain PATH. Thus all 669 unit files completed successfully across these
runs; there was no single clean full-suite run, and the test counts must not
be added because interrupted files may have completed some cases already.
The original failures, Vitest cache identifying the interrupted files and all
retries are retained. No product changes were needed to make the retries pass.

The all-target dry build passed after replacing this worktree's generated
`ext/lib` symlink with a real generated directory. The compiler retry used
`MANABITAN_CLANG=/tmp/manabitan-llvm21-0119/usr/lib/llvm-21/bin/clang`,
`MANABITAN_WASM_LD=/tmp/manabitan-llvm21-0119/usr/bin/wasm-ld-21`,
`LD_LIBRARY_PATH=/tmp/manabitan-llvm21-0119/usr/lib/x86_64-linux-gnu` and
prepended `/tmp/manabitan-llvm21-0119/usr/bin` to PATH so Debian clang could
find its `wasm-ld-21` subprocess. Consult `validation/gate-status.json` for
commands, exit codes and the explicit collective unit-file coverage receipt.

The earlier `run-gate.py` resource counters use cumulative child resource
usage; notably, an old failed-build RSS value can include an earlier child
process inherited through the shell. These counters do not affect exit codes,
logs or elapsed times. The retained `run-gate-v2.py` uses `wait4` for the
individual command; the final dry build and final unit retries use that
version and label the resource method in their JSON receipts.

## Reproduction

Keep a normal checkout named `manabitan`, an explicit frozen baseline worktree
at `9e10d3b3`, and a candidate worktree at the selected variant commit. Install
dependencies and generated libraries using the repository's normal commands.
Prepare pinned archives with `node dev/perf/prepare-dictionaries.js jmdict
jitendex vndb`; the lock is included, but archives are intentionally omitted.

The retained scripts preserve their measured layout under
`builds/research-0119/`. Copy `sources/*.mjs` and `sources/run-gate*.py` there in
the normal checkout and candidate. Point the candidate's
`builds/e2e-dictionary-cache` at the verified normal-checkout cache. The parser
adapter's compatibility import is
`/tmp/manabitan-research-0119/parser-replay.mjs`; create that directory and
symlink this path to the copied `parser-replay.mjs`. No product file is changed
by this adapter binding. The field scripts explicitly assert the frozen
baseline encoder hash and the candidate hash supplied on the command line.

From the candidate worktree, with an absolute baseline path in `$baseline`
and V3's source hash in `$score_sha`:

```sh
node builds/research-0119/record-capture.mjs "$baseline" "$PWD" \
  ../manabitan/builds/e2e-dictionary-cache \
  builds/research-0119/jmdict-capture.json jmdict
node builds/research-0119/record-screen.mjs jmdict replay-warm.json 12 "$baseline" "$score_sha"
node builds/research-0119/record-cold-pairs.mjs replay-cold.json 24 "$baseline" "$score_sha"
node builds/research-0119/record-corpus.mjs jmdict "$baseline" replay "$score_sha"
node builds/research-0119/record-corpus.mjs jitendex "$baseline" replay "$score_sha"
node builds/research-0119/record-corpus.mjs vndb "$baseline" replay "$score_sha"
node builds/research-0119/record-stream-screen.mjs jitendex "$baseline" replay "$score_sha"
node builds/research-0119/record-stream-screen.mjs vndb "$baseline" replay "$score_sha"
node builds/research-0119/record-live-route.mjs "$PWD" builds/research-0119/replay-live.v8
```

`record-live-route.mjs` invokes the corrected capture script from the normal
checkout's `builds/research-0119/` directory. It is intentionally diagnostic,
asserts the V3 source hash, and must not supply timing evidence. The capture
script itself can be run against baseline/candidate roots to produce the
owned `.v8` inputs, then `compare-db-captures.mjs` compares every frame. Output
paths for these capture tools must not already exist.

No dictionary archive or large binary capture is included. The raw JSON
observations, source patches, parser/source bindings, corrected frame hashes,
route coverage and validation receipts are sufficient to audit the claims and
regenerate those inputs from the locked corpora. `inventory.json` records file
sizes and SHA-256 values for the bundle.

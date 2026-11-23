# VNDB media-index path parsing

The generation-media index parses every image ID during creation and again when
selecting the glossary's referenced images. This change reads canonical decimal
digits directly from the path, removing the temporary substring and
number-to-string round trip. Namespace matching, positive integer bounds,
leading-zero rejection, duplicate detection, index ownership, and stored bytes
are unchanged.

## Scope and reproducibility

- Baseline: `5e1f8c12f7ff798ba407323aff675cb23b22af02`.
- Product file: `ext/js/dictionary/dictionary-generation-media-store.js`.
- Baseline file SHA-256: `4892f8df37bb30580dc66833b20e02f63af86942986f9892d4f7520f095df583`.
- Candidate file SHA-256: `0d6263a93771a1a77ade1376a64a5b74381a24b2a4a9e408f552e3bae02d447b`.
- Fixture: `vndb_characters_by_bee.zip`, 291,705,969 bytes, SHA-256
  `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`.
  Its index title is `VNDB Characters by Bee`, revision `395525135651`.
- Source-derived metadata covers all 146,570 image paths and 163,034 index slots.
  The partial selection omits every seventh path, leaving 125,631 references.

Run from the candidate checkout with Node 22.22.0:

```sh
node --max-old-space-size=512 dev/perf/generation-media-index-benchmark.js \
  /path/to/vndb_characters_by_bee.zip /path/to/baseline-checkout > media-index.json
```

The resident-metadata component includes index creation and reference restriction.
It excludes ZIP reads, payload validation/inflation, OPFS, SQLite, worker transport,
term parsing, and UI completion. Metadata uses the original ZIP's payload spans;
this does not reproduce the media packer's stored-DEFLATE-body normalization.
The path corpus and complete index-byte equality remain representative of this
parser change. No whole-import speedup or peak-memory reduction is established.

## Frozen final schedule

Node 22.22.0, Linux x64, Intel Xeon Platinum 8573C. Four excluded warmups per source
and workload precede twelve fixed triplets in balanced orders. A and C call the
same baseline source; B calls the candidate. Full and partial selections have
separate observations. Every timed call compares all descriptor fields and index
bytes with the baseline outside the timed interval. Thread CPU and wall time are
recorded separately. All tails are retained; no schedule was extended.

| Selection | Wall paired median B/A | Thread CPU paired median B/A | Faster thread CPU pairs | Thread CPU control C/A | Equal-work thread CPU B/A |
| --------- | ---------------------: | ---------------------------: | ----------------------: | ---------------------: | ------------------------: |
| Full      |                -21.97% |                      -19.50% |                    9/12 |                 -3.42% |                    +9.94% |
| Partial   |                -41.66% |                      -29.23% |                   11/12 |                 -4.37% |                   -42.64% |

Full-selection thread-CPU medians are 38.02 ms baseline and 28.67 ms candidate;
partial-selection medians are 37.99 ms and 28.03 ms. The full-selection candidate
has a large retained tail, so its summed CPU and wall time are worse than A's.
Same-code wall controls are also unstable: C/A medians are -16.29% and -12.72%.
Medians favor the candidate, but the controls and tails do **not** establish a
stable complete-component or whole-import speedup. The deterministic reduction
is the removal of per-path substring and number-to-string operations. The change
remains a performance draft pending browser qualification.

## Retained evidence

All observations are in `results/vndb-media-index-20261122/`:

- `screen.json`: exploratory prototype, twelve alternating pairs, full selection.
- `confirmation.json`: prototype confirmation, twelve fixed A/B/C triplets for
  each selection. Total paired medians were -27.64% full and -15.77% partial;
  identical-code controls were -1.37% and -1.48%. This cohort is separate from the
  final source measurements and has no thread-CPU samples.
- `contended-source.json`: first exact-source run overlapped another agent's
  multiworker corpus capture. All byte checks passed, but extreme same-code
  variation makes this correctness-only evidence. It is not used for speed claims.
- `current-source.json`: the complete final fixed schedule above, after the known
  overlapping work stopped. Includes source/harness/fixture hashes and all 72
  timed observations. Unrelated host activity could not be excluded.
- `measured-harness.js.txt`: exact final measurement script matching the recorded
  harness hash. The maintained script subsequently received lint/type annotations,
  a static candidate import, and the project's `safePerformance.now()` wrapper.
  These edits do not change the schedule or product source; no further timings
  were collected. To repeat the original script byte for byte, copy this snapshot
  to `dev/perf/generation-media-index-benchmark-measured.js` and invoke it with the
  same arguments.

## Validation

The generation-media suite passes 39 tests, including 24 new checks covering
canonical decimal spelling, whitespace, signs, exponents, alternate numeral
scripts, safe-integer overflow, namespace matching, and maximum uint32 IDs.
Existing tests exercise stored/DEFLATE reads, index corruption, ownership,
selection, staged writes, cancellation, and publication failure cleanup.

Main, dev, and test TypeScript gates, scoped ESLint, and report formatting pass.
The test gate uses `test/jsconfig.typecheck.json`, matching `npm run test:ts:test`.
An earlier manual invocation mistakenly used the broader editor configuration
`test/jsconfig.json`, which includes the Firefox Selenium harness and reports
918 third-party dependency diagnostics. Those diagnostics also occur with local
dependency paths; they are not failures of the repository's test-type gate.

The initial test/lint attempts failed before tests because generated libraries
were absent; `npm run build:libs` resolved that setup issue. A later uncapped
scoped ESLint process was killed with exit 137, and a 1 GiB attempt using the
broader editor configuration exhausted its explicit V8 heap cap. The actual
test-type gate passed with a 1.5 GiB cap. Capped lint/type checks were also
interrupted to isolate timing. None of these setup/validation attempts are
performance observations.

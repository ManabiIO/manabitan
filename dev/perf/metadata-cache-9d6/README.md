# Cold source-cache loop experiment

This is an unqualified performance experiment against baseline commit
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The sole runtime patch extracts the
published source-span validation loop into a small adjacent class method.
`candidate.json` binds the exact baseline source, candidate source and patch.
Three existing plain-object test owners are wired to the extracted helper;
their assertions are unchanged. These test-only changes travel with the patch.

## Hypothesis and scope

A fresh Node 24.22.3 diagnostic showed the existing cache function repeatedly
leaving optimized code after its first long loop. The recorded reasons were
insufficient type feedback in later cache-policy operations. A short validation
helper could finish tiering without compiling those later operations. The
function's checks, order of source reads, cache policy and mutations remain in
their original sequence.

This hypothesis is specific to cold execution. A previously rejected experiment
fused validation into metadata publication; its warmed component saving was
about 0.6 ms per JMdict corpus. That patch is not included here.

The replay invokes publication and caching for all 12 captured source groups:
528,299 source rows and 362,032 published contents. It uses a real
`DictionaryDatabase` constructor, its fixed native metadata arena, restored
shared source buffers and the production ownership registry. Captured pending
columns occupy independent compact arrays, while some production pending
columns can reside in native scratch memory. Groups are replayed consecutively;
the browser inserts parsing, encoding and compression work between these calls.
That difference can affect background compilation and must not be mistaken for
a measured browser import improvement.

## Capture prerequisite

Use the portable capture script from the companion component package with both
source arguments pointing to the frozen baseline. It verifies the current
locked JMdict archive, runs the real source planner, native parser workers and
canonical deduplication, and checks every row's resolved bytes. It writes
`group-XX.bin.gz` files and a source-bound `report.json`.

The fixture SHA-256 is
`3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`.
The expected canonical row-byte digest is
`7dd16413a3775b36008a3b14bef7bd14272674a9edc1cc83eaf23ddd697d396b`.
The capture uses deterministic virtual storage offsets. It excludes actual
compression, OPFS and browser UI. Its instrumented phase values are not timing
observations.

## Preparation and execution

Use Node 24.22.3 for this component screen. Prepare the baseline with `npm ci`
and `npm run build:libs`. The normal library build verifies and copies the pinned
dictionary WASM artifacts; it does not require a host compiler. The baseline
checkout must be at the exact commit above.

```sh
node dev/perf/metadata-cache-9d6/run.mjs \
  /absolute/baseline \
  /absolute/capture \
  /absolute/output \
  AB
```

The default preparation creates a detached worktree from that baseline, applies
only `candidate.patch`, verifies the resulting source hash and changed paths,
and shares the baseline's dependencies and generated libraries. It never uses
another experimental branch's runtime source.

For a disk-constrained local screen, an optional fifth argument can identify an
existing candidate worktree. The runner verifies its baseline HEAD, sole
changed runtime path, declared test adaptation and exact candidate source and
test hashes before using it. The hosted workflow uses the default
detached-worktree preparation.

Run the `BA` initial order on an independent host as a separate replication.
The full browser import qualification uses the repository's own pinned runtime
and harness; component Node results do not replace that gate.

The separate `import-metadata-cold-9d6.yml` workflow runs these two orders on
independent GitHub-hosted runners. It reuses capture artifact
`jmdict-source-capture-9d6-46103338197-1` from run `46103338197`, attempt 1,
at commit `d4470d35a684a8c37628123d7740ec2fa3375f4b`. `capture.json` pins artifact
ID `15245899188`, size 16,506,090 bytes and digest
`sha256:c3ab42f8714af1c21053e258c5caa7b8fa3c98a6f2eace8cf3c29f69da9f0ffe`.
The workflow verifies and records that complete API identity before downloading
it. Its runner and children verify the capture report, source identities and
compressed payload hashes. The capture must exist before this workflow starts.

This package has its own path outside the initial component workflow's push
filters, so publishing it does not repeat the capture, registration or codec
cohorts. The workflow runs focused behavior tests and scoped ESLint on the exact
patched candidate after the AB timing cohort.

## Fixed observation protocol

Each invocation runs two separately reported cohorts, with all six A/B/C
permutations in each. A and C use identical baseline source; B uses the sole
candidate patch. The BA replication swaps A and B in the fixed schedule.

- Cold: one fresh child process per observation, no warmups, one complete
  12-group publication/cache pass.
- Warm: a separate fresh child process per observation, four excluded complete
  passes, then ten measured complete passes.

Source loading, fixture decoding, source restoration, metadata reset,
ownership registration, explicit GC and verification are outside timing.
Every child verifies the retained source byte counts, publication counts,
ownership adoption, all metadata-table bytes and retained cache bytes. The
driver requires a common output digest across every arm and cohort. Every
child's Node/V8 version, source and capture hashes, group times and process
memory are retained.

`protocol.json` is written before observations. Each child has separate command,
stdout/stderr and JSON receipts; `observations.json` is updated after every
successful observation. `result.json` records completion or the first failure
and all observations obtained before it. A failed cohort stays failed. There are
no automatic reruns, tail exclusions or control subtraction.

The primary component endpoint is publication plus caching. Cache-only and
publication-only values are diagnostic subphases. Parent source parsing,
compression, persistent storage and UI are outside this endpoint. Process memory
receipts describe this replay process, not browser peak memory.

## Qualification status

The runtime patch has 187 passing existing tests covering publication ranges,
deduplication and boundary-cache behavior. Main TypeScript passed. The final
scoped ESLint process was killed under local host memory pressure; its hosted
check remains required.

One complete local AB cohort retained every prescribed observation and produced
identical output digests across all 36 processes. Cold observations pointed
toward a useful reduction, but the baseline controls had severe timing drift
and the warm cohort was inconsistent. Those observations motivate isolated
replication; they are not a qualified gain. The unchanged local cohort will not
be rerun.

Hosted performance observations must be reviewed before any speed claim or
runtime PR. A successful cold component screen would justify a fixed complete
browser import experiment, not a release speedup claim.

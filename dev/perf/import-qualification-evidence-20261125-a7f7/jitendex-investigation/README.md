# Jitendex investigation and withheld candidates

All investigation started from develop
`7d1643e6147a10cb2165e9744cf0e63b59e46632` and the exact locked Jitendex archive
with SHA-256 `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356`.
No new Jitendex runtime patch from these experiments is proposed.

The fresh hosted baseline profile is retained in `../baseline-profiles.tar.gz`
and came from Actions run
<https://github.com/ManabiIO/manabitan/actions/runs/45639067285>.
Its single ordinary import and separate traced import are diagnostic observations,
not a paired comparison. Trace samples are aggregate diagnostic attribution and
must not be added to, or interpreted as, complete-import wall-clock time.

## Short-field comparison ordering

A native content-equality experiment compared short fields before a long glossary
when determining whether adjacent content could be reused. It preserved the
full 436,555-row parser replay digest. Instrumented work counts found 1,257,876
glossary-comparison bytes avoided but 2,313,581 additional short-field comparison
bytes. This does not support the proposed work reduction.

The two local replay pairs were noisy and are retained in full. They are a
component screen, not production complete-import measurements or an acceptance
test. The experiment was reverted; its patch and instrumentation remain here
for reproducibility. Its source-bound WASM is not shipped by this PR.

## Prepared Zstandard compression dictionary

A feasibility probe compared raw-dictionary and prepared-dictionary compression
of actual Jitendex input prefixes. Several small-prefix compressed outputs
differed, including a one-byte size increase at 1,024 input bytes, and a prepared
dictionary retained another 47,680 bytes per context. Larger tested prefixes
produced identical bytes, but no supported full-import benefit was established.
The pinned Emscripten environment needed for a production build was unavailable
locally. This remained a feasibility probe and was not published as a runtime
change. The raw measurements remain in `cdict-feasibility.json.txt`.

## Direct record encoding across splits

An independent ordinary-policy replay of the split-origin approach processed
all 436,555 rows in 22 runs and preserved the complete encoded-byte digest.
Both arms copied 873,110 score-key bytes; no temporary offset/length copying was
avoided because this grouping did not take the relevant split path. This is
component evidence against claiming a Jitendex gain from PR #897's JMdict case.

## Qualification checks

The retained focused observer/receipt tests and actual ordinary-report checks
validate the separate qualification tooling. They are not new timing or memory
observations. Source, fixture, package and raw-report hashes are recorded in
the receipts. Current-source PR #875 Jitendex timing and memory observations are
audited separately alongside their exact frozen candidate and unchanged controls.

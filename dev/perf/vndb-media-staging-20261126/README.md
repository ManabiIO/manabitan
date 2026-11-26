# VNDB media input staging

The validation path can copy one bounded, immutable ZIP range into WASM while
keeping each image's original offset and length. The ordinary compact copy path
remains for separate, overlapping, reordered, shared, resizable, or native-heap
buffers. Retained decoding is unchanged. Both paths run the same native decoded
length and CRC checks in the same source order.

The range stays within the existing 4 MiB input budget. Its maximum additional
bytes follow the source-media packer's existing one-eighth overhead bound. This
is a trade of additional copied header bytes for fewer JavaScript copy calls,
not a memory reduction.

## Frozen scope and observed work

Baseline: [`0143e9596cd8f790d5e166d4ba6a2425fbc57f14`](https://github.com/ManabiIO/manabitan/tree/0143e9596cd8f790d5e166d4ba6a2425fbc57f14).
The candidate changes only the JavaScript media staging path. The checked-in
native module is identical. The receipt records both JavaScript source hashes,
native bytes, fixture identity, runtime, and the executable harness hash.

The complete pinned VNDB fixture contains 146,570 images and 188,131,284 decoded
image bytes. The unchanged production reader supplies 144 bounded batches.

| Observation                                | Baseline A and identical control C |     Candidate B |
| ------------------------------------------ | ---------------------------------: | --------------: |
| JavaScript input copy calls                |                            146,570 |             144 |
| Bytes copied into WASM                     |                        188,864,129 |     195,643,218 |
| Largest WASM buffer observed while staging |                    1,638,400 bytes | 1,703,936 bytes |

The candidate avoids 146,426 calls (99.90%), copies 6,779,089 additional bytes
(3.59%), and observes one additional 64 KiB WASM page. These are deterministic
component work counts. They do not establish whole-import speed or browser peak
memory. No wall-clock cohort was acquired; `observations` is deliberately empty.

The instrumented count pass is separate from production output verification.
Every image passes the native validation in all three arms. Baseline and
candidate production packers then produce identical hashes for every packed
record, the complete sealed index and descriptor, and all 195,649,882 bytes of
the packed source span. Read counts, read bytes, compressed bytes and decoded
bytes also match. This verifies the media packer, not an installed extension's
database, restart behavior, complete term content or visible import readiness.

## Reproduction and receipts

- [Complete work and output parity receipt](work-parity.json.txt)
- [Harness snapshot](media-staging-screen.mjs.txt)
- [Original successful run output](work-parity.log)
- [Final 12-case regression run](final-shared-staging-tests.log)
- [Earlier 11-case regression run](shared-staging-tests.log)
- [Retained initial test timeouts and killed lint attempt](initial-check-attempts.txt)
- [Changed-file lint after formatting repair](lint-passed.log)
- [Retained test-only formatting diagnostics](lint-formatting-failure.log)

Build the baseline and candidate libraries normally, then copy the harness to a
`.mjs` filename and run it with Node 22.22.0 and the lock-verified archive:

```sh
cp dev/perf/vndb-media-staging-20261126/media-staging-screen.mjs.txt /tmp/media-staging-screen.mjs
node --expose-gc /tmp/media-staging-screen.mjs /path/to/baseline /path/to/candidate /path/to/vndb_characters_by_bee.zip /tmp/vndb-work-parity.json work
node node_modules/vitest/vitest.mjs run test/zip-media-shared-staging.test.js --maxWorkers 1 --no-file-parallelism
```

The final focused suite covers mixed methods, exact payload bytes, gaps,
nonzero offsets, zero-length payloads, fallback layouts, the existing arena
limit, corruption precedence, and recovery after failure. The subsequent lint
repair only splits two test statements across lines; production bytes and
assertions are unchanged. Changed-file lint and Markdown formatting pass. An
independent source review found no correctness blocker. Full repository and browser qualification
remain the normal PR CI gate; the local browser is blocked by socket permissions.

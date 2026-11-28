# JMdict canonical overlap diagnostic

This tooling answers a limited question: while group *i* waits for its already
started content and record operations, is group *i + 1* available early enough
that bounded canonical preparation could occupy part of that wait?

It instruments exact product commit
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. It is a one-run diagnostic, not a
candidate optimization or A/B benchmark. All reported timing is explicitly
non-authoritative. No import thresholds, worker counts, compression choices,
source lifetimes, parser lead limits, ownership, or scheduling are changed.

## Source guards and acquisition

`instrument.py` requires the exact clean baseline and fixed SHA-256 identities
for four product files and the existing benchmark wrapper. Every product edit
is a standalone call or import between marker comments. Removing all marker
blocks must reproduce the original product files byte for byte. No `await`,
promise handler, task, source transfer, or callback invocation is introduced.
The new runtime stores only numeric/boolean/string observations and weak object
identities; it does not retain source buffers.

The existing benchmark wrapper is changed only to label its output as an
instrumented diagnostic. Source and fixture acquisition, Chrome release build,
production defaults, the full 528,299-row import, content probes, restart, and
lookup checks remain in place. The analyzer additionally checks the frozen
archive receipt, known baseline probe digest, 12 probe identities, all 72 lookup
observations, and package/source hashes. These checks do not establish equality
of every persisted record.

The prospective workflow first preserves these tools, checks out the exact
baseline, then applies the markers. It retains original JSON/HTML reports, the
instrumented source, reversible patch, full package entry hashes, raw events,
derived results, and tool/workflow identities. It performs no A/B run, CPU
trace, or process-memory sampling. Failed acquisition or analysis remains a
failure; the workflow does not retry or discard it.

## Marker meanings

| Marker | Observed boundary |
| --- | --- |
| `group-ready` | Storage/import worker received and validated a parser result, immediately before resolving its existing ordered slot. |
| `sink-enter` / `sink-exit` | Existing ordered `_onChunk` callback and its existing `finally` block. |
| `dedup-start` / `dedup-end` | Existing complete canonical preparation/resolution call. |
| `canonical-start` / `canonical-end` | Existing native canonical scan and exact-match resolution region; end also records the existing separate counters. |
| `content-storage-ready` | Existing storage-reservation await resolved, or full persistence resolved for the non-early path. |
| `metadata-published` | Current group has published metadata and, on the early path, registered its in-flight content source. |
| `record-start` / `record-done` | Record helper entered / its existing record-store await resolved. |
| `lookahead-gate` | Current record promise has been obtained. Initial synchronous encoding may have run, but record I/O need not all have been dispatched. |
| `content-done` | Already-existing content completion handler ran. No extra handler is added. |
| `join-done` | Existing `Promise.allSettled` for content and records resolved. |
| `record-validation-*` / `record-encode-*` | Synchronous record validation/encoding spans, including later segments that may run after the gate. |

Identity follows the original parser chunk, the plan retained by importer and
record wrappers, and then the nonempty resolved-offset column retained by
record slices. Shared empty deferred-resolution sentinels are never identities.
The analyzer rejects lost, duplicate, unbound, non-monotonic, incomplete, or
unexpectedly ordered events instead of filling gaps.

## Derived ceilings

For each adjacent group pair with an early content/record join, the apparent
window starts at the later of the current gate and next-group readiness and
ends at the current join. If readiness follows the join, its width is zero.
The union of known synchronous record validation/encoding spans is clipped to
that window and subtracted once. Other work and scheduling are not subtracted,
so the residual remains an optimistic upper bound, not measured idle CPU.

The analyzer separately caps that residual by the next group's canonical
counter and by its whole preparation span. These yield two descriptive
ceilings; the first group cannot be moved into a predecessor's window and is
excluded. No percentage speedup is calculated. The proposed concurrent
preparation has not run, and source ownership, cancellation/draining, arena
growth, memory, and CPU contention could consume the entire apparent benefit.

## Small local validation

Run from a repository containing the frozen git objects:

```sh
python -m unittest discover -s /path/to/canonical-timeline-b9cacc -p 'test_*.py' -v
node /path/to/canonical-timeline-b9cacc/test_runtime.mjs
```

These checks exercise source drift/ambiguous-anchor rejection, exact inverse
byte proofs, wrapper/slice identity, shared empty sentinels, acquisition guards,
event loss/order, and clipped interval unions. They never launch a browser or
import a dictionary.

For review, place the Python/JS/test/README files under
`dev/perf/canonical-timeline-b9cacc/` and the prospective YAML under
`.github/workflows/import-canonical-timeline-b9cacc.yml`. Publication is a
separate coordinator decision after source review.

# Dense ZIP media deferral screen

The importer can defer image payload reads to speculative media preparation.
Those membership checks previously called `DenseZipFileMap.get()`, expanding
compact metadata into an entry object and filename view for every first image
reference. `hasArchiveEntry()` answers the same question without expanding an
unopened entry. Owned byte replacements still use the ordinary resolver, and
fallback reads still call `get()` when speculative preparation cannot publish.

Run the component screen with the pinned VNDB archive:

```sh
node test/perf/lazy-media-deferral-20261126/screen.mjs \
  builds/e2e-dictionary-cache/vndb_characters_by_bee.zip > deferral-screen.json
```

The runner checks the archive's byte length and SHA-256 against the dictionary
lock. Each observation creates a fresh production dense catalog, opens its
non-image members, then probes every image path using either the previous
`get()`/`bytes` predicate or `hasArchiveEntry()`. Twelve fresh processes follow
an `ABBAABBAABBA` order. It checks identical image identities, admissions, and
materialization counts, and records source and runner hashes.

Elapsed time covers only that membership pass. Memory values are differences
in retained Node heap plus ArrayBuffer memory after garbage collection. They
include the baseline's release of compact metadata when its last entry opens.
They do not measure browser peak memory or complete-import latency. Source
payload validation and dictionary writes are outside this component screen.

The importer regression tests exercise both catalog types through successful
speculative publication, unavailable and declined speculative work, missing
references, failed publication, failed term writes, and cancellation. Their
synthetic archive adapter supplies `getData()` payloads, so dense fallback
tests disable raw range batching rather than pretending those fixture bytes
form a physical ZIP archive. Actual browser import coverage is still required.

## Recorded component result

`observations.json.txt` contains all twelve completed observations and the
fixture, source, and runner hashes. Every arm admitted the same 146,570 pinned
VNDB image paths. The previous membership probe materialized 146,570 entries;
the candidate materialized none.

Median retained heap plus ArrayBuffer growth was 29,293,140 bytes for the
previous probe and 3,032 bytes for the candidate: 29,290,108 fewer bytes at this
boundary. This is a Node allocation measurement, not browser peak memory.
The run experienced severe shared-host contention; its elapsed times are
preserved for transparency and must not be used as speed evidence.

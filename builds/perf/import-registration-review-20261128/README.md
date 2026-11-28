# Independent in-flight source registration review

Reviewed product: 8b4f502cdc26541c542b7473fae4e51c0713ef98, compared with frozen baseline 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2.

The independent differential run executed 3,456 cases in the functions V8 isolate and found zero mismatches. This branch preserves that observed summary and the exact executed test body. The runnable file adds only a Node I/O adapter for loading the two frozen source files from local Git objects and optionally writing the summary. No timing or workflow is added.

## Reproduce

From a repository checkout that contains both commits:

```sh
node builds/perf/import-registration-review-20261128/review-differential.mjs /tmp/registration-review-summary.json
```

The script performs no network calls. If a commit is missing, obtain it with the repository's normal Git fetch workflow before running this command. Expected output is cases=3456, mismatchCount=0, mismatches=[].

## What was compared

The script extracts the original register/find/storage-key methods directly from each frozen source. The candidate also extracts its private factory method and typed-array property guard. The minimal constructor initializes only the in-flight batch Set. The candidate's private WeakSet is recreated once alongside the extracted class; the baseline factory is a plain three-field object constructor, matching its original literal allocations.

The deterministic cross product includes persisted offset boundaries (negative, fractional, NaN, Infinity, maximum safe integer and overflow), increasing/unordered/repeated offsets, negative zero, source spans at/past the buffer end, zero and nonzero lengths, ordinary and typed persisted offset arrays, short source columns, misleading Proxy property reads, changing getters, and an existing overlapping live batch. It compares successful admission metadata, exact exception names/messages, partial-registration state, release state, and getter/descriptor read counts.

The source review separately verified all three production span constructors now use the private factory, preserving their original subarray arguments and counts. The origin WeakSet is checked before descriptor reads. Proxy wrappers and arbitrary caller objects do not inherit a factory brand.

## Limits

This is an exact-method differential check, not a full-module import, SQLite/OPFS integration test, browser run, timing measurement, or substitute for project CI. Constructor behavior, native parsing, worker scheduling, and the broader import lifecycle are outside its scope. The Node I/O adapter was added after the V8 execution; no Node execution is claimed for this evidence. The baseline and candidate bodies, case matrix, and comparison logic between the marked body boundaries are unchanged from the original executed code.

The recorded JSON is the original aggregate observed result. Individual successful cases were compared in memory; the original runner did not serialize a per-case trace. Any mismatches would have been counted and the first 20 retained.

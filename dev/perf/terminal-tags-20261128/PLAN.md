# Terminal structured tags: frozen comparison plan

Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.

The candidate extends the existing native fast path for seven literal structured-content tags to an immediately following object close. The main parser still validates that close, required glossary fields, and parent transitions. Worker counts, source grouping, compression, storage formats, and import-completion semantics remain unchanged.

The parser WASM grows from 67,659 to 67,751 bytes. Its SHA-256 is `197d37860910e09897b80ea9267e0cf1ca03fa5efa9ebae9fd6b4ebc8dd44ed5`. The C source SHA-256 is `b719eddcb2fe983ec4b895ba416afc90ecacb80adec2db4111e17237e99d58d5`.

## Acquisition

- Use the unchanged complete-import qualifier in `dev/perf/import-qualification-20261125-a7f7.py` and the current locked archives.
- Acquire JMdict, Jitendex, and VNDB on two independent hosted runners each, starting in opposite orders.
- Each runner completes two untimed warmup pairs, twelve alternating timed baseline/candidate pairs, and four interleaved identical-baseline control pairs.
- Use fresh browser profiles, release packages, production defaults, and Node 22.22.0. The package delta must contain exactly the parser C source and parser WASM.
- Keep every observation and stop a cell at its first validation failure. Do not replace failed or slow observations.
- Run exhaustive media and process-tree memory verification separately after timed acquisition. The prospective current VNDB synchronous-access-handle allocation is exactly 37 units of 4,096 bytes, rather than the older qualifier default.
- Run the full unit suite, pinned native rebuild check, and all-target dry build on the exact candidate. Complete native corpus parity is an additional independent correctness check.

## Interpretation

The primary result is the complete visible JMdict import interval on each host. Component timings and profiler samples are diagnostic and cannot establish that result.

For this small change, the prospective review signal is at least a 2% paired median JMdict reduction and at least nine faster pairs out of twelve on each host. An identical-control effect as large as the candidate effect makes the result inconclusive. Jitendex and VNDB should not show a repeatable median regression exceeding 3%. Correctness and exhaustive-media checks must pass. Memory findings are reported with their actual coverage; incomplete coverage cannot be described as a pass.

An isolated experiment branch runs this plan before any pull request is opened. A candidate that fails to establish a worthwhile benefit remains an experiment.

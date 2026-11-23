# JMdict index writer lifecycle diagnosis

This isolated study diagnoses the roughly 110 ms final index flush observed in
the frozen ordinary JMdict baseline. It is not import-speed qualification, and
none of its durations can be pooled with the ordinary candidate cohorts.

All three arms use the same diagnostic instrumentation. A retains the current
production writer gate. B forces the existing worker past only the source-size
gate. C adds nonawaited worker prewarming after journal ownership. The existing
2 MiB sidecar admission, 16 MiB flush threshold, contents, flush calls and close
durability remain in place. The three packages differ only in one diagnostic
selector module. Exact source commits and that package allowlist are frozen in
`config.json` before hosted acquisition.

The complete schedule is A1, B1, C1, C2, B2, A2. Every observation uses a fresh
persistent Chromium profile and the locked complete JMdict archive. There are
no warmup exclusions, retries, replaced observations or result-dependent
extensions. Node is pinned to 22.22.0, and all arms use the same dependency and
browser locks. The sampler and tracing are disabled. Instrumentation is the
reason this cohort is diagnostic even where inner benchmark timing labels say
otherwise; the outer plan explicitly overrides those labels.

Full row/media counts, twelve complete source-derived public lookup responses,
their repeated lookup receipts, stable physical probes and browser restart are
verified for every observation. The media set is empty and still independently
verified from the source. The full package member maps must differ only in the
declared selector. All source snapshots, source and package hashes, host
metadata, reports, lifecycle receipts and failures are retained, including
hidden workflow files.

The lifecycle receipts cover startup/open, enqueue/send/ack and periodic/final
flush intervals, byte counts and positions. Realm monotonic timestamps describe
durations only within their own realm; cross-realm epoch timestamps support
coarse ordering and must not be treated as a synchronized precision clock.
Intervals may overlap. Six instrumented observations establish neither a
production speedup nor a memory nonregression. A production change would require
its own prospective ordinary qualification after the diagnosis.

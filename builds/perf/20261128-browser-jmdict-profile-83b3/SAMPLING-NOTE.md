# Additive correction: initial and terminal sampling gaps

This note corrects the interpretation of earlier Node profiler tables without changing their raw profiles, numeric tables, archive bytes, or acquisition history. No new profiling run was performed.

The [Chrome DevTools Protocol `Profiler.Profile.timeDeltas` definition](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/js_protocol.json) measures the first delta from `startTime` to the first sample. Subsequent deltas locate later samples. The first observed stack therefore does not describe every moment before that observation.

The earlier compressed-worker table assigned each preceding delta to its corresponding stack. Every group profile's only `inspector/post` sample is the first one. Its 184.826 ms total weight is therefore the **unassigned initial sampling gap**, with `inspector/post` as the first observed stack. The earlier phrase “primarily profile-stop instrumentation” is incorrect. The data also does not establish that the entire gap is CPU spent starting the profiler. It must not be attributed to product CPU from that sample.

The exact raw-profile hashes and arithmetic are preserved in [compressed-profile-gap-audit.json](compressed-profile-gap-audit.json). Across twelve group profiles:

| Boundary                                | Microseconds |
| --------------------------------------- | -----------: |
| Initial unassigned gaps                 |      184,826 |
| Observed span from first to last sample |      901,080 |
| Terminal unassigned gaps                |        2,943 |
| Profile start-to-end span               |    1,088,849 |

For the separate initializer, the corresponding values are 31,921, 16,252, 282, and 48,455 microseconds. All these profiles have nonnegative deltas. Their original product-source hashes, result parity, response counters, and resource observations are unaffected.

The same boundary issue applies to the separately captured canonical-sink profiles. The independently produced [canonical-profile-gap-audit.json](canonical-profile-gap-audit.json), SHA-256 `834a6b3ad4539128504f08d611fc309eec043888444992511ade3c5182c7518e`, binds every raw input by digest and records these boundaries:

| Profiles                                 | Initial gaps, µs | Sample-to-sample span, µs | Terminal gaps, µs | Start-to-end span, µs |
| ---------------------------------------- | ---------------: | ------------------------: | ----------------: | --------------------: |
| Twelve canonical sink profiles           |          332,778 |                   645,471 |             3,520 |               981,769 |
| Four concurrently running codec profiles |          212,081 |                10,411,623 |               701 |            10,624,405 |

The codec sums include waiting and concurrent spans and must not be interpreted as elapsed import time or CPU time. A separate non-initial `inspector/post` observation has a preceding weight of 400 microseconds. That later sample is retained, not folded into the initial gap.

Earlier per-function tables remain descriptive preceding-delta sampled-stack weights. In particular, the registration frame's prior 28.796 ms value did not include the first gaps, but it still is not a direct on-CPU measurement or an estimate of removable wall time. The independently read browser trace uses observed forward intervals and records its own 27.847 ms registration occupancy estimate. Different instruments, hosts, schedules, and weighting conventions prevent treating those values as an A/B comparison.

The browser readback reconstructs sample timestamps, preserves signed negative deltas, and reports forward intervals between observed samples. It leaves its initial gaps and final sample durations unassigned. This avoids inventing endpoint duration but does not eliminate sampling error, thread scheduling delays, or native waits. The SQLite proxy's `Atomics.wait`-capable frame is explicitly separated from work attribution. All historical and new raw evidence remains available for independent interpretation.

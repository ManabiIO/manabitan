# Frozen JMdict profile attribution

This is a reanalysis of an existing baseline profile, not a speed comparison or a new import acquisition. It helps choose experiments; it cannot qualify a performance PR.

## Source and retained input

- Product baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
- Profile workflow source: `1f1f9ff00b8a33df338d3640e6e14498465fe631`; its product files match the baseline.
- Original run: https://github.com/ManabiIO/manabitan/actions/runs/46100048089
- Original JMdict artifact: `15244699610`; ZIP SHA-256 `a5b5205577d59e80533f1e2b313c561b091c5194c7dc9afc4ed9efa110cc9148`.
- Original archive member: `trace/run-1.trace.json`.
- Uncompressed trace SHA-256: `ecf3a46f476bfe5f8a94f863b5b37d9f8886762f229364bbe6f65ccdd013826b`.
- Retained compressed trace SHA-256: `c5d0f2298113694898180b94d770f2dc1b1964c6102264f3e9d1569d1429019a`.
- Retained compressed summary SHA-256: `7b3dc8d7d416cddc5a7933a5d255cc0f1d5adae408c2b132408b247d29c88071`.
- JMdict fixture: 15,645,766 bytes, SHA-256 `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`, 528,299 imported rows.

The one profiled import reported 1,117.2 ms and 43,520,477 stored bytes. Profiling changes execution, and there is no paired candidate in this acquisition.

## Reproduce

```sh
python3 reanalyze.py --trace baseline-jmdict.trace.json.gz --output regenerated-summary.json
```

The script checks the exact uncompressed trace digest. It joins chunks into 11 profiles containing all 54,157 samples. The compressed summary includes every function and raw sample count, not just the excerpt below.

## Parsing and attribution decisions

Early local parsing attempts stopped on two invalid assumptions. First, the trace contains 481 negative time deltas; these must not be clamped or discarded. Second, grouping by process, collector thread and profile ID splits profiles when a collector changes threads, producing missing-node assertions.

The corrected parser groups by process and profile ID and obtains the sampled thread from the `Profile` event. It retains every collector thread ID. This follows the grouping used by Chromium DevTools in [SamplesHandler.ts](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/trace/handlers/SamplesHandler.ts).

The script accumulates the original deltas into timestamps and stable-sorts timestamp/sample pairs, consistent with the timestamp treatment in [CPUProfileDataModel.ts](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/cpu_profile/CPUProfileDataModel.ts). This changes the position of 1,400 samples. Each observed interval is attributed to the preceding sample; the final sample gets zero because a following observation is unavailable. No trailing interval or missing-program repair is invented. Raw signed-delta attribution and negative-delta counts remain in the summary alongside the sorted estimates. Parent relationships, node presence and acyclic stacks are asserted.

The older download-only audit workflow `5f59254a114992f2a792b5d4dbc3183a0875160f` (run `46106273418`) was queued with the first nonnegative-delta assumption. Its output is not the corrected analysis and must not replace this evidence.

## Main-thread excerpt

Profile `0x4`, sampled thread `3596`:

| Function                          | Sorted self intervals (ms) | Raw signed deltas (ms) | Samples |
| --------------------------------- | -------------------------: | ---------------------: | ------: |
| encodeAndAppend                   |                     66.622 |                 46.404 |      85 |
| encodeRecordFields                |                     60.645 |                 61.675 |     150 |
| registration                      |                     60.349 |                 52.329 |      98 |
| recent cache                      |                     60.016 |                 68.847 |      84 |
| Zstd postMessage                  |                     52.503 |                 37.238 |     128 |
| contiguous metadata publication   |                     46.927 |                 32.363 |      44 |
| create lookup envelope            |                     33.677 |                 38.541 |     121 |
| publish resolved plan             |                     31.614 |                 39.134 |     293 |
| prepared-plan validation          |                     19.816 |                  8.966 |      13 |
| canonical scan JavaScript wrapper |                      4.389 |                  7.904 |      18 |

These are sampled stack intervals, not exact CPU execution. Threads overlap and their numbers cannot be added into a wall-time saving. The function labels in this table are shortened; exact names, URLs, line numbers, parents and counts are in the summary.

The resolved-plan publisher's raw line samples mostly point to its scalar fallback. Optimized-code source positions alone do not prove which eligibility check failed. A separate untimed replay with actual codec and persistence inputs is needed before acting on that observation.

## Experiment implications

The profile motivated independent record-field fusion, intermediate-envelope-copy and publication-loop investigations. Registration and native adjacent-key experiments are retained separately and did not establish a useful import gain. Other active owners already cover cache contiguity, compression-request batching and native record-field encoding; this session does not duplicate them. No result in this directory is a PR promotion decision.

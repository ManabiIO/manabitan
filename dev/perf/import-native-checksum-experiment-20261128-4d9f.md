# Native import checksum experiment

This branch acquires an actual-browser comparison before deciding whether the
runtime change deserves a pull request. It does not establish an import speedup.

The fixed baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The fixed
candidate is `7cda9a3a39f3c2626873d414a741433058f9ff16` (the exact same
source tree as local validation commit `78fe97d8338b35e28fb6abd615dde6ecf700ef7f`). The candidate reuses the
already initialized Zstd module's existing XXH32 implementation for large
lookup-chunk checksums. Its temporary allocation includes every input copy and
is freed synchronously. Small, shared, decorated, module-backed, unavailable,
allocation-failed and ambiguous normalized-zero inputs keep portable hashing.
Read and restart integrity checks remain portable. No native artifact, package
dependency, persisted format, worker policy, cache capacity or batching changes.

## Reason for the experiment

Exploratory JMdict lookup-envelope replays produced opposite results on
two Node runtimes. A later source audit found that the candidate wrapper had
been copied directly from its source while the baseline wrapper used the normal
bundled artifact. That packaging mismatch prevents attributing these results
to the checksum change. Both use the same 12 captured production calls, all six ABC
permutations, 18 fresh children, unchanged A/C controls, no prewarming before the
primary observation, and complete output hashes outside the timer.

| Runtime      | Paired median B/A | Paired median B/C | Faster versus A / C |
| ------------ | ----------------: | ----------------: | ------------------: |
| Node 24.22.3 |          -29.971% |          -27.336% |           6/6 / 6/6 |
| Node 22.22.0 |          +21.943% |          +15.129% |           1/6 / 2/6 |

These are packaging-confounded observations, not isolated component gains or
total-import measurements. All output
oracles passed. Identical-control variability, all tails and the unfavorable
Node 22 result remain part of the evidence. Warm diagnostics do not replace the
first-use result. Codec heap size remained 16,908,288 bytes in both cohorts;
this is not browser peak-memory qualification.

The corrected acquisition uses the normal `build:libs` transform for both
wrappers. An independent single-wrapper rebuild reproduces each generated file
exactly. These fresh fixed cohorts are also inconclusive:

| Runtime      | Paired median B/A | Paired median B/C | Equal-work B/A | Median absolute C/A difference |
| ------------ | ----------------: | ----------------: | -------------: | -----------------------------: |
| Node 22.22.0 |           -19.63% |           -29.18% |         +5.41% |                         39.52% |
| Node 24.22.3 |            -2.87% |           -48.53% |         -8.89% |                         84.96% |

Every output oracle passes, but identical-control variability is larger than
the apparent candidate effect. No local speed gain is accepted, and no tails
are discarded or replaced. The earlier packaging-confounded observations stay
separate from these corrected cohorts.

The browser uses its own V8 runtime. The isolated push-triggered workflow tests
that target directly without opening a provisional performance PR.

## Prospective comparison

- Build both exact revisions independently with the same lockfile and Node
  22.22.0, using the pinned release Chrome package and Chromium.
- Use all three locked dictionaries: JMdict, Jitendex and VNDB.
- Run two separate hosted cells per dictionary, starting AB and BA, each with
  four excluded warmups, 12 alternating pairs and the unchanged interleaved
  identical-source controls.
- Keep file-input dispatch through post-UI completion as the timing boundary.
  No profiling or memory sampling occurs during the timed observations.
- Preserve restart, lookup, deterministic media and storage receipts. Run the
  separate exhaustive-media checks and unchanged covered memory observations.
- Require exactly the three declared packaged-file differences, including the
  regenerated source map alongside its wrapper. Keep the current
  VNDB active-SAH allocation contract at exactly 37 full-file units.
- Retain every observation and failure. Do not rerun an unchanged candidate to
  replace an unfavorable or incomplete acquisition.

The existing qualification runner and receipt/memory validators are unchanged.
Any future PR decision must distinguish a demonstrated component reduction from
the actual complete-import and memory outcomes. A failed or inconclusive browser
comparison must not be presented as a qualified import gain.

## Retained initial preflight failure and prospective correction

Run [46124815073](https://github.com/ManabiIO/manabitan/actions/runs/46124815073)
completed with all six cells failing the package-difference preflight. No browser
warmup or measured import ran. The original checklist omitted
`lib/zstd-wasm.js.map`, which the ordinary build regenerates with the changed
wrapper. This was a workflow declaration error, not a measured runtime result.

Every artifact and every packaged entry was independently inspected. All six
baseline entry inventories agree, as do all six candidate inventories. The
only changed entries are the record-store source, Zstd wrapper, and its source
map. The map's source list is unchanged; its only changed embedded source is
`../../dev/lib/zstd-wasm.js`, with exact baseline SHA256
`5e47e777cbe870f65cdf4926a9032ea7090886f4c11f2409a8187404401b442e`
and candidate SHA256
`ad780bc1c86bbb70181549385ec9f2fde1da604b2137547b312425237a9861d4`.
Both match the frozen product sources. Package sizes are 16,805,714 and
16,807,033 bytes, a 1,319-byte increase; individual ZIP hashes differ across
hosts and are all retained.

The initial reports, decoded job logs, complete package entry inventories,
source identities, representative source maps, and artifact/package hashes are
retained in `builds/perf/20261128-4d9f-investigation/checksum-preflight-1.tar.xz`
(SHA256 `2c0bcc5a52a0e9e92f4047e88501aa467fb6316c63d62d784f43a7a366502e88`).
The original CI artifacts contain the raw product ZIPs; this compact archive
retains their verified hashes and full entry inventories, not their ZIP bytes.

A new `manifest2` cohort adds that exact source-map entry to the prospective
allowlist. Product sources, runner and receipt validators, dictionary archives,
12 pairs per host, opposite initial orders, controls, warmups, and all storage,
lookup, media and memory gates remain unchanged. The initial failed cohort is
not relabeled or replaced. The new acquisition remains unqualified until its
actual receipts have been inspected.

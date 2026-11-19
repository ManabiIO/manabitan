# JMdict recent-content cache copy: provisional performance evidence

The isolated cache-copy candidate has favorable repeated measurements for retaining recent term content: 16 of 18 candidate pairs are faster in that phase. **Its effect magnitude remains noisy, and it does not establish a reliable whole-import speedup.** Keep this PR in draft for review, with the existing private ownership and cache limits preserved.

## Change and mechanism

The cache currently copies immutable parser-owned shared bytes into an exact-size private buffer. The candidate aligns the shared bulk copy, shifts bytes inside the private destination when needed, and preserves the original byte sequence. It retains no padding and changes neither the cache byte budget nor source-release, deduplication, persistence, or import worker policy. Ordinary nonshared inputs retain the existing `slice` path.

Baseline CPU traces identify the cache copy as substantial work. The candidate trace also shows why the effect is bounded: most sampled copy time remains in the already-aligned branch. Profiling runs diagnose the mechanism; they are excluded from timing estimates.

## Fixed qualification

The baseline is `d829f5b6e6a75ee8859d38d537d224ec33c4930e`. All runs use the pinned JMdict 2026-09-06 archive, unchanged release build and measurement harness, production import defaults, Node 22.22.0 and Playwright Chromium 153.0.8010.12 on Ubuntu x64 with four available CPUs.

The initial screen freezes an excluded AB warmup, an AA control pair, six alternating AB/BA measurement pairs and a BB control pair. An independent replication freezes twelve pairs beginning BA, with a BA warmup and the same controls. Both arms are built before measurements. The research wrapper's pair-count/order options change for replication; the actual import measurement harness and product inputs do not. Each job then captures separate baseline/candidate traces.

Every observation, including controls and slower tails, is retained. There are no failed or excluded measured runs. The three evidence files preserve all 66 ordinary observations and six diagnostic runs.

## Results

Negative changes mean less elapsed time. Equal-work change compares all measured candidate elapsed time with all measured baseline elapsed time in the same job.

| Cohort                              | Median paired browser change | Equal-work browser change | Faster browser pairs |  Median paired cache-phase change |
| ----------------------------------- | ---------------------------: | ------------------------: | -------------------: | --------------------------------: |
| Identical-product control           |                       +4.58% |                    +7.35% |                  1/6 |     −8.22% / −9.40 ms; 4/6 faster |
| Cache copy, six-pair screen         |                       −1.13% |                    +1.44% |                  4/6 |     −6.20% / −8.10 ms; 6/6 faster |
| Cache copy, twelve-pair replication |                       −1.02% |                    −2.22% |                 8/12 | −16.57% / −19.15 ms; 10/12 faster |

The same-code pre/post controls moved −11.78%/−11.28% in the calibration job, −5.18%/−7.62% in the initial screen, and −15.80%/+1.94% in replication. These variations are materially larger than the approximately 1% paired browser change. The first screen's slower candidate tail remains included, producing a positive equal-work change.

Cache-phase controls also vary materially. The identical-product cohort itself shows a median paired −8.22% / −9.40 ms change, with four of six pairs faster despite identical code. Same-code pre/post cache-phase controls are +9.89%/−1.10% in the initial cache screen and −14.02%/+9.64% in replication. The candidate's 16 of 18 faster cache-phase pairs provide favorable repeated evidence, while these controls limit confidence in a precise effect size.

Both candidate cohorts favor the cache phase, across an EPYC 7763 host and an EPYC 9V74 host. Cache bytes remain exactly **100,724,405** per import. Import-data-bank wall time improves by a median paired 15.5 ms in the screen and 8.5 ms in replication; parallel worker and sink timings overlap, so detailed phase times must not be summed. No precise whole-import benefit, cross-browser/device benefit, or peak-memory reduction is claimed.

## Correctness and identity receipts

All 72 reports validate 526,942 rows, expected title/revision, twelve content probes, and successful rereading after a browser restart. The harness checks the probe digest before and after restart; every report returns `86a9f92e48d74220b4d0240f95703860825c00c5d98baff6218230b6ca3afe36`. These probes complement the focused byte-equality, source-reuse, alignment, cache-budget and fallback tests; they are not exhaustive browser-output equivalence.

Only `js/dictionary/dictionary-database.js` changes in the candidate release package. The canonical digest of the full candidate package-entry hash map is identical in both cache cohorts: `eab304a2aefcfdbfdaaafbc362d8d700d1ac1a59100cf3fda68ff9772b214920`. The baseline map digest is identical in all three cohorts: `c50d2161e74ef6e292f2f9c1a421be5ac27c807db67cc0313bb0bbce57094685`. The calibration arms' entry maps are also identical. ZIP hashes are retained separately because archive metadata can differ between builds.

## Durable evidence

- [baseline-control.json](baseline-control.json) — [Actions run 44590947375](https://github.com/ManabiIO/manabitan/actions/runs/44590947375).
- [cache-copy-screen.json](cache-copy-screen.json) — [Actions run 44595604912](https://github.com/ManabiIO/manabitan/actions/runs/44595604912).
- [cache-copy-replication.json](cache-copy-replication.json) — [Actions run 44597108115](https://github.com/ManabiIO/manabitan/actions/runs/44597108115).

These compact JSON files retain every observation and complete relevant importer/local phase metrics; controls and failure fields; source/tree/package/fixture/harness hashes; changed-entry names and hashes; validation, restart and effective worker receipts; per-observation host data; Actions/artifact URLs; and raw report/trace SHA-256 values. Full traces remain in the linked Actions artifacts with fourteen-day retention. The reported numbers remain available in these files after those artifacts expire.

Full package-entry maps are represented by SHA-256 of UTF-8 `json.dumps(map, sort_keys=True, separators=(',', ':'), ensure_ascii=True)`, plus the changed-entry hashes. This avoids duplicating the large maps while retaining a reproducible identity check.

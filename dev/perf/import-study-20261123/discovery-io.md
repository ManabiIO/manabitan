# Dedicated index I/O worker: discovery audit

## Decision

Reject this broad-activation candidate under the agreed cross-corpus promotion gate. VNDB has a strong discovery gain, but JMdict is 6.31% slower against A and 7.17% slower against C by paired medians, with every B/C pair slower. Jitendex shows no material gain. Do not advance this exact candidate or an unqualified union containing it to production qualification.

The VNDB result supports investigating a narrower eligibility rule that retains the existing path for smaller imports. Such a change requires a separately frozen candidate and a new predeclared screen. It does not change the outcome or remove any observation from this campaign.

## Frozen inputs and method

- Workflow: [45123579865](https://github.com/ManabiIO/manabitan/actions/runs/45123579865); all three corpus jobs succeeded on their first attempt.
- Harness: `a45d8f7e1802ea6ebb7abc613eeda2c9539b75cb`.
- Identical A/C baseline: `5e1f8c12f7ff798ba407323aff675cb23b22af02`.
- Candidate B: `c47605bdc9cffcf27b6b0fdce1d26a3639a7d5b1`.
- Chromium `153.0.8010.12`, Node `22.22.0`, production Chrome packages, strict runtime settings, no experimental import flags, no tracing.

The [predeclared method](README.md) uses warmups A, B, C, followed by measured triplets ABC, BCA, CAB. Authoritative durations cover browser file-input change through completed import UI. Readback and restart occur afterward. Discovery requires at least 5% median improvement against both controls, improved equal-work totals, and at least two faster pairs against each, with no unresolved material regression elsewhere.

The audit verified GitHub archive digests and sizes, safe extraction, every original ZIP member, frozen Git source identities, source dictionary hashes, complete media references, the original semantic verifier results, and separate arithmetic from raw browser timestamps. No import was rerun, discarded, or replaced.

## Primary results

Negative changes mean B completed sooner. Equal-work changes compare sums of the same three imports. Controls are reported separately without subtraction.

| Corpus   | Median B/A | Median B/C | Equal-work B/A | Equal-work B/C | Faster B/A; B/C | Median control C/A |
| -------- | ---------: | ---------: | -------------: | -------------: | --------------: | -----------------: |
| JMdict   |     +6.31% |     +7.17% |         −0.32% |         +6.96% |        1/3; 0/3 |             −2.56% |
| Jitendex |     −1.51% |     +0.24% |         −1.17% |         −0.48% |        2/3; 1/3 |             −1.75% |
| VNDB     |    −24.45% |    −23.57% |        −24.34% |        −23.57% |        3/3; 3/3 |             +0.60% |

JMdict A2 took 1210.7 ms. This retained tail explains the apparently favorable B/A equal-work statistic despite the slower paired median and all three slower B/C observations. VNDB's B/C improvements are 24.90%, 22.20%, and 23.57%; its control C/A changes are +0.60%, −4.30%, and +0.84%. The candidate's VNDB signal is substantial within this cohort, but it does not override the smaller-corpus regression gate.

## All acquired durations

Values are milliseconds. Warmups were excluded from performance estimates before acquisition and remain in the evidence.

| Corpus   | Cohort    | Acquisition order |      A |      B |      C |
| -------- | --------- | ----------------- | -----: | -----: | -----: |
| JMdict   | Warmup    | ABC               | 1156.3 | 1048.1 | 1131.2 |
| JMdict   | Triplet 1 | ABC               |  991.6 | 1054.2 |  966.2 |
| JMdict   | Triplet 2 | BCA               | 1210.7 | 1058.6 |  987.8 |
| JMdict   | Triplet 3 | CAB               |  975.9 | 1055.2 | 1007.9 |
| Jitendex | Warmup    | ABC               | 1577.6 | 1519.2 | 1565.7 |
| Jitendex | Triplet 1 | ABC               | 1571.8 | 1661.0 | 1613.5 |
| Jitendex | Triplet 2 | BCA               | 1630.9 | 1509.9 | 1584.4 |
| Jitendex | Triplet 3 | CAB               | 1618.5 | 1594.0 | 1590.2 |
| VNDB     | Warmup    | ABC               | 8527.1 | 5410.9 | 7287.0 |
| VNDB     | Triplet 1 | ABC               | 7246.5 | 5474.4 | 7289.7 |
| VNDB     | Triplet 2 | BCA               | 7489.7 | 5576.6 | 7168.0 |
| VNDB     | Triplet 3 | CAB               | 7028.3 | 5416.6 | 7087.3 |

## Within-cohort phase diagnosis

These are medians of the three measured observations for each arm, in milliseconds. Phases can overlap; the record-close region is contained in finalization. Queue-await counters are diagnostic subregions and must not be added as independent elapsed-time components.

| Corpus   | Metric                             |      A |      B |      C |
| -------- | ---------------------------------- | -----: | -----: | -----: |
| JMdict   | Completed import                   |  991.6 | 1055.2 |  987.8 |
| JMdict   | Import data banks                  |  909.0 |  970.0 |  904.0 |
| JMdict   | Bulk finalization                  |   28.0 |   26.0 |   24.0 |
| JMdict   | Record-close region                |    7.9 |    4.6 |    7.9 |
| JMdict   | Record queued-write await          |    2.9 |    1.7 |    1.3 |
| JMdict   | Index write await                  |    0.1 |    0.1 |    0.0 |
| JMdict   | Parallel parser pipeline wall time |  805.1 |  808.7 |  798.7 |
| Jitendex | Completed import                   | 1618.5 | 1594.0 | 1590.2 |
| Jitendex | Import data banks                  | 1420.0 | 1467.0 | 1399.0 |
| Jitendex | Bulk finalization                  |  139.0 |   59.0 |  138.0 |
| Jitendex | Record-close region                |  113.7 |   34.6 |  108.9 |
| Jitendex | Record queued-write await          |    0.6 |    3.9 |    0.5 |
| Jitendex | Index write await                  |    0.5 |    0.9 |    0.6 |
| VNDB     | Completed import                   | 7246.5 | 5474.4 | 7168.0 |
| VNDB     | Import data banks                  | 5060.0 | 5190.0 | 5035.0 |
| VNDB     | Bulk finalization                  | 1945.0 |   65.0 | 1935.0 |
| VNDB     | Record-close region                | 1912.5 |   41.8 | 1915.0 |
| VNDB     | Record queued-write await          |    0.5 |    4.5 |    1.6 |
| VNDB     | Index write await                  |    0.2 |    0.6 |    0.3 |

JMdict's roughly 61–66 ms data-phase increase has little finalization work to offset: its baseline record-close median is only 7.9 ms. The available counters do not isolate worker startup from persistence or CPU contention, so the audit does not assign a precise cause to that overhead.

VNDB in this cohort does have a roughly 1.9-second final record-close region. The candidate reduces that region to 41.8 ms while adding only about 130–155 ms to the data-phase medians, consistent with a large completed-import improvement. The record-close counter includes pending writes, header updates, flushing, and closing; it does not isolate kernel-close latency. Other runner cohorts have very different baseline close costs, so no absolute timings are pooled across campaigns.

## Worker activation, bytes, and queue bounds

Every candidate observation, including warmups, explicitly reports worker use: one sidecar for JMdict, one for Jitendex, and two for VNDB. The baseline package excludes both new I/O worker modules and retains the local writer. Its old runtime does not export the new counter; raw receipts preserve that value as absent rather than inventing a measured zero. Package identity establishes that the new worker path cannot run in A/C.

| Corpus   | Index write calls, every arm | Index bytes, every arm | Median maximum queued bytes A/B/C  |
| -------- | ---------------------------: | ---------------------: | ---------------------------------- |
| JMdict   |                            5 |             23,693,336 | 6,284,044 / 8,792,236 / 6,284,044  |
| Jitendex |                            6 |             23,526,384 | 5,175,076 / 5,175,076 / 5,175,076  |
| VNDB     |                           83 |            401,899,752 | 7,368,732 / 18,845,704 / 7,368,732 |

Index byte totals and write-call counts are identical across all 12 observations of each corpus. These byte counters exclude file headers. All observed queue maxima are below even the configured low-memory budget of 24 MiB. VNDB candidate measured maxima range from 14,394,828 to 19,116,968 bytes. This bounds the reported queued index payload in these observations; it is not a total-memory or peak-RSS claim.

## Correctness and retained artifacts

The audit passes all 36 imports, 72 before/after-restart states, 864 complete sampled public lookup responses, and 5,784 media byte probes. All cross-arm physical layout differences are zero. Jitendex's 236 referenced images were independently rederived from every original term bank and all 4,992,155 source image bytes hashed. VNDB's five probes total 4,550 source bytes. This is complete response comparison for sampled terms and complete Jitendex referenced-media verification, not exhaustive lookup of every imported term.

All 345 files in the three original ZIPs match their extracted copies.

| Original archive                        | GitHub artifact |   Bytes | SHA-256                                                            |
| --------------------------------------- | --------------: | ------: | ------------------------------------------------------------------ |
| `import-study-jmdict-1-attempt-1.zip`   |     14794414396 |  830950 | `7c08371625cf730691b2b9d8f7c5251a782be6530659ca0da2a708ec81fb1766` |
| `import-study-jitendex-1-attempt-1.zip` |     14795051876 | 1799221 | `ecaf9d03daaf6ef5cb0192f8535513b931a43976efd161f8035cf5210668f704` |
| `import-study-vndb-1-attempt-1.zip`     |     14794509331 |  906295 | `93782c9a25a90af4bc81b59b6fe8fe424f0c1ce5570d568f77d4c5b0951f1070` |

The [compact receipt](discovery-io.json) retains every duration, queue and activation counter, relevant parser diagnostic, source identity, paired result, and raw report/summary hash. Reproduce the read-only audit with:

```sh
python3 dev/perf/import-study-20261123/audit_io_discovery.py ARTIFACT_DIRECTORY \
  --node /path/to/node-22.22.0 --fixtures FIXTURE_DIRECTORY
```

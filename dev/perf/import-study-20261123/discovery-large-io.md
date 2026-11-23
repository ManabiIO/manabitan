# Large-source index I/O worker: discovery audit

## Decision

**Hold cross-corpus qualification.** VNDB meets the fixed discovery gain requirement: paired medians improve by 6.85% against A and 10.40% against C, all three pairs improve against each control, and both equal-work totals improve. Every integrity and activation check passes. These findings do not establish a clean three-corpus promotion or a production speed claim.

Jitendex has an apparent 13.38% B/A paired-median regression alongside an 11.85% identical-code C/A shift. Its B/C median is +2.74%. That control instability prevents a precise product-regression attribution and also prevents a claim of equivalence. JMdict has paired medians below the 5% regression screen, but its retained B1 tail raises equal-work time by about 13% against both controls. Worker inactivity does not justify dismissing either observation.

Keep the original schedule and all tails. Do not subtract control drift, retry imports, extend the screen, or pool earlier candidates into this result. Any separately frozen combined candidate is a new hypothesis; component effects cannot be assumed to add.

## Frozen inputs and method

- Workflow: [45127809761](https://github.com/ManabiIO/manabitan/actions/runs/45127809761); plan and all three corpus jobs succeeded on their first attempt.
- Study: `fdeb101730347cc4f657406ab82c3c5f6e16d0f1`; baseline A/C: `5e1f8c12f7ff798ba407323aff675cb23b22af02`; candidate B: `7b6f5115f8d837a035c34ba395c9cb63b4eca39a`.
- Candidate tree: `93e14cda98c0ee7be26561a78b9da83fbdb4aa15`, identical to the independently reviewed local commit `5819b634b0b9ac42bf21c27f35bdcd3c0572c096`.
- Chromium `153.0.8010.12`, Node `22.22.0`, production Chrome packages, strict runtime settings, no experimental import flags or tracing.
- Warmups A, B, C were excluded before acquisition; measured orders are ABC, BCA, CAB. All 36 ordinary imports remain in the evidence.

The [predeclared method](README.md) measures browser file-input change through completed import UI. Semantic/media readback and browser restart follow timing. A corpus passes discovery only when paired medians are at most −5% against both controls, equal-work totals improve, and at least two of three pairs improve against each. Unresolved material regression or control instability elsewhere blocks clean promotion.

Relative to the prior broad-worker study, the workflow, acquisition driver, verifier, browser timing/media code, fixture lock, and dependencies are unchanged. Only the frozen configuration and explanatory README changed. This candidate has its own cohort; no earlier observations are pooled. The audit independently verifies GitHub ZIP digests and safe paths, every extracted member, frozen source hashes, package differences, fixture hashes, source image references, semantic receipts, and arithmetic recomputed from raw browser timestamps.

## Primary results

Negative values mean B completed sooner. Equal-work comparisons use sums of the same three imports. C/A controls are reported without subtraction.

| Corpus   | Median B/A | Median B/C | Equal-work B/A | Equal-work B/C | Faster B/A; B/C | Median control C/A |
| -------- | ---------: | ---------: | -------------: | -------------: | --------------: | -----------------: |
| JMdict   |     +1.56% |     +0.75% |        +13.19% |        +13.27% |        1/3; 1/3 |             +0.70% |
| Jitendex |    +13.38% |     +2.74% |        +15.82% |         +2.30% |        0/3; 1/3 |            +11.85% |
| VNDB     |     -6.85% |    -10.40% |         -6.56% |        -10.22% |        3/3; 3/3 |             +6.04% |

JMdict control C/A changes range from -1.69% to +0.81%.

Jitendex control C/A changes range from +10.35% to +17.43%.

VNDB control C/A changes range from -0.65% to +7.07%. Its B/A gains are 10.98%, 6.85%, and 1.62%; B/C gains are 10.40%, 12.15%, and 8.11%.

## All acquired durations

Values are milliseconds. The pre-excluded warmups remain visible; no duration is replaced or removed.

| Corpus   | Cohort    | Acquisition order |       A |      B |      C |
| -------- | --------- | ----------------- | ------: | -----: | -----: |
| JMdict   | Warmup    | ABC               |  1208.6 | 1110.5 |  918.4 |
| JMdict   | Triplet 1 | ABC               |   939.8 | 1306.4 |  923.9 |
| JMdict   | Triplet 2 | BCA               |   926.7 |  941.2 |  934.2 |
| JMdict   | Triplet 3 | CAB               |   941.8 |  931.2 |  948.4 |
| Jitendex | Warmup    | ABC               |  1758.9 | 2194.7 | 1692.4 |
| Jitendex | Triplet 1 | ABC               |  1602.5 | 1816.9 | 1768.4 |
| Jitendex | Triplet 2 | BCA               |  1611.5 | 2120.7 | 1802.4 |
| Jitendex | Triplet 3 | CAB               |  1609.1 | 1648.3 | 1889.6 |
| VNDB     | Warmup    | ABC               | 10028.9 | 8569.7 | 8618.4 |
| VNDB     | Triplet 1 | ABC               |  9156.3 | 8150.6 | 9096.4 |
| VNDB     | Triplet 2 | BCA               |  8778.2 | 8176.9 | 9308.3 |
| VNDB     | Triplet 3 | CAB               |  8703.7 | 8562.9 | 9318.9 |

## Within-cohort phase diagnosis

These are medians of the three measured observations per arm, in milliseconds. Phases can overlap; record-close and queue-await counters are diagnostic subregions and must not be added as independent elapsed-time components.

| Corpus   | Metric                             |      A |      B |      C |
| -------- | ---------------------------------- | -----: | -----: | -----: |
| JMdict   | Completed import                   |  939.8 |  941.2 |  934.2 |
| JMdict   | Import data banks                  |  861.0 |  859.0 |  854.0 |
| JMdict   | Bulk finalization                  |   25.0 |   29.0 |   23.0 |
| JMdict   | Record-close region                |    7.8 |    8.8 |    7.4 |
| JMdict   | Record queued-write await          |    1.8 |    3.8 |    2.1 |
| JMdict   | Index write await                  |    0.1 |    0.1 |    0.1 |
| JMdict   | Parallel parser pipeline wall time |  759.3 |  735.3 |  770.0 |
| Jitendex | Completed import                   | 1609.1 | 1816.9 | 1802.4 |
| Jitendex | Import data banks                  | 1425.0 | 1532.0 | 1459.0 |
| Jitendex | Bulk finalization                  |  126.0 |  155.0 |  187.0 |
| Jitendex | Record-close region                |  101.1 |  114.7 |  111.9 |
| Jitendex | Record queued-write await          |    1.0 |    4.4 |    5.1 |
| Jitendex | Index write await                  |    0.6 |    0.6 |    0.9 |
| Jitendex | Parallel parser pipeline wall time | 1184.5 | 1247.6 | 1211.1 |
| VNDB     | Completed import                   | 8778.2 | 8176.9 | 9308.3 |
| VNDB     | Import data banks                  | 7781.0 | 7848.0 | 8281.0 |
| VNDB     | Bulk finalization                  |  704.0 |   34.0 |  720.0 |
| VNDB     | Record-close region                |  685.6 |    8.9 |  696.1 |
| VNDB     | Record queued-write await          |    1.4 |    3.5 |    5.0 |
| VNDB     | Index write await                  |    0.2 |    1.2 |    0.9 |
| VNDB     | Parallel parser pipeline wall time | 7679.6 | 7721.3 | 8176.8 |

VNDB’s baseline record-close medians are 685.6 and 696.1 ms in this cohort, versus 8.9 ms for B. The A/B/C data-phase medians are 7781/7848/8281 ms. This supports the completed-import gain within the present cohort. It does not establish that the prior cohort’s roughly 1.9-second close cost applies here. The close region includes pending writes, final header work, flushing, and closing; it is not isolated kernel-close latency.

### Retained smaller-corpus tails

| Observation | Complete import | Data banks | Bulk finalization | Record-close region |
| ----------- | --------------: | ---------: | ----------------: | ------------------: |
| JMdict B1   |          1306.4 |     1042.0 |             210.0 |               192.6 |
| JMdict B2   |           941.2 |      859.0 |              26.0 |                 8.8 |
| JMdict B3   |           931.2 |      846.0 |              29.0 |                 6.9 |
| Jitendex B1 |          1816.9 |     1532.0 |             194.0 |               127.3 |
| Jitendex B2 |          2120.7 |     1916.0 |             145.0 |               114.7 |
| Jitendex B3 |          1648.3 |     1414.0 |             155.0 |               112.1 |
| Jitendex C3 |          1889.6 |     1459.0 |             378.0 |               110.7 |

JMdict B1 adds time in both data processing and final record closing. Its archive/index phase is 10 ms, versus 12 and 11 ms in B2/B3. Jitendex B2’s largest increase is in data processing; C3 has a finalization tail outside most of the record-close region. These counters locate the delays without identifying a unique environmental or product cause. The candidate observations in this table report zero I/O-worker files; C3 uses the baseline package.

## Worker activation, source admission, bytes, and queues

Every candidate counter matches the configuration frozen before acquisition. The ordinary raw-bank source totals independently derived from the locked ZIPs are below the 1 GiB boundary for JMdict/Jitendex and above it for VNDB. The original 2 MiB initial index-queue gate remains in force.

| Corpus   | Raw banks | Raw source bytes | Required B worker files | Index write calls, every arm | Index bytes, every arm |
| -------- | --------: | ---------------: | ----------------------: | ---------------------------: | ---------------------: |
| JMdict   |        53 |      171,092,992 |                       0 |                            5 |             23,693,336 |
| Jitendex |       218 |      537,538,792 |                       0 |                            6 |             23,526,384 |
| VNDB     |       665 |    4,267,992,967 |                       2 |                           83 |            401,899,752 |

All candidate activation observations, including warmups:

| Corpus   | Observation | Worker files | Maximum queued index bytes |
| -------- | ----------- | -----------: | -------------------------: |
| JMdict   | warmup-B    |            0 |                  6,284,044 |
| JMdict   | B1          |            0 |                  6,284,044 |
| JMdict   | B2          |            0 |                  6,284,044 |
| JMdict   | B3          |            0 |                  6,284,044 |
| Jitendex | warmup-B    |            0 |                  5,175,076 |
| Jitendex | B1          |            0 |                  5,175,076 |
| Jitendex | B2          |            0 |                  5,175,076 |
| Jitendex | B3          |            0 |                  5,175,076 |
| VNDB     | warmup-B    |            2 |                 12,259,376 |
| VNDB     | B1          |            2 |                  9,737,612 |
| VNDB     | B2          |            2 |                 12,259,376 |
| VNDB     | B3          |            2 |                 12,259,376 |

A/C packages contain neither new I/O-worker module. Their legacy receipts lack the new counter, which remains `null` in the audit rather than being converted into a measured zero. Index write-call counts and chunk-byte totals are identical across all 12 observations per corpus. Chunk bytes exclude headers. Every observed queue maximum is below 24 MiB; the largest is 12,259,376 bytes for VNDB B. These are queued-payload observations, not total-memory or peak-RSS measurements.

## Correctness and retained artifacts

The audit passes all 36 imports, 72 pre/post-restart states, 864 complete sampled public lookup responses, and 5,784 image-byte probes. Every cross-arm physical layout comparison is unchanged. Jitendex’s complete set of 236 referenced images was independently rederived from every source term bank and all 4,992,155 source image bytes were hashed. VNDB’s five source probes total 4,550 bytes. The lookup checks remain sampled; VNDB media verification is not exhaustive.

All 345 original artifact files match their extracted bytes. No import was rerun or discarded.

| Original archive                        | GitHub artifact |   Bytes | SHA-256                                                            |
| --------------------------------------- | --------------: | ------: | ------------------------------------------------------------------ |
| `import-study-jmdict-1-attempt-1.zip`   |     14796785839 |  831133 | `d9614a0dcd4b33ce7406dcf2b9929e11be2681ef2b78c2c00569dd80c6316865` |
| `import-study-jitendex-1-attempt-1.zip` |     14796507581 | 1799885 | `8acaca3e9b51687f5d8a3d76fb9efc0737cfd1d9fbfd7d437d309894372a5a9f` |
| `import-study-vndb-1-attempt-1.zip`     |     14795949400 |  907579 | `ae165d21bd45d3dcd3ec40716f87621077acb7e657554befb20524013c3ee816` |

The [machine-readable receipt](discovery-large-io.json) retains all observations, activation and queue counters, phase/parser diagnostics, source identities, paired results, and raw report/summary hashes. The original ZIPs, extraction, GitHub job metadata, and replay log remain under `bench-tools/round2-large-io-discovery`. Reproduce the read-only audit with:

```sh
python3 dev/perf/import-study-20261123/audit_large_io_discovery.py ARTIFACT_DIRECTORY \
  --node /path/to/node-22.22.0 --fixtures FIXTURE_DIRECTORY
```

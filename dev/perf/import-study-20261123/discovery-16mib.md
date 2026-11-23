# Unconditional 16 MiB flushing: discovery audit

## Decision

Do not advance this candidate to confirmation or production. VNDB meets the predeclared discovery screen, but JMdict has an unresolved material regression versus control C and substantial variation between the identical A/C controls. Jitendex shows no material gain. This screen is insufficient to establish either a general improvement or a reliable JMdict regression.

The candidate shifts work out of the final record-close region into the import-data-banks phase. It removes most of the final barrier, but that phase improvement does not translate proportionally into faster completed imports.

## Frozen inputs and method

- Workflow: [45119016466](https://github.com/ManabiIO/manabitan/actions/runs/45119016466); all three jobs succeeded on their first attempt.
- Harness: `6427e3d801f797271cd1e68b038f9babe13ac18d`.
- Identical A/C baseline: `5e1f8c12f7ff798ba407323aff675cb23b22af02`.
- Candidate B: `e31032d575e329e6021b96359a74e825707004b3`.
- The only packaged runtime difference is `js/dictionary/term-record-import-index-writer.js`.
- All observations used Chromium `153.0.8010.12`, Node `22.22.0`, production Chrome packages, strict runtime settings, no experimental import flags, and no tracing.

The [predeclared method](README.md) uses three warmups followed by the fixed Latin schedule ABC, BCA, CAB. The authoritative duration runs from the browser file-input change through the completed import UI. Readback and restart checks occur afterward. A material discovery gain requires a median paired reduction of at least 5% against both A and C, improving equal-work totals, and at least two faster pairs against each control. Material regressions elsewhere remain unresolved rather than being subtracted as control noise.

The audit reran no imports. It compared every extracted file byte for byte with the original ZIPs, re-executed the frozen provenance and semantic verifier without writing the evidence, reproduced the original verifier results exactly, independently hashed the source dictionary archives, and independently recomputed each primary duration and paired comparison from raw browser timestamps. The receipt retains every observation and its report and summary hashes.

## Primary results

Negative changes mean B completed sooner. Each median uses three pairs; these are discovery estimates, not confirmation results. Equal-work changes compare the sums of the same three complete imports.

| Corpus   | Median B/A | Median B/C | Equal-work B/A | Equal-work B/C | Faster B/A; B/C | Median control C/A |
| -------- | ---------: | ---------: | -------------: | -------------: | --------------: | -----------------: |
| JMdict   |     −0.23% |     +6.51% |        −13.22% |         +7.38% |        2/3; 0/3 |            −10.61% |
| Jitendex |     −2.26% |     +1.29% |         −5.15% |         +0.13% |        2/3; 1/3 |             −3.50% |
| VNDB     |     −5.78% |     −6.56% |         −5.38% |         −7.30% |        3/3; 3/3 |             +0.83% |

The 1125.9 ms JMdict A1 observation remains in every calculation. It explains why the aggregate B/A comparison appears substantially better than the paired median while every B/C pair is slower. Removing that tail, pooling the two controls, or subtracting their difference would change the predeclared interpretation.

## All acquired durations

Values are milliseconds. The warmups were predeclared exclusions from performance estimates and are retained here and in the receipt. No failed, slow, or inconvenient observation was removed or replaced.

| Corpus   | Cohort    | Acquisition order |      A |      B |      C |
| -------- | --------- | ----------------- | -----: | -----: | -----: |
| JMdict   | Warmup    | ABC               |  735.6 |  699.6 |  704.2 |
| JMdict   | Triplet 1 | ABC               | 1125.9 |  727.3 |  700.3 |
| JMdict   | Triplet 2 | BCA               |  737.4 |  783.3 |  735.4 |
| JMdict   | Triplet 3 | CAB               |  818.8 |  816.9 |  731.9 |
| Jitendex | Warmup    | ABC               | 1991.8 | 1606.1 | 1650.0 |
| Jitendex | Triplet 1 | ABC               | 1725.3 | 1791.6 | 1721.8 |
| Jitendex | Triplet 2 | BCA               | 1919.0 | 1616.8 | 1700.8 |
| Jitendex | Triplet 3 | CAB               | 1676.1 | 1638.2 | 1617.4 |
| VNDB     | Warmup    | ABC               | 8552.8 | 7195.2 | 7906.5 |
| VNDB     | Triplet 1 | ABC               | 7511.3 | 7204.7 | 8017.9 |
| VNDB     | Triplet 2 | BCA               | 7581.4 | 7104.8 | 7477.1 |
| VNDB     | Triplet 3 | CAB               | 7389.9 | 6962.5 | 7451.6 |

## Where the work moved

These are medians of the three measured observations for each arm, in milliseconds. Phase measurements may overlap; the record-close region is contained within finalization. They must not be added as independent components or interpreted as isolated kernel-close latency.

| Corpus   | Phase               |      A |    B |      C |
| -------- | ------------------- | -----: | ---: | -----: |
| JMdict   | Import data banks   |    643 |  679 |    562 |
| JMdict   | Bulk finalization   |    130 |   41 |    124 |
| JMdict   | Record-close region |  111.3 | 24.8 |  110.3 |
| Jitendex | Import data banks   |   1479 | 1518 |   1436 |
| Jitendex | Bulk finalization   |    147 |   66 |    143 |
| Jitendex | Record-close region |  113.6 | 32.3 |  110.0 |
| VNDB     | Import data banks   |   5295 | 6811 |   5276 |
| VNDB     | Bulk finalization   |   1984 |   66 |   1997 |
| VNDB     | Record-close region | 1968.0 | 50.3 | 1978.2 |

For VNDB, the finalization median falls by roughly 1.9 seconds while the data-bank median grows by roughly 1.5 seconds. The authoritative total still improves by about 5–6.5%, but the phase numbers chiefly demonstrate redistribution of work. The original close counter wraps pending writes, header updates, flushing, and closing; this run does not isolate their individual costs or assert a peak-memory improvement.

## Correctness and retained evidence

All 36 imports passed the original guards: 27 measured observations plus nine warmups, 72 before/after-restart states, and 864 complete public exact-lookup responses for the 12 deterministic source terms per state. All cross-arm physical layout differences were zero, which is stricter than the generic harness permits. Source and package identities, counts, complete sampled responses, physical spans, and restart persistence agree. This is sampled semantic readback, not exhaustive lookup of every imported term.

VNDB also passed five media byte probes before and after restart in every observation; the audit independently matched those five references to the original archive bytes. Original discovery Jitendex coverage checked its 236 media rows and sampled complete semantics, but did not compare image bytes. The subsequent frozen media harness `fd0a22123a3101054d39ba71e17344c15171d6f6` adds all 236 referenced-image byte checks for future screens. It does not retroactively strengthen this run.

Each original archive contains 115 files; all 345 files matched their extracted copies exactly.

| Original archive                        |   Bytes | SHA-256                                                            |
| --------------------------------------- | ------: | ------------------------------------------------------------------ |
| `import-study-jmdict-1-attempt-1.zip`   |  825240 | `b71f7f6e002a68155932d0607efcd1fe57e7a24a98872641a5033bc6f03cdca7` |
| `import-study-jitendex-1-attempt-1.zip` | 1022038 | `8b5182c9d4f7c449e82e0bac23174c67669cdaf360c17cde6dcf24555a86dd38` |
| `import-study-vndb-1-attempt-1.zip`     |  901514 | `24379ffaf955fb58c07a9c07f7e2c622e14d7809f834d29d3797601583d0d313` |

The complete compact receipt is [discovery-16mib.json](discovery-16mib.json). To reproduce the audit against the retained artifact directory and locked dictionary fixtures:

```sh
python3 dev/perf/import-study-20261123/audit_discovery.py ARTIFACT_DIRECTORY \
  --node /path/to/node-22.22.0 --fixtures FIXTURE_DIRECTORY
```

No confirmation campaign is justified for this unconditional-flush candidate under the agreed cross-corpus gate. Subsequent candidates require their own frozen packages and unchanged, predeclared acquisition schedules.

# Combined index I/O and source-CRC discovery audit

## Decision

**Advance the frozen combined candidate to the two predeclared independent confirmations. This discovery is not a production speed qualification.** VNDB meets the paired-median, equal-work and direction gates against both identical-code controls. JMdict and Jitendex remain below the 5% paired-median regression screen. No earlier candidate observations or point estimates are pooled into these results.

The [completed campaign](https://github.com/ManabiIO/manabitan/actions/runs/45129037078) contains all 36 fixed imports: nine excluded warmups and 27 measured imports. Every hosted job succeeded. The schedule was frozen before acquisition: warmups A/B/C, then measured triplets ABC, BCA and CAB. All observations and tails remain intact; no import was retried, replaced or extended.

## Frozen identities

- Study commit: [`a492044455d200df593fe152638cc1383efa0dde`](https://github.com/ManabiIO/manabitan/commit/a492044455d200df593fe152638cc1383efa0dde); tree `8eac9b7b4c1a7dd97065f2415b1d7e849035e7eb`.
- Baseline A/C: [`5e1f8c12f7ff798ba407323aff675cb23b22af02`](https://github.com/ManabiIO/manabitan/commit/5e1f8c12f7ff798ba407323aff675cb23b22af02).
- Combined B: [`958099525e6017c9faa3d912168da51575527b7d`](https://github.com/ManabiIO/manabitan/commit/958099525e6017c9faa3d912168da51575527b7d); tree `ddf70903a004965361c9ab58a1f1e434c47edd01`.
- Components: gated index I/O `7b6f5115f8d837a035c34ba395c9cb63b4eca39a` and source CRC `0d5a05c40410fd97b0b85a2ad5e432dc5507bb33`.
- Node 22.22.0; Chromium 153.0.8010.12. Each observation uses a fresh profile and the same dependency lock, production-default import options, timing boundary, fixture and post-timing readback harness.
- Authoritative time: browser file-input change through post-UI import completion. Builds, source acquisition, semantic/media readback and restart are outside the interval. Trace and process sampling are disabled.

## Whole-import comparisons

All changes below are candidate-versus-control percentages; negative is faster. Paired medians are medians of the three individual changes. Equal-work changes compare the sums of the three matched durations. Controls are reported directly without subtraction.

| Corpus | B/A paired median | B/C paired median | B/A equal work | B/C equal work | Faster B/A, B/C | Discovery gate |
|---|---:|---:|---:|---:|---:|---|
| jmdict | +1.573896% | +1.975142% | +1.784755% | +1.489811% | 1/3, 1/3 | no material gain |
| jitendex | -1.477220% | -1.183952% | -2.044537% | -1.542967% | 2/3, 3/3 | no material gain |
| vndb | -21.546464% | -19.191852% | -21.226408% | -20.355401% | 3/3, 3/3 | passes |

| Corpus | Identical-code C/A median | Equal work C/A | Complete C/A pair range |
|---|---:|---:|---:|
| jmdict | +0.399331% | +0.290615% | -0.393474% to +0.859681% |
| jitendex | -0.710102% | -0.509430% | -4.422592% to +3.825080% |
| vndb | -0.280465% | -1.093617% | -2.913829% to -0.057973% |

JMdict has a small positive candidate median and retains B2 at 1,127.4 ms. Jitendex retains the A3 tail at 2,023.7 ms and its C/A spread of −4.42% to +3.83%; its roughly 1% candidate medians support no material speed claim. VNDB improves in all six candidate/control comparisons; the least favorable pair is still approximately 18.14% faster. The small fixed discovery sample cannot establish a durable effect or cross-corpus nonregression; the frozen confirmation protocol remains required.

## Every retained duration

Durations are milliseconds, displayed to one decimal. The JSON preserves the original unrounded values. These excluded warmups are retained:

| Corpus | Warmup A | Warmup B | Warmup C |
|---|---:|---:|---:|
| jmdict | 1048.8 | 1247.1 | 1048.2 |
| jitendex | 2009.2 | 1982.4 | 1943.9 |
| vndb | 11786.0 | 7226.9 | 9444.7 |

Measured rows preserve the complete triplets; acquisition order is explicit:

| Corpus | Triplet/order | A | B | C | B/A | B/C | C/A |
|---|---|---:|---:|---:|---:|---:|---:|
| jmdict | 1 / ABC | 1042.0 | 1058.4 | 1037.9 | +1.573896% | +1.975142% | -0.393474% |
| jmdict | 2 / BCA | 1076.8 | 1127.4 | 1081.1 | +4.699108% | +4.282675% | +0.399331% |
| jmdict | 3 / CAB | 1046.9 | 1036.4 | 1055.9 | -1.002961% | -1.846766% | +0.859681% |
| jitendex | 1 / ABC | 1929.3 | 1900.8 | 1915.6 | -1.477220% | -0.772604% | -0.710102% |
| jitendex | 2 / BCA | 1916.3 | 1937.2 | 1989.6 | +1.090643% | -2.633695% | +3.825080% |
| jitendex | 3 / CAB | 2023.7 | 1911.3 | 1934.2 | -5.554183% | -1.183952% | -4.422592% |
| vndb | 1 / ABC | 9448.6 | 7200.5 | 9422.1 | -23.792943% | -23.578608% | -0.280465% |
| vndb | 2 / BCA | 9324.5 | 7315.4 | 9052.8 | -21.546464% | -19.191852% | -2.913829% |
| vndb | 3 / CAB | 8969.7 | 7338.1 | 8964.5 | -18.190129% | -18.142674% | -0.057973% |

## Activation and equal-work evidence

All four B observations per corpus, including warmup, satisfy the predeclared activation split. Raw source eligibility is computed from selected term banks; metadata from media, kanji and unused artifact alternatives is excluded. Zero source-CRC reuse coverage means the ordinary immediate-CRC path is retained, not that source validation is skipped. Legacy A/C counters are absent and remain null; their packages do not contain the new index-worker modules.

| Corpus | Raw term banks | Raw source bytes | B index-worker files | B optimized CRC coverage | Index write calls | Index chunk bytes |
|---|---:|---:|---:|---:|---:|---:|
| jmdict | 53 | 171,092,992 | 0 | 0 | 5 | 23,693,336 |
| jitendex | 218 | 537,538,792 | 0 | 0 | 6 | 23,526,384 |
| vndb | 665 | 4,267,992,967 | 2 | 4,267,992,967 | 83 | 401,899,752 |

Rows, source-bank counts, compressed and uncompressed source bytes, chunk counts, content-write bytes, record-write bytes and lookup-index-write bytes match across all arms and warmups within each corpus. Index write-call counts also match. These write counters exclude some file headers and are not direct persisted file-size measurements.

Every VNDB candidate observation scans **568,284,368 bytes** and reuses a proven raw-byte CRC for **3,699,708,599 bytes**, summing to the original ZIP term banks' **4,267,992,967 bytes**. Each reports **6,490,145** reused glossary witnesses. The audit rederives source bank counts and lengths from the original hash-verified ZIP.

| VNDB B observation | Source CRC ms | Scanned bytes | Reused bytes | Reused witnesses | Worker files | Queued-index peak bytes |
|---|---:|---:|---:|---:|---:|---:|
| warmup-B | 1164.6 | 568,284,368 | 3,699,708,599 | 6,490,145 | 2 | 14,420,636 |
| B1 | 1180.7 | 568,284,368 | 3,699,708,599 | 6,490,145 | 2 | 14,648,224 |
| B2 | 1157.9 | 568,284,368 | 3,699,708,599 | 6,490,145 | 2 | 14,603,640 |
| B3 | 1197.0 | 568,284,368 | 3,699,708,599 | 6,490,145 | 2 | 14,907,272 |

All observed queued-index peaks are below 24 MiB. These counters measure queued sidecar bytes, not total process or browser memory. Source CRC time is included in fused parse-bank time and must not be added to it.

## Diagnostic phase medians

These medians describe the three measured observations per arm. The close region is contained within bulk finalization; worker times and pipeline stages may overlap. They do not provide separate additive speed claims.

| Corpus | Arm | Import data banks ms | Bulk finalization ms | Record close region ms |
|---|---|---:|---:|---:|
| jmdict | A | 874.0 | 139.0 | 119.9 |
| jmdict | B | 864.0 | 131.0 | 107.4 |
| jmdict | C | 871.0 | 126.0 | 108.1 |
| jitendex | A | 1711.0 | 138.0 | 110.5 |
| jitendex | B | 1716.0 | 135.0 | 107.5 |
| jitendex | C | 1717.0 | 150.0 | 120.2 |
| vndb | A | 7042.0 | 2107.0 | 2082.6 |
| vndb | B | 6978.0 | 59.0 | 41.1 |
| vndb | C | 6912.0 | 1939.0 | 1918.0 |

VNDB's largest visible wall-time reduction occurs in finalization: B's median is 59 ms, versus 2,107 ms for A and 1,939 ms for C. This is the combined candidate measurement; it does not estimate an incremental CRC gain or add together earlier candidates' results. Every optional phase comparison, including missing/zero-denominator pairs, is retained in the JSON.

## Readback, media and package checks

- All 72 before/after-restart states pass. The complete public responses for 12 deterministic terms are equal across restart, warmups, arms and observations: 864 complete sampled responses. Each requested term has nonempty dictionary entries and no degraded-availability result.
- Imported term counts are 526,942 JMdict, 435,448 Jitendex and 6,648,310 VNDB. Media counts are 0, 236 and 146,570 respectively. Semantic entry counts for the sampled terms are 12, 17 and 13.
- All 236 referenced Jitendex images are verified against the source ZIP before and after every import/restart, including MIME, length and SHA-256. The driver rederives the complete reference set from all source term banks. Five fixed VNDB source images are also compared. The audit checks 5,784 persisted image-byte probes in total.
- Physical probes are identical within and across packages for this campaign: no layout differences. These are sampled term readbacks and five VNDB images, not exhaustive all-term or all-VNDB-image readback.
- The source and timing overlays match the frozen Git objects. Complete packaged member maps match across all three corpus jobs: 547 baseline members and 550 candidate members. Exactly the eleven predeclared members differ between arms; every changed member matches its corresponding frozen source/WASM blob.
- Whole production-ZIP container hashes differ across independent jobs and are retained individually. The protocol compares their complete uncompressed member maps, which are identical. An initial local audit additionally required equal container hashes; that extra assertion was corrected to the frozen member-map criterion after inspecting every member. The original failed local replay log remains in the acquisition workspace; no hosted import or raw report changed.

### Exact product differences

- `js/dictionary/dictionary-database.js`
- `js/dictionary/dictionary-importer.js`
- `js/dictionary/term-bank-source-crc.js`
- `js/dictionary/term-bank-wasm-parser-worker.js`
- `js/dictionary/term-bank-wasm-parser.js`
- `js/dictionary/term-record-import-index-worker-client.js`
- `js/dictionary/term-record-import-index-worker.js`
- `js/dictionary/term-record-import-index-writer.js`
- `js/dictionary/term-record-opfs-store.js`
- `js/dictionary/wasm/term-bank-parser.c`
- `lib/term-bank-parser.wasm`

### Artifact integrity

Each original Actions artifact was downloaded once, checked against its GitHub API size and SHA-256, and safely extracted with duplicate, absolute, traversal, backslash and symlink paths rejected. The audit rechecks all 345 raw members against their original ZIP bytes and requires the extracted file set to match exactly. Original ZIPs, API snapshots, source snapshots, reports, logs, warmups and tails remain together in the acquisition directory.

| Corpus | Artifact ID | ZIP bytes | Members | SHA-256 |
|---|---:|---:|---:|---|
| jmdict | 14796723095 | 834,178 | 115 | `4b1a35f5256f04e9a1e95721065befbe6eb171350a1980f1c1f34b38b7950159` |
| jitendex | 14796664214 | 1,801,901 | 115 | `ad2fa5873a9601ae0147d759ed1f774c7c7e32304efa0518756b769a66a4f0bd` |
| vndb | 14797402768 | 909,300 | 115 | `daf3156bce18c2fe6b537f5e10df20bc6e82793486185c2756e7c9e1fbdf7719` |

### Independent full unit suite

The unchanged [first-attempt receipt](combined-unit-first-attempt.json) and [complete original log](combined-unit-first-attempt.log) belong to the exact combined runtime tree above. They record **14,079 passed tests across all 632 files, with 47 skipped tests**, exit 0. No tests were rerun or source files changed. The audit verifies their source/tree identity, counts, original log byte length and hash.

- Receipt SHA-256: `fbb2b8bf0246f2bf930321ef2f85399f13dd92c510554c8864d4c065117ee061`.
- Log: 188,291 bytes; SHA-256 `6d1548bc04e6847c48020f7184a3c20a4b68e20fc192f0dee3882384aeffb9bd`.

## Reproduce this audit without new imports

Use this evidence checkout with Python 3.10+ and Node 22.22.0. Fetch the frozen study and runtime commits, retain the three artifact ZIPs and their GitHub API metadata, and safely extract each into the directory named by its artifact. Keep `workflow-jobs.github.json` at the artifact root. Original fixture ZIPs must match the locked bytes. The audit replays the frozen verifier, checks every retained byte stream and independently recomputes timings and all primary/phase pair arithmetic. It does not launch a browser or rerun a dictionary import.

```sh
git fetch origin a492044455d200df593fe152638cc1383efa0dde 958099525e6017c9faa3d912168da51575527b7d
python3 dev/perf/import-study-20261123/audit_combined_discovery.py /path/to/round2-combined-discovery \
  --node /path/to/node-v22.22.0/bin/node --fixtures /path/to/locked-fixtures
```

`discovery-combined.json` contains every unrounded duration, source/worker activation observation, equal-work witness, phase comparison, artifact identity and report/summary hash. Raw artifacts are retained by GitHub until their declared expiry; the locally acquired copies preserve the original containers. This study supports no peak-memory or isolated worker-startup claim.

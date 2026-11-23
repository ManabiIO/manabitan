# Rejected parser startup/source overlap

## Decision

Reject the startup overlap change from [PR #815](https://github.com/ManabiIO/manabitan/pull/815). The fixed browser screen did not establish a useful complete-import gain for JMdict or Jitendex, and VNDB was slower in three of four pairs. No expanded timing cohort or further implementation variant followed this result. The production parser and associated tests are restored to the baseline; the temporary qualification workflow and helpers are removed.

This report preserves the rejected implementation and all observations. It does not claim that the small measured differences establish a causal regression.

## Frozen implementation and qualification

The baseline is `5e1f8c12f7ff798ba407323aff675cb23b22af02`. The tested remote qualification head is [`c79351563e5f391e5d55827d0598f6e874f0bb6b`](https://github.com/ManabiIO/manabitan/commit/c79351563e5f391e5d55827d0598f6e874f0bb6b). Its local qualification snapshot is `722c102acbdb4a3a5a922a89b13a9163cd92e87d`, tree `58f901ff612c8ce9ed9ce8ebb0de9608eb30c1d4`. Exact committed source and test bytes are retained in the evidence archive.

The sole changed packaged entry was `js/dictionary/term-bank-wasm-parser.js`: baseline SHA-256 `fe17c565339b27701f75af881b14da2347dd80aa9273fd9f4cec34c0220b1e23`, candidate `a2946a249ce4f7e9d7bdd698f1ae96f8c7b303b97a452c547f4c12630d40129f`. The parser WASM remained byte-identical at `cc749c53fc32dfb28eefbd69f99868f8c303caa1a3f1354231516dfa5a6e1b0f`.

The candidate started the already-admitted first source group while parser workers initialized. It preserved the lease, group partition, worker count, source budgets, and normal lead window. Early source errors retired worker startup; the importer retained responsibility for aborting and joining source reads. It introduced no format, integrity-validation, compression, or parser changes.

Local qualification passed 198 focused tests, main/test TypeScript, scoped lint, and all seven build dry runs. [Full CI run 45119874857](https://github.com/ManabiIO/manabitan/actions/runs/45119874857) succeeded on the tested head, including 13,997 unit tests passed and 47 skipped across 628 files. Those results qualify the frozen candidate, not a later evidence-only commit.

## Complete fixed browser screen

[Screen run 45119874836](https://github.com/ManabiIO/manabitan/actions/runs/45119874836) used Chromium 153.0.8010.12 and the locked JMdict, Jitendex, and VNDB archives. Each dictionary ran two excluded warmups, four candidate A/B pairs, and four unchanged-product C/D pairs on its own runner. A, C, and D used the baseline; B used the candidate. Full package hashes matched between A/C/D within each cohort.

The predefined timed order was `C1 D1 D2 C2 A1 B1 B2 A2 B3 A3 A4 B4 C3 D3 D4 C4`. All 48 timed imports and six warmups are retained. Timing covers the browser's monotonic file-input change through the post-UI import-complete event. Tracing was disabled throughout this schedule. No observation was excluded or selectively retried.

| Dictionary |    A median |    B median | Median paired B/A change | Candidate faster | Median unchanged-product D/C change |
| ---------- | ----------: | ----------: | -----------------------: | ---------------: | ----------------------------------: |
| JMdict     | 1,052.20 ms | 1,052.35 ms |                  −0.112% |              2/4 |                             −0.125% |
| Jitendex   | 1,607.15 ms | 1,584.55 ms |                  −0.223% |              3/4 |                             +0.419% |
| VNDB       | 9,300.55 ms | 9,475.70 ms |                  +2.281% |              1/4 |                             −0.128% |

Negative percentages mean lower latency. The paired statistic is the median of each pair's percentage change, not the percentage change between the two arm medians.

| Dictionary | All four candidate pair changes, in pair-number order | All four control pair changes, in pair-number order |
| ---------- | ----------------------------------------------------- | --------------------------------------------------- |
| JMdict     | +0.738%, −0.320%, −1.579%, +0.097%                    | −18.908%, −1.222%, +1.309%, +0.972%                 |
| Jitendex   | −0.420%, −0.025%, −3.134%, +1.395%                    | +3.867%, +1.779%, −1.009%, −0.940%                  |
| VNDB       | +5.800%, −3.254%, +3.665%, +0.897%                    | −0.451%, +2.920%, −1.493%, +0.195%                  |

The large first JMdict control change remains in the record. Controls describe variation within their runner; they are not subtracted from candidate results. Absolute times across dictionary runners are not compared or pooled. Four exploratory pairs do not establish a precise effect size. They provide no reason to promote this candidate or enlarge the timing campaign.

All observations matched the locked dictionary identity and term counts, sampled term output, and readability after restart: 526,942 JMdict terms, 435,448 Jitendex terms, and 6,648,310 VNDB terms. The recorded Jitendex media count was 236 in every observation. The dedicated VNDB checks additionally verified 146,570 media entries, packed-media activation, and five byte-level media probes before and after restart. These are sampled persistence checks, not exhaustive stored-byte equality or peak-memory qualification.

## Diagnostic trace explanation

Separate candidate-only traces were captured for JMdict and Jitendex after the fixed timed schedule. These diagnostic runs are excluded from every performance estimate above.

| Diagnostic | First initialize post to last ready handled | First initialize post to first parse posted | Ready-to-parse gap | Approximate copy sample weight within gap |
| ---------- | ------------------------------------------: | ------------------------------------------: | -----------------: | ----------------------------------------: |
| JMdict     |                                  100.467 ms |                                  112.763 ms |          12.296 ms |                                  9.516 ms |
| Jitendex   |                                   63.327 ms |                                   93.474 ms |          30.147 ms |                                 16.146 ms |

The traces contain fresh parser initialize and ready messages for these imports. There is no explicit pipeline-run entry marker, so they do not quantify how much initialization prewarm had already overlapped before the run. The gap uses events on the same owner thread to avoid cross-thread timestamp skew. CPU samples in that gap concentrate at `RawZipPayloadReader.read`, source line 152: the `Uint8Array.from` copy that gives each compressed ZIP payload its own storage. Jitendex also has about 10.2 ms of clipped idle sample weight in the gap.

The normal lead-window activation still initiates source preparation after readiness, and its compressed-payload copies can precede the first parser job. This explains why starting only group zero does not remove the remaining source-preparation work. It does not measure how much the early read saved: there is no matched baseline trace or explicit Blob-read completion marker. Sample interval weights are approximate attribution, not exact function durations. Neither these diagnostics nor overlapping phase sums establish a cause for the VNDB timing difference.

## Retained evidence

The [evidence archive](evidence/startup-source-overlap-rejected-20261123.tar.gz) contains all raw timed and warmup reports, logs, host snapshots, package-entry maps, comparison summaries, source snapshots, the analysis script/output, and packaging recipe/source. The [adjacent manifest](evidence/startup-source-overlap-rejected-20261123.manifest.json) lists every payload's size and SHA-256, all cohort identities, and all omissions.

The two exact diagnostic trace JSON files and their raw reports/summaries are retained separately under `diagnostics/`; their bytes were matched to the original workflow ZIP members. Rendered HTML duplicates are omitted. Original ZIP bytes are not embedded, but their full sizes/hashes and member identities are preserved. Originals remain unchanged. Packaging checked every extracted input against its ZIP member, serialized the archive twice identically, and verified every retained payload against the manifest.

- Archive: 3,225,329 bytes; SHA-256 `c516e0243c12707d3cbf12fba2fa61a04178c6abe7471775a45111c8641557e1`.
- Manifest: 238,484 bytes; SHA-256 `1f603a16babe8fb7f51f87b60dc4f7533367317e23d6395dde00cf2400f36ece`.
- Payload: 437 files plus `MANIFEST.json`.

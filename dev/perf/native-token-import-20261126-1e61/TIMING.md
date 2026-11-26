# Native import component screens — 26 November 2026

**Both candidates remain unqualified for import speed.** The fixed comparisons preserve every recorded observation, including the empty-string warmup triplets and slower outliers. Preflight warmups were not timed; their counts and schedules are preserved in the runners. Identical baseline arms vary enough that the favorable component percentages cannot establish a repeatable benefit. No further timing followup was run after the final fixed native screens.

## Candidates and scope

- **MBR6 capacity preflight:** one capacity check for ordinary non-normalized content rows. The screens cover all 528,299 rows in the 53 locked JMdict term banks, before canonical deduplication. They time only the native encoder over already parsed rows.
- **Empty string recognition:** bypass word classification for an adjacent closing quotation mark. Jitendex contains 1,247,199 top-level empty reading/tag/rule tokens across 436,555 rows. The screen selects eight evenly spaced complete banks (14,555 rows, 19,796,110 bytes) and a separate 4,096-row structured fixture containing no empty strings.

Baseline A and control C use identical WASM bytes. B is the relevant candidate. Node is v24.22.3. All source and output identities available in the original reports remain unchanged.

| Native module             | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| Baseline, both candidates | `b97009b54ae1056efba84964dc6f20e334cd27f47b793a5028e66d9482cb6cfa` |
| MBR6 preflight            | `8918824b3d8d74383bdbce6021272e5667064ad1039480b00123c44625e03aa2` |
| Empty strings             | `dbb7dea6ffd0afdc8817682c1d306d1e25bff4fa2848cca70fe59ac8e20b6cc7` |

## Retained results

Negative percentages mean less elapsed time. These are descriptive medians of paired ratios, not ratios of separate arm medians. Preflight has 106 paired bank passes per comparison; empty-string screens have six paired blocks per comparison.

| Screen                                                      | B/A wall time | B/C wall time | Identical C/A |
| ----------------------------------------------------------- | ------------: | ------------: | ------------: |
| Preflight, initial encoder screen                           |       −1.392% |       −6.543% |       −9.052% |
| Preflight, 16 encodes per observation                       |       −1.163% |       −3.536% |       −3.479% |
| Empty strings, parsed columns and lookup, Jitendex sample   |       −2.761% |      −14.781% |       +9.135% |
| Empty strings, parsed columns and lookup, no-empty fixture  |      +18.203% |      −10.515% |       +5.887% |
| Empty strings, preallocated native parser, Jitendex sample  |       −2.424% |       +7.122% |       −1.864% |
| Empty strings, preallocated native parser, no-empty fixture |       +2.824% |       −3.490% |       +7.877% |

The 16-encode preflight comparison has only 59/106 faster wall-time pairs against A and 61/106 against C. Its apparent equal-work process-CPU reduction of 24.39% against A accompanies an 18.73% reduction for identical control C against A.

The final empty-string followup preallocates source/output arenas, executes 64 passes over the eight Jitendex banks or 512 passes over the no-empty fixture, and checks complete metadata, source immutability and 32-byte guards outside timing. It records current-thread CPU as well as process CPU and wall time.

| Final native parser workload | B/A thread CPU | B/C thread CPU | Identical C/A thread CPU |
| ---------------------------- | -------------: | -------------: | -----------------------: |
| Jitendex sample              |        −2.916% |        +6.690% |                  −1.900% |
| No-empty fixture             |        +2.820% |        −3.314% |                  +7.476% |

For the Jitendex sample, B is faster than C in only one of six thread-CPU pairs; total B CPU is 9.85% greater than C. Identical-code C/A pairs range from −40.75% to +22.21%. For the no-empty fixture, the candidate's direction changes with the baseline used. These observations establish neither a consistent improvement nor a reliable generic-branch regression. No narrower runtime variant was introduced.

Both empty-string screens use two excluded warmup triplets, then the fixed orders ABC, BCA, CAB, ACB, CBA and BAC. The final preflight screen uses the recorded fixed per-bank orders and their reversals, with 16 warmups per arm/bank and 16 encodes per observation. The empty-string warmup triplets remain in raw evidence. Preflight warmup encode loops were not timed or included in observation arrays. Distinct timing boundaries and candidate effects must not be combined.

## Correctness and retained failures

All completed component checks match their output digests. The full three-corpus parser/lookup oracle is archived separately by the parent task; this timing archive does not contain its corpus report. These local screens exclude browser persistence, media payload import, complete import/UI time, and browser memory qualification.

Two empty-string archive-reader setup attempts failed before any observation: a Uint8Array ZIP reader reported a split archive, and a dense-only reader returned null. Their logs remain intact. The successful fixed screen uses the production-style BlobReader fallback; fixture bytes and fixed schedules did not change. The initial JMdict wrapper failure likewise records zero observations in `jmdict-preflight-screen.json`.

The scanner's focused run passed 320 of 322 tests before two existing exhaustive differentials exceeded the default five-second timeout. The two timed-out tests passed with a command-line 120-second timeout; both receipts are retained. The initial uncapped lint attempt exited 137 without a file capture. A capped same-config attempt reported two hexadecimal-literal style findings, subsequently changed to equivalent Unicode literals in the published test file. Its original diagnostic log is retained. The timing-source bytes are unchanged by those test edits.

A summary-file write briefly failed with ENOSPC after the final native run had already completed. The complete raw report was preserved; the summary was regenerated without repeating measurements.

## Archive verification

`MANIFEST.json` lists every original member's byte count and SHA-256, including exact executed runners for both completed empty-string screens and both preflight screens. Reports which embed a runner hash were checked against the archived runner before packaging. Files were copied byte-for-byte; original JSON and logs were not normalized. Summary percentages can be recomputed from the retained observations. The original initial preflight report does not embed its runner hash.

The archived `SUMMARY.md` preserves the original packaging text. Its general
statement about warmup retention is qualified by the distinction above; no
measured preflight observation was omitted.

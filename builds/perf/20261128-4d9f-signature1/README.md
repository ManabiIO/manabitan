# Implicit content metadata allocation

This candidate combines two bounded metadata representations: an implicit MBR6 first signature word and an implicit uniform dictionary-name prefix with a zero capacity tail. Each has an exact fallback to physical Uint32 storage. It preserves full logical metadata values, byte equality and persisted formats.

The combined runtime is `55e87bc64c9b043a91f1d075f0324d3176c18c9a`, against frozen parent `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`. Remote runtime `6a05b649de2bf220b21f5365902c76d78d1cde29` has the same complete tree, `dffcaebec8348865266875264ffc7c6ee7e4da3b`; its receipt is retained under `reports/remote-runtime-source.json`. Later helper/evidence commits are accepted only when the frozen runtime source trees and every required source/asset hash still match.

## Qualification status

Combined focused validation passed all 275 tests in seven metadata/publication/canonical suites under Node 22.22.0. The candidate also passed the real release-package comparison: exactly five intended entries changed, with a 2,398-byte ZIP increase including a 458-byte native asset increase; all other entries match the parent exactly. Independent source review found no blocker in optional-column transitions, alias ordering, rollback or the defensive signature snapshots.

All six fresh combined acquisitions passed on their first attempts under the fixed protocol in this directory. Every parser output, lookup payload, record field, envelope, normalized persisted file and independently decoded logical metadata property matches the corresponding parent and retained complete oracle. The helper source was frozen at `434855c698d82ac336d37be63397d29d4936e6ec`; its fifteen independent contracts and scoped lint/formatting checks pass. Two helper-only lint style failures are retained with the successful correction.

| Corpus | Rows / groups | Native S1 backing avoided | Dictionary-name backing avoided | Total retained backing avoided |
|---|---:|---:|---:|---:|
| JMdict | 528,299 / 12 | 2 MiB | 2 MiB | **4 MiB** |
| Jitendex | 436,555 / 22 | 2 MiB | 2 MiB | **4 MiB** |
| VNDB | 6,648,310 / 170 | 1 MiB | 0 | **1 MiB** |

S1 stays implicit in every group of all three corpora. Dictionary-name IDs remain implicit throughout JMdict and Jitendex, with final prefix value 1 and ends 362,032 and 363,243 respectively. VNDB materializes its ordinary physical dictionary-name column in the second group; the preserved prefix state is value 1/end 822. The verifier records that fallback and claims no dictionary-name allocation saving for VNDB.

The compact result is in `reports/combined-columns-55e87bc/summary.json`; complete comparisons and per-group allocation receipts are retained in `combined-columns-raw.tar.gz` under `corpus`. Broad unit/type validation is reserved for the separately integrated current-base source after upstream `f28c2801`; this frozen corpus evidence is not relabeled as validation of that later integration. No browser-memory or whole-import speed result is claimed here.

The independent first-signature candidate already proved a 2 MiB retained backing reduction for JMdict and Jitendex and a 1 MiB reduction for VNDB, with complete output parity. The independent dictionary-name prefix candidate proved a further 2 MiB for JMdict, with twelve contiguous publications and no materialization. These remain separate observations. They do not establish a dictionary-name saving for Jitendex or VNDB, where changing compression dictionary names may correctly allocate the ordinary physical column.

## Complete verification

The portable helper is [`test/perf/signature1-corpus-verification`](../../../test/perf/signature1-corpus-verification); the directory retains its original name. Its README documents two source checkouts, normal library builds, Node 22.22.0, pinned archives, fixed resource limits and exact A/B commands. Expand `verification-oracles.tar.gz` into this evidence directory first. Every member is pinned by size and SHA256 in `verification-oracles-index.json` and the verification manifest.

The helper uses actual source grouping, compressed parser handling, source size/CRC validation, the ordered public term sink, four real codec workers, the selected real index worker and a bounded filesystem-backed Node OPFS adapter. It hashes complete parser outputs, lookup payloads, record fields, final envelopes, persisted files and every logical canonical metadata property. Final-file normalization is confined to independently linked random generation IDs.

For the candidate, the oracle independently decodes signature marker 2 to literal `0x3652424d`. It reconstructs an absent dictionary-name array from the recorded prefix and zero tail, without calling product getters or materializers. The metadata property inventory must equal the baseline plus exactly the two new scalar properties. Those scalars are validated and retained in each group's allocation receipt, including after physical materialization. The comparison separates native/S1 backing from dictionary-name backing and reports their observed total.

All three corpora must match their complete retained file-and-metadata oracles. JMdict additionally preserves the original per-group field/lookup/envelope checks. VNDB preserves independent full-corpus grouping and media-reference/directory checks. Its 146,725 group media representatives comprise 146,570 distinct paths plus 155 repeated representatives.

| Corpus | Required complete oracle SHA256 |
|---|---|
| JMdict | `5a2d8167f046e313949af8005ed493b651d10a4de95bfc5a2de24699ec61a58e` |
| Jitendex | `16ea2af33a07c79d163d5c16cc73276940a9d5ab46776c0b2d300d70514ae6ff` |
| VNDB | `01aa55b3440a4bb5f6831a5e3c94eb20c2f7a672029824b00b31e3738043ea62` |

## Retained prior evidence and limits

`reports/signature-only-README.md`, `reports/signature-only-protocol.json` and `reports/signature-only-verification-manifest.json` preserve the earlier S1 qualification. The original raw observations, commands, helper sources, failures and validation are retained in `original-evidence.tar.gz` and `portable-validation-raw.tar.gz`, with per-member hashes. `combined-columns-raw.tar.gz` and its index preserve all six combined acquisitions, the frozen helper/profile, independent prefix proof, source and focused-test snapshots, and complete release-package checks, including the first package-check failure. Every one of its 143 members was read back and hash-verified after creation; no old acquisition was overwritten.

The allocation claim concerns owned array/native-memory backings. Resource RSS and elapsed times are diagnostic. Browser peak/settled process memory, whole-import latency, separate media persistence, settings UI, SQLite transactions, restart and lookup remain outside this component verification. Hosted studies are separate; their results must be reported under their own source and measurement protocol.

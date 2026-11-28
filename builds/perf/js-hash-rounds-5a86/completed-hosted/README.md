# Completed JavaScript large-hash qualification: STOP

The measured source is `baca22e773e835f6729d4fc5198f2445afac4535` against `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` in [original run 46107975597](https://github.com/ManabiIO/manabitan/actions/runs/46107975597). These are the six original, independently reviewed cohorts. This evidence publication changes no product, workflow, observations, thresholds or acquisition policy. No PR is proposed.

Every host's descriptive interval includes zero. Both JMdict estimates are small; Jitendex does not establish a replicated advantage; VNDB estimates have opposite signs. The earlier cold-only component saving of approximately 1.75–2.23 ms remains component evidence, with its mixed prescribed warmed results and tiering caveat retained in the existing handoff.

Negative percentages favor the candidate. AB and BA identify independent hosts with opposite initial order; they are not pooled. Same-code movement is reported separately and is not subtracted.

| Dictionary / host | Paired median | Equal-work total | Descriptive 95% interval | Faster pairs | Same-code median | Memory screen |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| jmdict-AB | -0.6263% | -0.5246% | [-2.6827%, +1.4133%] | 7/12 | +0.4702% | Pass |
| jmdict-BA | -0.9220% | -0.2342% | [-1.5518%, +0.7553%] | 8/12 | +0.5279% | Pass |
| jitendex-AB | -0.0654% | +0.4277% | [-1.8954%, +3.2488%] | 6/12 | -0.7600% | Pass |
| jitendex-BA | -1.0980% | -1.1176% | [-2.0281%, +0.1982%] | 8/12 | -2.1942% | Pass |
| vndb-AB | -1.2317% | -0.6427% | [-2.4201%, +0.4322%] | 8/12 | -0.7426% | Pass |
| vndb-BA | +1.4705% | +1.0767% | [-1.2849%, +3.9887%] | 4/12 | +3.5263% | Unqualified coverage (0/4) |

Each host retained twelve candidate pairs, four same-code control pairs, four warmups, two exhaustive-media imports and four separate sampled-memory imports: 42 complete semantic imports per host, 252 overall, with 2,183 raw memory scans. All semantic receipts, default-policy checks, source/package bindings and full media checks passed. Five memory cohorts qualified. VNDB BA retains all four coverage failures: maximum covered-scan gaps B1 = 268.173684 ms, A1 = 277.503958 ms, A2 = 263.562157 ms, B2 = 307.072375 ms against the unchanged 250 ms bound. Its zero qualified pairs and null aggregate PSS/private deltas are preserved; this does not establish a memory regression or a memory pass. The original overall workflow and that cell remain failed.

The timer spans browser file-input change through the post-UI import-complete event. Physical display paint is outside this endpoint. There are no replacements, filtered tails, retries, control subtraction or cross-host pooling. The unchanged seed 897 / 10,000 resamples produce the descriptive intervals.

## Offline verification

From the repository root, use the unchanged reviewed verifier for each compact original cohort:

```sh
python3 -I -B dev/perf/verify-js-hash-cohort-5a86.py --evidence builds/perf/js-hash-rounds-5a86/completed-hosted/hosted-jmdict-AB.json.txt --source-proof builds/perf/js-hash-rounds-5a86/completed-hosted/source-proof.json.txt
```

Repeat with the five other explicitly listed `hosted-*.json.txt` files in `evidence-index.json`. This verifies original receipts, schedules, clocks, all memory observations, source/observer bindings and recomputed statistics. `PASS` means that the retained evidence is faithful; it preserves the failed VNDB BA memory qualification.

Each wrapper preserves 313 of 315 original artifact members exactly, omitting only the two product ZIP payloads. The original artifact ZIP is also omitted. All package member hashes and the exact JS hash module plus unchanged native C/WASM members for both arms are retained and Git-bound. The complete original packages were checked before compact preservation. Supply `--original-artifact /absolute/path/to/original-artifact.zip` to repeat the omitted byte checks; without it the compact verifier explicitly reports that limitation. All six original artifact IDs, sizes and SHA256 values are in `evidence-index.json` and the individual wrappers.

The partial offline Git proof contains 48 raw commit/tree/blob objects resolving 38 exact source paths. It is not a full repository or ancestor history. The verifier rejects unsafe Git paths, disabled assertions, altered retained members and false completeness claims, and loads only isolated, verified helper files. It is byte-identical to the reviewed 9db55be8 verifier; the original per-host auditor remains f2da37b2.

## Review and recovery history

`reviews.tar.xz` and `review-manifest.json` retain the independent six-host numerical review, its earlier checkpoints and original preparation-only failure, the root verifier/adaptation review and negative checks, per-cell preservation commands, reset/recovery records and final run/job metadata. Every retained member is listed by exact length and SHA256. The six-host review rederives every candidate/control ratio, tail, median, equal-work total, bootstrap interval and memory disposition; it proposes no pooled effect.

One original local reviewer timestamp file remains unavailable after the transient filesystem reset: root `commands.json`, 3251 bytes, SHA256 `960e4a60e68a768ea1f1e532ef928503e05fbea7f52e583d5f44d0e9baf93a61`. The other 14 original root review files were recovered exactly against their pre-reset identities. The lost file is not a CI observation. Original CI ZIPs/logs were recovered by exact recorded hashes; all original measurements remain preserved. Newly labelled recovery command receipts are not replacements for the absent historical timestamp file.

The earlier source-validation checkpoint remains unchanged in `../source-validation-checkpoint`; it includes full units, all four type scopes, JS lint, native reproduction, observer checks and seven dry builds. Existing cold-component evidence and local failures remain unchanged at the measured source and in the earlier handoff.

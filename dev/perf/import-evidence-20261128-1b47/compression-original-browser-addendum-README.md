# Original compression-level browser trial: failed active cohorts and complete control

**The original JMdict and Jitendex trials stopped during the first warmup comparison and produced no measured candidate pairs.** Their declared storage increases passed, but the unchanged matcher rejected a remaining output-digest difference. The complete VNDB zero-delta control passes its original semantic and memory gates with inconclusive timing. These results establish no compression-level whole-import speedup.

This archive preserves **all 326 original non-package members across the three artifacts: 30 raw reports, 30 raw canonical receipts, 30 labeled comparison receipts, 30 storage-policy audit records, and all 418 memory scan rows**. The count includes only two reports from each failed active corpus and 26 from the completed control. Missing observations remain missing. No timing statistics are synthesized from the failed warmups.

The fixed result cutoff is **2026-11-28 08:15:43.101179 UTC**. The retained final-status metadata snapshot was read separately at **08:13:35 UTC**. This packet covers only the original frozen trial. Any corrected harness, proposed validation design, new registration, or later acquisition is outside its membership and cannot retroactively qualify these failures.

## Frozen source and comparison policy

| Binding                           | Exact identity                                                                |
| --------------------------------- | ----------------------------------------------------------------------------- |
| Baseline                          | `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`                                    |
| Original frozen candidate         | `f7980e638ea1808701ac28339987663fd8b3dc4e`                                    |
| Only differing packaged entry     | `js/dictionary/zstd-term-content.js`                                          |
| Actual candidate runtime Git blob | `9a63ef28bcf862108c407c5636eb492009ba815f`                                    |
| Actual candidate runtime SHA256   | `e4f3858167076d76c6ad4729afb26ba637530fe9edd6c966fe2a86f6fa856de5`            |
| Runtime size                      | 41,823 bytes                                                                  |
| Original Actions run              | [46108665276](https://github.com/ManabiIO/manabitan/actions/runs/46108665276) |

The one-constant change sets the trained JMdict-dictionary compression level from −1 to −2. The generic compression level, worker count, block budget, format, and read path remain unchanged. The source-bound audits verify both actual package inventories and the single differing entry; the failed active-corpus audits also bind the runtime Git blob above.

Before acquisition, the separate frozen policy declared exact candidate-minus-baseline content-file and complete-storage deltas: **+312,404 bytes for JMdict, +750,018 bytes for Jitendex, and zero for VNDB**. It also required no more than a 2% increase in complete persisted bytes. The policy creates a labeled comparison copy that adjusts only the candidate content-file and complete-storage byte counts by the declared exact delta. Original reports, canonical receipts, and the original matcher remain unchanged. A/C and within-arm comparisons retain strict equality.

The exact original policy sources are retained:

| Tool                            | SHA256                                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| Frozen compression-study driver | `7fe216453d56094cb94a2504915efcbc64e08b5a3c99be25ca206b435b094d98` |
| `compression_receipts.py`       | `7512dd8f4422fc01fe094eb49dcccc4a3f8a80cb9dbf8fc2e37b8b00e1f68bb8` |
| Original policy tests           | `ffc48b76a565eccb100fc0fa1a9f7d5f355b087bc6c6199ad2a58639ca47789d` |

The earlier frame-level compression/decoding experiments and their fresh-versus-retained-context limitations are in the [immutable session evidence](https://github.com/ManabiIO/manabitan/tree/0df239a1be2cde2fc8586665413b7da7845f9fb6/dev/perf/import-evidence-20261128-1b47). Those component observations did not establish first-import behavior. This packet does not use them to replace the failed browser comparisons.

## JMdict and Jitendex: exact failure boundary

Both original active-corpus artifacts contain the first baseline warmup and the first candidate warmup. Their individual raw validations pass, including their own sampled lookup/readback and restart checks. Only the baseline warmup was appended to the schedule log; the candidate comparison failed before it could be appended.

| Original corpus | Raw reports / canonical receipts | Comparison / policy records | Measured pairs / controls | Exhaustive media / memory imports |
| --------------- | -------------------------------: | --------------------------: | ------------------------: | --------------------------------: |
| JMdict          |                            2 / 2 |                       2 / 2 |                     0 / 0 |                             0 / 0 |
| Jitendex        |                            2 / 2 |                       2 / 2 |                     0 / 0 |                             0 / 0 |

Neither artifact contains a primary `analysis.json`. No failed warmup duration is promoted into a measured pair. The original stop-on-first-failure policy and incomplete status are preserved.

The exact storage policy succeeds in both failed comparisons:

| Corpus   | Baseline complete storage | Candidate complete storage | Exact increase | Baseline content file | Candidate content file |
| -------- | ------------------------: | -------------------------: | -------------: | --------------------: | ---------------------: |
| JMdict   |              43,520,477 B |               43,832,881 B |     +312,404 B |          19,566,680 B |           19,879,084 B |
| Jitendex |              67,466,332 B |               68,216,350 B |     +750,018 B |          38,386,795 B |           39,136,813 B |

These complete-storage increases are approximately **0.718%** and **1.112%**, respectively, within the original 2% ceiling. Those denominators are the actual browser complete-storage receipts, not only the content file or an earlier component replay.

After the two allowed byte-count adjustments, the comparison copies still differ at the sole canonical path:

```text
common.validation.outputDigestSha256
```

The unchanged matcher reproduces this exact rejection for each corpus:

```text
ValueError: cross-observation common differs from the required value
```

This is not a storage-budget rejection. It also cannot be converted into complete semantic qualification by deleting or normalizing that digest after observing the failure.

The frozen harness builds this diagnostic digest from probes that include physical content representation information, such as raw-content previews and entry offsets/lengths, alongside sampled output data. It therefore is not an assumed invariant of decoded semantics alone. Independent source review traces the raw preview through the frozen diagnostic read path. The exact unhashed probe preimages were **not retained** in these artifacts, so the precise differing input cannot be reconstructed and no single underlying cause is proved. In particular, the offscreen diagnostic shape differs from the local shape; this packet does not assert that a particular total-length field changed in these actual probes.

The retained sampled lookup outputs and their hashes supply a separate, limited check. They do not prove that every decoded definition is equal across arms, and each run's successful pre/post-restart check does not establish cross-arm digest equality. The original raw receipts, both digest values, comparison copies, policy audits, and failure remain intact for review.

## VNDB: complete original zero-delta control

VNDB completes the original four excluded warmups, six alternating AB/BA candidate pairs, two interleaved identical-code A/C pairs, two exhaustive-media imports, and four instrumented-memory imports: 26 reports in total. Every comparison receipt equals its unmodified raw canonical receipt because the registered storage delta is zero.

Timing and exhaustive-media imports use the frozen harness. The four memory imports use the registered marker-only overlay. No product overlay or unregistered harness change is introduced. The original primary timer runs from file-input change through post-UI completion in a fresh profile; restart/readback and separate memory imports lie outside it. VNDB keeps the explicit prospective allocation policy of 37 units of 4,096 bytes.

Negative timing changes are faster. These are the original six candidate pairs and two identical-code controls:

| Statistic                              |            B/A candidate |       C/A identical code |
| -------------------------------------- | -----------------------: | -----------------------: |
| Paired median change                   |               −1.936652% |               +1.235974% |
| Equal-work change                      |               −0.878152% |               +1.243094% |
| Descriptive 95% paired-median interval | [−5.556063%, +5.187766%] | [−0.552196%, +3.024144%] |
| Faster pairs                           |                    4 / 6 |                    1 / 2 |
| Worst pair                             |               +7.947673% |               +3.024144% |

The candidate interval crosses zero, and every unfavorable observation remains included. The original descriptive bootstrap uses 10,000 complete-pair resamples with seed 897. No control subtraction, cohort pooling, replacement observation, or changed threshold is used. With only two control pairs, their descriptive interval is not an independent population estimate.

All 26 original source-bound semantic, storage, media/readback, and restart receipts pass. The complete four-observation memory screen passes, with **418 raw scans** retained. Sampled private median/maximum paired changes are **−0.685621% / −0.339955%**; sampled PSS changes are **−0.640677% / −0.360585%**. These are non-atomic process-tree samples and sampled maxima, not exact peaks.

The passing zero-delta control does not qualify either failed active corpus. Its inconclusive timing does not establish a compression-level speedup, and the source-bound receipts do not claim exhaustive byte equality for every persisted definition.

## Actual audit versions and preservation methods

The complete 26-receipt auditor was intentionally not used to fabricate absent active-corpus observations. Each artifact retains the exact verification source actually used:

| Artifact         | Actual auditor SHA256                                              | Verification scope                                                                                                                         |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Partial JMdict   | `f689de9f62a5074ab293961e609b5f299abe5612630a3bb1472f2d73b9156426` | Two individual raw/comparison/policy receipts, original package/source identities, exact reproduced failure and absent later stages        |
| Partial Jitendex | `3dfd66926441d54d853541007330036234ebd8950b75da883c80864755adb89a` | Corresponding two-receipt original failure, exact artifact/source binding and absent later stages                                          |
| Complete VNDB    | `cabb2ce37ebd2eb1b5d78f5e38703b4083647ad05f572095a25dc16a028b8eb6` | All 26 raw/comparison/policy receipts, 20 source-bound schedule clocks, full primary analysis, memory scans and original final gate status |

All three audits verify the complete original outer ZIP member inventory, actual package bytes/maps, baseline and candidate identities, and frozen validator/policy source hashes. The partial auditors reproduce the original matcher rejection without removing a field or changing a policy. The complete auditor preserves raw canonical receipts and independently recomputes each original comparison copy and policy audit. Its source/clock/schedule/status guards and independent static review remain retained.

The preservation-only partial stager is a separately reviewed derivative of the unchanged complete-cohort stager. It requires missing primary analysis and zero measured/control/media/memory observations, retains all original receipt forms, and records an incomplete failed trial. It checks bytes and counts, not semantic repair or qualification. Its exact base/derived/patch identities and independent review are included. The original complete stager preserves all 256 non-package VNDB members, including the 52 additional comparison/policy records.

The original cohort staging prefixes remain:

```text
evidence/pending-studies-raw-addendum-20261128-1b47/cohorts/compression-jmdict/
evidence/pending-studies-raw-addendum-20261128-1b47/cohorts/compression-jitendex/
evidence/pending-studies-raw-addendum-20261128-1b47/cohorts/compression-vndb/
```

Each `raw/` directory preserves every original artifact-relative non-package member, including HTML reports. Stable result/audit directories are retained under `snapshots/`; exact auditors, baseline validators, and original policy sources accompany them. Later independent reviews are separately identified. No payload symlink is followed. Original artifacts were restored by exact SHA-verified download when needed; verification and packaging do not acquire or substitute browser observations.

## Exact artifacts and omissions

| Original artifact                                                                                            | Original bytes | SHA256                                                             | Retained members |
| ------------------------------------------------------------------------------------------------------------ | -------------: | ------------------------------------------------------------------ | ---------------: |
| [JMdict 15254590844](https://github.com/ManabiIO/manabitan/actions/runs/46108665276/artifacts/15254590844)   |     33,604,921 | `739c895cafc5213c499dc9097a27b16a4505de7767dc6ed010fbdffe82f9c9fd` |          35 / 37 |
| [Jitendex 15254224397](https://github.com/ManabiIO/manabitan/actions/runs/46108665276/artifacts/15254224397) |     33,606,454 | `62e914561bafd64dac05adcdb28faf118cde52d791b59ac6d0228b061eab5669` |          35 / 37 |
| [VNDB 15255446077](https://github.com/ManabiIO/manabitan/actions/runs/46108665276/artifacts/15255446077)     |     35,200,454 | `ec6a0611b77e0c250430a8410818af1244b485d7181a98c5a2b917c246d8fbb3` |        256 / 258 |

The only omitted original members are duplicate complete extension packages. Every listed package is 16,805,714 bytes:

| Original member          | SHA256                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `jmdict/package-A.zip`   | `65e2c113ad618e57ade7cdc53eb515cdd5541b5855126962f8587b96c4745599` |
| `jmdict/package-B.zip`   | `1915201b691109e7c883501aed2cb9748dbf34c39261e44fabf9f0bac8fa495c` |
| `jitendex/package-A.zip` | `6eee3e01540f3cd35c19c981c32a63b843f32e0a1d6d5736e459842f917e3d57` |
| `jitendex/package-B.zip` | `5bc4c4637d3c241dcaebc9ca8ceaf2cf0faadb87206c2c230d1cdb98321ee0e2` |
| `vndb/package-A.zip`     | `7da645321c3226fa7f623f4735daef01a7d4cd94490dcc06467fbd7756272b56` |
| `vndb/package-B.zip`     | `b92af3581be2119065e51dce016612ba2f274e5aaa9341fceac84b8747d98de6` |

Staging independently streamed and rechecked each omitted package's exact member digest from its verified original outer ZIP. Complete package inventories remain in the audit records. The outer ZIP containers are omitted because all non-package members are preserved individually. Repeating full package/container-byte verification requires the exact original Actions ZIPs; rebuilt extensions are not claimed to reproduce container timestamps or bytes. Large dictionary/media inputs and frame-capture payloads are not duplicated here.

## Verify and inspect

Download this README, `compression-original-browser-addendum-20261128-1b47.tar.gz`, its `.manifest.json`, and `.sha256` from the same immutable evidence commit. Verify before extracting into a new directory:

```sh
sha256sum -c compression-original-browser-addendum-20261128-1b47.sha256
tar -xzf compression-original-browser-addendum-20261128-1b47.tar.gz
python3 evidence/durable-bundles/package-evidence-v2.py \
  --verify-manifest compression-original-browser-addendum-20261128-1b47.manifest.json
```

The external manifest hashes every member's exact safe path, byte count, and content without a self-hash exception. Gzip timestamps and tar metadata are normalized; original payload bytes remain unchanged. The verifier checks the complete archive hash, exact member set, sizes, and all member hashes.

To repeat an original partial audit, obtain the exact corresponding ZIP, place a checkout at the pinned baseline in `manabitan/` beside the extracted `evidence/` directory, and use new extraction/output destinations:

```sh
python3 evidence/audit-compression-jmdict-partial-failure-1b47.py \
  --archive compression-level-1b47-screen-jmdict-15254590844.zip \
  --extract /path/to/new-jmdict-partial-extraction \
  --output /path/to/new-jmdict-partial-audit.json

python3 evidence/audit-compression-jitendex-partial-failure-1b47.py \
  --archive compression-level-1b47-screen-jitendex-15254224397.zip \
  --extract /path/to/new-jitendex-partial-extraction \
  --output /path/to/new-jitendex-partial-audit.json
```

Those artifact-specific scripts bind the original ZIP sizes and SHA256 values in their source and preserve the expected failed result. To repeat the complete VNDB control audit with new destinations:

```sh
python3 evidence/audit-hosted-compression-artifact-1b47.py \
  --archive compression-level-1b47-screen-vndb-15255446077.zip \
  --expected-sha256 ec6a0611b77e0c250430a8410818af1244b485d7181a98c5a2b917c246d8fbb3 \
  --dictionary vndb \
  --baseline-root /path/to/checkout-at-9e10d3b3 \
  --extract /path/to/new-vndb-compression-extraction \
  --output /path/to/new-vndb-compression-audit.json
```

No command here reruns a browser or qualifies a repaired comparison. A later corrected experiment must retain its own source identity, registration, evidence, and decision boundary independently of these original failures.

# Current CRC browser study — HOLD

The single CRC loop-unroll pragma is not ready for a product PR. All three original artifacts pass the unchanged source, package and semantic audit. The complete elapsed results do not show a useful gain across the requested dictionaries, and the JMdict memory coverage gate remains unqualified.

The table reports all 12 treatment pairs per corpus; negative changes mean faster. Each corpus has four separately reported identical-code control pairs. Intervals are the frozen descriptive bootstrap intervals, not a cross-host guarantee.

| Dictionary | B/A median | Median B−A | Descriptive 95% interval | Faster pairs | Equal-work change | A/A median | Median C−A | Memory |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| jmdict | +1.628% | +14.9 ms | [-0.525%, +2.850%] | 4/12 | -0.496% | +0.483% | +4.3 ms | Unqualified B1 coverage |
| jitendex | +2.368% | +27.5 ms | [-0.090%, +3.349%] | 3/12 | +2.089% | -0.683% | -8.2 ms | Qualified |
| vndb | -0.234% | -11.6 ms | [-2.297%, +1.805%] | 6/12 | -1.028% | -3.298% | -171.4 ms | Qualified |

JMdict retains every observation, including pair 10 (A 1117.7 ms, B 918.6 ms, difference −199.1 ms). That pair explains why its equal-work result is negative while its paired median is positive. No outlier was dropped. Jitendex’s affected inflation counter is slower in all 12 treatment pairs; its median phase change is +10.234%. VNDB retains its −600.5 ms pair 7 and the substantial movement in identical-code controls. None of these controls is subtracted from treatment.

JMdict B1 has a 349.048089 ms gap between covered scans, above the unchanged 250 ms limit. A process-tree change and unreadable newly discovered zombie process caused one scan to be rejected. Pair 1 is unqualified; pair 2 qualifies (+0.8334% PSS, +0.8708% private). This coverage failure is retained and is not described as a measured memory regression. Jitendex and VNDB pass their memory screens.

## Frozen identities

- Baseline: `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`.
- Candidate: `19db774b564064a7e339d3c3a79ea8da04ab48b5`, runtime tree `6f6c0ba610392f6ae6aa6df5c826e3d677f6f1af`.
- Study: `477fb271ef25fac533fb1faf737a5dab898190e3`, tree `f4b08d4dfc6f2493336a5318c20c4f2b64b90593`.
- [Original run 46127721419, attempt 1](https://github.com/ManabiIO/manabitan/actions/runs/46127721419). The overall failure includes the preserved JMdict memory qualification failure; the Jitendex and VNDB jobs succeeded.
- Frozen auditor SHA-256: `b9fa8c952d63e712cad908a58a5d1e0d71d0b25d5ffd0927203255e71d306cf5`.

## Evidence and retention

Each corpus directory contains its original CI audit and the separately executed local audit, unfiltered absolute pair differences, original-member census, API run/job/artifact receipts, full decoded hosted job log, and local stage logs. All three local audits are byte-identical to their original CI counterparts and validate 42 receipts each. The complete observations, failures and original CI audit are preserved inside each reconstructed archive.

The reconstructed archives omit only the exact audited `package-A.zip` and `package-B.zip` members. Every other original member byte is rehashed against the full original census; ZIP metadata is normalized. Original outer sizes and SHA-256 values, omitted package hashes and package-entry maps remain retained. The complete original ZIPs and both package ZIPs remain available locally. Repeating the full package-byte audit requires those original packages; the compact archive is not represented as the original outer ZIP.

The new acquisition and retention wrappers analyze existing observations only. No measurement, source or protocol was rerun or changed. Source-gate artifact uploads are not duplicated here. Full decoded hosted logs are preserved verbatim as UTF-8; this does not claim the original HTTP transfer bytes.

See [decision.json](decision.json) for all exact summaries and links, [JMdict](jmdict/local-independent-audit.json), [Jitendex](jitendex/local-independent-audit.json), [VNDB](vndb/local-independent-audit.json), and the [retained-member verification](provenance/retained-member-verification.json).

## Interpretation limits

Each corpus uses one independent AB-start host. There is no host pooling, control subtraction, observation replacement, timing trim or coverage imputation. Worker phase counters overlap ordinary elapsed clocks: immediate CRC is inside inflation, deferred CRC is inside parsing. Phase counters are not added together or presented as isolated CRC timing. Earlier component studies and older baselines remain separate.

The scoped open-PR search found no identical CRC pragma among its matching inspected patches. The evidence still supports HOLD; there is no product PR for this candidate.

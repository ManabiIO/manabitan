# Import investigation: preserved controls and CPU attribution

This follow-up contains evidence only. The active ownership implementation remains
at `f65f4ef97ebf2f37a5b1b79ca7733d7b362ec963` in
[PR #820](https://github.com/ManabiIO/manabitan/pull/820). The experiments below
did not establish another runtime change worth promoting.

Download [evidence.tar.gz](evidence.tar.gz) and [manifest.json](manifest.json).
The archive keeps complete raw observations, fixed orders, identical-code
controls, candidate patches, source identities, native naming proof and recorded
failures. Internal Markdown links work after extraction. The separate
[verify-archive.py](verify-archive.py) checks the archive without extraction or
experiment execution:

```sh
python3 verify-archive.py evidence.tar.gz --manifest manifest.json
```

## What was learned

| Investigation | Observed result | Decision |
| --- | --- | --- |
| Compression-request batching | Current JMdict requests fell from 103 to 48, but the fixed 12-round A/B/C cohort had a paired candidate-minus-controls median of +3.154 ms (+4.24%). The candidate beat both controls in only 1/12 rounds. | No runtime promotion. This is a warmed Node codec component, not complete-import timing. |
| Aligned checksum word reads | First-pass paired median was -0.0366 ms (-0.1816%); the warmed pass was +0.6591 ms (+5.73%). Identical-code variation was larger than the cold difference. | No runtime promotion and no additional unchanged-cohort rounds. |
| Corrected canonical-sink profile | The actual parent ownership receipt adopted 101,143,281 content bytes. An earlier adapter's missing receipt had caused an extra cache copy outside its timed codec replay. | Retain the original observations and correction; do not attribute that adapter copy to production. |
| Compressed-source worker profile | All 53 JMdict banks, 528,299 rows and 12 policy-3 groups matched the immutable full-output reference. Samples located substantial decompression, CRC, scanner and native encoding work. | Diagnostic only: no comparison, predicted saving or browser-speed claim. |

The checksum experiment preserves all 36 exact input spans in a single nested
input archive. Its source index, including the original JMdict/EDRDG attribution,
is retained as `20261128-prior-work-and-provenance/JMdict-source-index.json`.

## Scope and provenance

All runtime experiments use baseline
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` and pinned source, fixture and native
binary identities. The complete native symbol proof includes a byte-identical
release rebuild and comparison of every noncustom WASM section with the named
build. Private functions are named only where that proof establishes the match.
The separate Zstd map identifies exact public exports; it leaves private code
unmapped and does not infer dictionary-setup cost from a caller's remainder.

The compressed profile preserves the two setup failures, original prospective
plan and source, the documented resource-only revision, all 13 CPU profiles,
external process-observer receipt and independent readback. No samples preceded
the recorded resource-plan revision. Inspector instrumentation and adapter work
are explicitly distinguished from product work.

The prior-work audit records existing owners and prior negative results so later
experiments do not silently repeat them. Source screens for metadata publication,
cache origins and the inflater are included. These source reviews are not
performance acquisitions.

## Archive layout

| Directory | Contents |
| --- | --- |
| `20261128-held-import-evidence/` | Original manifest, index and standalone nested verifier. |
| `20261128-compression-request-batches/` | Complete fixed cohort, source/capture receipts, validation failures and candidate patches. |
| `20261128-canonical-sink-profile/` | Corrected main-thread and four-codec-worker profiles, independent attribution and source screens. |
| `20261128-lookup-word-loads/` | Fixed cold/warm cohort, exact checksum inputs, controls, patch and validation receipts. |
| `20261128-native-symbols-83b3/` | Release/names binary pairs, toolchain identities, section proof and original decoded-input diagnostics. |
| `20261128-compressed-worker-profile-83b3/` | Complete compressed-source diagnostic, failures, resource plan and independent review. |
| `import-owned-columns-83b3-analysis-source/` | Offline hosted-artifact reader and diagnostic source. The reader had not run against hosted qualification artifacts when packaged. |
| `20261128-prior-work-and-provenance/` | Prior-work audit, Zstd export map, fixture attribution and cache-reclamation receipt. |

The outer manifest binds every payload's byte count, SHA-256 and Git blob SHA.
Existing nested manifests and raw reports remain byte-for-byte unchanged.
`CONTENTS.json` inside the archive excludes itself to avoid a self-hash cycle;
the external manifest additionally binds it and the complete archive. Packaging
runs no tests or benchmarks and changes no product source.

## Limits and qualification

Component CPU samples, helper timings and cumulative allocation savings do not
establish complete-import latency or peak-memory improvement. Qualification of
the ownership candidate is separate and remains tied to its exact runtime
commit and the frozen browser workflow. This evidence-only follow-up does not
change that protocol or turn pending browser gates into passes.

The original batch validation includes an unexpected test-worker exit followed
by an isolated passing native case. The checksum lint attempt ended with exit
137 after setup failures; it is incomplete. Full console logs for those early
validation failures were not originally archived, so the original recorded
receipts are retained without reconstructed output. No complete suite or browser
qualification is claimed for either rejected runtime candidate.

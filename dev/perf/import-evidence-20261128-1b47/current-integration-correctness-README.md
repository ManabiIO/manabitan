# Current-source import drafts: correctness and publication evidence

Both held import drafts passed the registered hosted correctness gates after
integration with `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`. PR
[#978](https://github.com/ManabiIO/manabitan/pull/978) now contains the same two-line
indexed score-key validation restoration on that common baseline. PR
[#979](https://github.com/ManabiIO/manabitan/pull/979) contains the CRC 8+4-byte tail
change combined with the current parser and newly reproduced native assets.
Both remain **open, draft, unmerged, and held on performance evidence**.

This packet preserves correctness preparation, every bounded local gate attempt,
the two complete original hosted artifacts, independent reviews, and the verified
draft-ref/body updates. It contains **no new import-performance acquisition**.
The older component and browser measurements remain attached to their original
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` baseline and study commits. Passing these
new gates does not transfer those measurements to the integrated sources or
resolve either draft's held performance disposition.

The downloadable files are
[the complete packet](current-integration-correctness-20261128-1b47.tar.gz),
[its member manifest](current-integration-correctness-20261128-1b47.manifest.json),
and [the checksums](current-integration-correctness-20261128-1b47.sha256).
All archive paths below refer to the extracted packet. Source and evidence files
retain their original workspace-relative paths and exact bytes. The two original
ZIPs were acquired under `/home/agent` and are deliberately retained under the
declared `original-artifacts/` directory below, with their original names and
exact bytes. Only tar/gzip metadata is normalized.

## Event times and the later preservation snapshot

These times identify different events. They are not interchangeable cutoffs.

| Event                           | Time in UTC                | Meaning                                                                                                      |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Hosted audit summary            | 2026-11-28 09:15:43.088821 | Both original artifacts had been read and their source, gates, and final cleanliness checked.                |
| Independent artifact review     | 2026-11-28 09:17:22.516298 | A separate reviewer compared the original ZIPs, source identities, recorded gates, and conditional skips.    |
| Independent ready-body review   | 2026-11-28 09:18:09.453534 | The new outcome paragraphs were checked against those artifacts and the earlier source/history review.       |
| Remote publication verification | 2026-11-28 09:18:55        | Root verified the leased draft-ref fast-forwards and exact published-body readbacks.                         |
| Evidence byte snapshot          | 2026-11-28 09:21:07.050351 | The 124 selected source/evidence files and both original ZIPs were copied and byte-verified for this packet. |

Some receipts were written after the events they describe. This packet does not
assert that all receipt bytes existed at 09:18:55. The wrapper, packaging checks,
and final archive seal occur after the evidence byte snapshot; their own receipts
record their actual times. The earlier preparation README is preserved unchanged,
including its then-pending statements. This wrapper supplies the subsequent
outcomes rather than rewriting that history.

The snapshot includes the published PR bodies before a later documentation-only
addition of this packet's immutable links. Future body-link additions, corrected
compression validation/browser outcomes, and any later performance work are
outside this packet.

## Exact integrated product sources

The common baseline is
[`dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`](https://github.com/ManabiIO/manabitan/commit/dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16),
tree `d911260f1a57f518d59b3a12127fcc3b2293c918`. It includes PR #972's compact
structured-glossary fast path and scalar-token end reuse. Each product integration
preserves the old draft head as its first parent and this common baseline as its
second parent.

| Product     | Integrated commit                          | Tree                                       | First parent, the prior draft head         |
| ----------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| Score, #978 | `dbaa4d72a5f6b4fcffeb92cefadb521e101df7df` | `4a632857a1250fd0a716f700f8d8997f7560cb68` | `b15bad43acdfd54d541895cac1109c0e5ba51b2f` |
| CRC, #979   | `961614e36859c529580fc034d6535ca89d119051` | `e7e454a7f019ed2201e4c66ce5db2e8b87218148` | `5909db31ebe859fce1cc4b38324271ddf9f3dd59` |

The exact changed-file sets relative to the common baseline are one file for
score and four files for CRC. The score runtime remains byte-identical to the
previous draft. The CRC C and test hunks were applied to the updated parser, then
the manifest and WASM were regenerated with pinned Clang/LLD 21.1.8. Reusing the old
CRC binary would have discarded the upstream parser changes.

| Product | Changed path                                     | Git blob                                   |
| ------- | ------------------------------------------------ | ------------------------------------------ |
| Score   | `ext/js/dictionary/term-record-opfs-store.js`    | `b17f72437f196aa1fd21b282c03f147aad7d633f` |
| CRC     | `ext/js/dictionary/wasm/term-bank-parser.c`      | `8580418076e7b0229b466644340dab649911882a` |
| CRC     | `dev/data/dictionary-wasm/manifest.json`         | `0c9570aeab5f9a003cd815ce1c0a286c715f3cc2` |
| CRC     | `dev/data/dictionary-wasm/term-bank-parser.wasm` | `dcbbca0b5ed4ec2f5348901e53cb25fcd085cb96` |
| CRC     | `test/term-bank-crc.test.js`                     | `eb968742aa8279b2bff81065dea56791caad6bf4` |

Both actual hosted artifacts contain the changed source bytes. Their audits and
the independent review bind each byte length, SHA-256, and Git blob to the exact
product commit, tree, ordered parents, and changed-file set. The CRC native
checkpoint is also retained under
`evidence/current-develop-integrations/crc/checkpoint-after-native-build/`.
Its current parser WASM is 69,352 bytes, SHA-256
`fbcf0f790ced310b93d2824d9d191402bb5496d8d6166be5ea1b4770a215ce81`.

## Registered correctness workflow and actual hosted results

The correctness-only workflow is frozen at
[`dc6edcc01a6b9f387fb33e80aa47833a29334d14`](https://github.com/ManabiIO/manabitan/commit/dc6edcc01a6b9f387fb33e80aa47833a29334d14),
tree `0e7fb55986fd90b780991ac5a9d04f0a997237ca`, with the CRC integration as first
parent and the score integration as second parent. Its sole file addition relative
to the CRC parent is
`.github/workflows/current-import-integration-gates-1b47.yml`, Git blob
`470d46e336c32f517075c03085d89da60cd89f25`, SHA-256
`c94be41ec1de28af2d2fd7bde82cf175b3dcfc210faf8de6581fd649ea7a28cf`.

The workflow ran as
[Actions run 46128395334](https://github.com/ManabiIO/manabitan/actions/runs/46128395334).
Each matrix arm checked out its exact product commit independently. The 12
recorded gate outcomes all succeeded in each arm: checkout; source binding;
toolchain setup; locked dependency setup; runtime/parser-asset identity; native
reproduction; full units; every build target; scoped lint; runtime types; test
types; and final source state.

| Exact product     | Hosted job                                                                                      | Test files passed | Assertions passed | Conditional skips | Result                                       |
| ----------------- | ----------------------------------------------------------------------------------------------- | ----------------: | ----------------: | ----------------: | -------------------------------------------- |
| Score `dbaa4d72…` | [140928007222](https://github.com/ManabiIO/manabitan/actions/runs/46128395334/job/140928007222) |               669 |            15,139 |                47 | All recorded gates and source checks passed. |
| CRC `961614e3…`   | [140928007473](https://github.com/ManabiIO/manabitan/actions/runs/46128395334/job/140928007473) |               669 |            15,140 |                47 | All recorded gates and source checks passed. |

The 669 count is **test files**, distinct from the 1,577 nested suites in each
machine report. The 47 skipped assertion identities are exactly equal between
arms: 46 conditional reversed DOM-text-scanner cases and one Windows-only process
cleanup case. The independent review checked their unchanged source conditions.
The native CRC, format-3, source-CRC-reuse, ZIP-CRC, and score-store critical files
executed their assertions; none of these critical files supplied the skip set.

Both jobs used Node 22.22.0, Clang/LLD 21.1.8, and locked dependencies. Native
`--check` reproduced both committed outputs. The canonical scanner SHA-256 is
`40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af`
in both arms. The score arm retained the common-baseline parser SHA-256
`5d216041823936521f8a70b721472fb8c42052d165d771a92b59ed967d8d2695`;
the CRC arm reproduced the candidate parser SHA-256 given above. Full units used
two workers; lint and type checks used a 4096 MiB heap cap. Initial and final
tracked trees were clean and the source commits unchanged.

These results complete the current-source correctness checks that could not all
finish locally. They do not erase the failed local attempts, and their execution
times are not import-performance measurements.

## All original hosted bytes are retained

Both complete original ZIP containers are included, together with every original
member extracted under its original name. There are **49 original members in
total**, 23 score and 26 CRC. No member from either artifact is omitted, filtered,
reformatted, or reconstructed.

| Artifact    | Original ZIP                                |   Bytes | SHA-256                                                            |
| ----------- | ------------------------------------------- | ------: | ------------------------------------------------------------------ |
| 15256363690 | `current-integration-46128395334-score.zip` | 594,268 | `f01eeef071ec4270402ad7b67bfcaa5396d8f7c431c7ea814a8260699aa4349e` |
| 15256493531 | `current-integration-46128395334-crc.zip`   | 588,674 | `d4a092506e3c6623f9f3deb490cbde998f879bfb3167037fb13dfc32e3acc2c1` |

The original ZIPs are under
`evidence/current-integration-correctness-20261128-1b47/original-artifacts/`.
Extracted members, full connector job logs, and each source-bound audit are under
`evidence/hosted-current-integration-46128395334/{score,crc}/`; each `raw/`
directory contains the exact original member tree. These include complete
`unit-results.json` and unit logs, native and toolchain receipts, source files,
registered workflow bytes, build/lint/type logs, the recorded gate statuses, and
initial/final source proofs. The whole job logs are additional evidence, not
substitutes for the original artifact members.

The staging helper verified both original archive SHA-256 values and byte lengths,
all member names, member lengths and SHA-256 values, and exact equality to every
already-extracted raw file. The external packet manifest separately enumerates
and hashes every retained file. Packaging performed byte preservation checks only;
it did not rerun correctness gates, imports, or the source/gate auditor.

## Local attempts and reader corrections remain visible

The unchanged preparation record is
`evidence/current-develop-integrations/README.md`, SHA-256
`335894c86e7cac1e1e8a177fbc2a16ec3e0a288ca71a332dbc3fd89f1db1a385`.
All 55 files from that preparation set are retained, followed by five explicitly
classified later outcome/publication files. The earlier README's pending wording
describes its earlier checkpoint; the later receipts and this wrapper describe
what subsequently happened.

The CRC candidate passed local pinned native reproduction, candidate native
generation/check, library build, 83 tests across four focused suites, all-target
build validation, scoped lint, main TypeScript, and diff checks. The score
integration received local source-identity/diff checks before hosted validation.
Every incomplete broad CRC attempt remains in the packet:

| Local attempt                         | Recorded outcome        | Limit and evidence                                            |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------- |
| Full units, two workers               | Exit 137 after 42.728 s | 768 MiB V8 cap; 34 completed suite lines; no completion JSON. |
| Test TypeScript                       | Exit 134 after 11.470 s | Explicit V8 heap-limit OOM at the 768 MiB cap.                |
| One larger-heap test-TypeScript retry | Exit 137 after 13.242 s | 1536 MiB cap; no type diagnostics or completed gate.          |
| One single-worker full-unit retry     | Exit 137 after 77.874 s | 768 MiB cap; 38 completed suite lines; no completion JSON.    |

The causes of the exit-137 terminations are unproven. Only the 768 MiB
test-TypeScript attempt explicitly identifies a heap OOM. Partial suite output is
not a full-unit pass. No failed log or assertion was replaced or weakened.

The first independent hosted artifact-reader attempt also remains visible. Its
initial implementation assumed the individual assertion status would be
`"pending"` because the aggregate field is named `numPendingTests`. The original
reports actually contain 47 individual `"skipped"` statuses. That attempt stopped
before writing any audit or extraction. The corrected reader requires and counts
the actual exact status string; it then verified both complete original
artifacts. No hosted output, source, workflow, gate, or observation changed or ran
again because of this reader correction. The initial source and explanation are
retained as:

- `evidence/audit-current-integration-gates-1b47.initial-pending-status.py`
- `evidence/hosted-current-integration-46128395334/audit-initial-status-assumption.txt`
- `evidence/audit-current-integration-gates-1b47.py`, the successful reader.

The first packaging-only staging attempt also stopped before copying evidence:
its 55-file historical-preparation guard detected newly appended publication and
outcome files. The revised stager explicitly classifies and retains the original
55 files and all five later files. Its original source, failure explanation, and
successful later snapshot receipt are preserved. This was a preservation guard,
not another gate, source change, or observation.

## Independent review and verified draft publication

The packet retains separate layers of review rather than treating publication as
validation:

- `evidence/current-develop-integrations/prepared-pr-source-history-review.json`
  checks the integrated source/history and earlier prepared-body claims.
- `evidence/current-integration-hosted-independent-review-1b47.json` independently
  reads the two original ZIPs, exact source/native bytes, gate records, complete
  assertion counts, final cleanliness, and unchanged conditional skip identities.
  Its SHA-256 is
  `4488d2c69c14584d2099ab60e2b9d544db5acd1f82ea65c8fefc00fb73120734`.
- `evidence/current-develop-integrations/current-ready-pr-outcome-review.json`
  checks the actual later result paragraphs against those artifacts and the
  earlier body review. Its SHA-256 is
  `70048436333be716a65d3d2c9b93723707b5332ce07b741b1f3e08e4413fd348`.
- `evidence/current-develop-integrations/root-product-publication-complete.json`
  records root's leased fast-forwards, unchanged draft/open/unmerged states, exact
  heads and file counts, and exact remote body readbacks at 09:18:55 UTC. No
  `develop` ref was changed and no force push was used.

The published body snapshots retained here are
`score-pr-body-current-ready.md`, SHA-256
`ec350daa863af35f512dd94647ce5e9eaa8a2456aebdbc8b9b839ea6013e4aff`,
and `crc-pr-body-current-ready.md`, SHA-256
`e2da1888b42e41360f557fb08e63d947d3f30a0a433d5f573b2834ce24c2a92e`,
both under `evidence/current-develop-integrations/`. The separately retained
prepublication map and review still correctly describe their own earlier
unpublished state. The later root publication receipt resolves that state without
rewriting those historical files.

## Scope of the historical performance claims

Score's small measured component benefit was about 1.6 ms per warm full-corpus
JMdict compact-field validation. Its original browser studies established no
whole-import gain: the JMdict memory-coverage failure and the unfavorable
Jitendex result, with five of six pairs slower, remain part of the evidence.
CRC's allocation-free tail change had a
measured component benefit, but its active VNDB browser primary result was
unfavorable and its memory-coverage gate failed; JMdict and Jitendex were inactive
controls for that route. The current integrations have no new import timing.

Those records and their full raw observations are already durable and are linked,
not duplicated into this correctness packet:

- [Score JMdict browser packet at immutable `54b93325`](https://github.com/ManabiIO/manabitan/blob/54b933253e05dfa8b9cfe0b7211cb8eac34eb500/dev/perf/import-evidence-20261128-1b47/score-jmdict-browser-addendum-README.md).
- [Remaining score browser evidence at immutable `212089f2`](https://github.com/ManabiIO/manabitan/tree/212089f2186cfd7ea0d90b082f16b1cd81c65aa5/dev/perf/import-evidence-20261128-1b47).
- [CRC component and all-corpus browser evidence at immutable `c89af6f1`](https://github.com/ManabiIO/manabitan/tree/c89af6f108eebab73dcdbc7c3a292c189a6161e6/dev/perf/import-evidence-20261128-1b47).
- [Earlier component packets at immutable `3c3ba760`](https://github.com/ManabiIO/manabitan/tree/3c3ba7600a8811df6b8631b72a0ac5379f8b60d1/dev/perf/import-evidence-20261128-1b47).

The separate corrected compression registration at
[`b444dbe1`](https://github.com/ManabiIO/manabitan/blob/b444dbe138ba441038ae97a0fb608df2cd177dd4/dev/perf/import-evidence-20261128-1b47/compression-proof-registration-README.md)
is not an outcome of this correctness workflow. Its validation and browser
artifacts belong to separate packets.

## Omissions, recovery, and reproduction

No member of either original correctness artifact is omitted. The bulk local
LLVM toolchain, full Git checkouts, installed dependencies, and earlier import
datasets/performance archives are not duplicated here. The local native checkpoint
and all small toolchain provenance and gate logs are retained.

The omitted approximately 82 MB toolchain archive is Actions artifact
`15245399340` from run `46101416471`, SHA-256
`a5ec0df3408e28a25cd7c986b9df371187960036cd9767f12269f3cf549cb1e6`.
An exact byte length is not asserted from the unavailable local archive.
`evidence/current-develop-integrations/toolchain-recovery.json` records its
original and portable-wrapper hashes, the two launch-only flags, and the linker
alias. Native optimization flags were unchanged. Recover the exact original
artifact while it remains available and verify this SHA-256. This is a recovery
reference, not a promise that an expired Actions artifact will remain retrievable.
The hosted workflow independently installs and asserts Clang/LLD 21.1.8, then
requires exact native-byte reproduction.

To verify the downloaded packet without running any gate or import:

```sh
sha256sum -c current-integration-correctness-20261128-1b47.sha256
mkdir current-integration-evidence
tar -xzf current-integration-correctness-20261128-1b47.tar.gz -C current-integration-evidence
python current-integration-evidence/evidence/durable-bundles/package-evidence-v2.py \
  --verify-manifest current-integration-correctness-20261128-1b47.manifest.json
```

The verifier checks every retained member's exact name, length, and SHA-256 and
rejects missing, duplicate, or unexpected members. The two embedded original ZIPs
can also be hashed against the table above; their extracted trees are preserved
alongside them, so inspection does not depend on a later artifact download.

The source/gate reader is retained as executed, including its original absolute
workspace paths. To repeat that read-only audit elsewhere, use a separate copy,
map its `ROOT`, `REPO`, `OUT`, and original-ZIP locations to the extracted evidence
and a Git checkout containing the registered workflow/product commits, and direct
any newly written audit outputs to a fresh directory. Preserve the archived reader
and original receipts unchanged. Such a later audit would be a new verification,
not another hosted acquisition.

For a future correctness rerun, use the exact product commits and the commands,
runtime versions, native toolchain, and source guards in the retained registered
workflow. This packet's stated results are the completed run above; no rerun is
needed to verify its retained bytes. The packaging helpers, member manifest,
sensitive-pattern scan, and review receipts document the final preservation step.

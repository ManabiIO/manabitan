# Import campaign reproducibility tools — 2026-11-28

This directory preserves exact audit and correctness-replay tooling for the JMdict,
Jitendex and VNDB campaign. It is an evidence branch: publishing these files does
not change the extension, start another benchmark, or establish a speedup. Keep
all cohorts, failed outcomes and original source identities separate.

## Immutable inputs

The baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.

| Cohort | Product commit | Study commit |
| --- | --- | --- |
| Plain glossary | `0e99965c57f669b17f7fe72c75685e97bf1082c0` | `8ce5cdea4c1ed0c2e760f2195ac283eddd1973c5` |
| Adjacent expression witness | `e677343763d9a65e287ab2009a1939b8f84127e3` | `4853517efb946f03748103a8864a1863c031cfb2` |
| Score cache first screen | `a6405695423f7c985d1bf14e0cfec85638dc9576` | `84d6dda6479e46b666dde4230a8cf0c9d875ee09` |
| Score cache confirmation | `3e1e602d0cac73055dfd85bf6ec2674b10ca0a59` | `1ca09d5f955c0c4c5b7232c4267034e54f52e8ab` |
| Indexed validation original | `7e488d809ba18ce120f5766651bdfdf622561fab` | `9aa3bbd66b34fc31d90a35c79401f65d9161f8bb` |
| Indexed validation duplicate registration | same product | `31c3da6295118c955afcc46f81de5175cecabb3f` |
| Native v1 | `cc369aec9d0233b8491bcef4d82d185eb5c5086d` | `1540e0e3451956cd9757780879a02ef41ec9505a` |
| Corrected native | `13e7a7e6c1568de0af563d0577385e9ba16892c1` | `bee2c67d4b6d4ef70915b30931289c5cbd438b44` |

The published native qualification driver is already recoverable at
`dev/perf/import-qualification-native-score-2ed.py` in either native study; its
SHA256 is `e40161963984bcf0e28c28d2930cc989345f9c239a74ed7306331c7a98a762c7`.
Baseline memory/semantic verifiers, dependency manifests and fixture metadata are
already in Git and are not duplicated here. The accompanying publication manifest
records every preserved tool's exact bytes, SHA256, Git blob and dependencies.

## Artifact auditors

The Python auditors use the standard library plus baseline modules under
`dev/perf/import-memory-20261125-a7f7`. They hard-code the original baseline checkout
path `/workspace/scratch/2ed731c9ad68/manabitan`. Reconstruct a clean checkout of the
baseline at that path, or provide an exact filesystem alias. Keep its baseline Git
objects available. Do not edit a frozen ROOT constant and then claim the old hash.
The two native JSON contracts must remain adjacent to their corresponding auditors
under their existing basenames. Their hashes are enforced by the code.

Set `tools_root` to this directory in the evidence checkout. All artifact auditors
share this positional interface and require a new output directory:

```bash
python3 "$tools_root/native-score-evidence/audit-hosted-native-corrected.py"   "$artifact_zip" jmdict "$artifact_sha256" "$new_audit_dir"
```

Select the exact auditor for the cohort: `audit-plain-hosted.py`,
`key-witness-evidence/audit-hosted.py`, `audit-score-hosted.py`,
`audit-score-confirmation-v2.py`, `audit-indexed-hosted.py`, or the two native
versions. Indexed original/duplicate cohorts use the same auditor but remain
separate. Native v1 requires 26 observations; corrected native requires 42.
The score confirmation uses v2, which was frozen before its artifacts appeared.
Never replace failed observations, alter schedules or subtract control drift.

**Original artifact ZIPs are an input dependency.** Complete package-byte auditing
requires the original GitHub ZIP, including both packaged extensions. GitHub
artifacts expire; the data-only evidence backup deliberately omits those packages.
The preserved source and receipts do not recreate an expired original ZIP or prove
that a later rebuild has identical package bytes. After expiry, the prior full
audit/retention receipts remain evidence, and raw data checks remain possible,
but a new complete package-byte audit cannot be promised.

## Retention and diagnostic samples

Retainers only accept their specific completed audit markers, verify original
package hashes, rehash every retained raw member, and write a receipt. They never
delete the original ZIP. Keep the distinct interfaces:

```bash
python3 "$tools_root/native-score-evidence/retain-audited-raw.py"   "$artifact_zip" "$audit_dir" "$new_retained_zip"
python3 "$tools_root/score-cache-evidence/retain-confirmation-raw.py"   "$artifact_zip" "$audit_dir" "$new_retained_zip"
python3 "$tools_root/retain-indexed-evidence.py"   "$artifact_zip" "$new_retained_zip" "$audit_json"
```

The diagnostic analyzer accepts a raw trace or a member of a retained ZIP:

```bash
python3 "$tools_root/native-score-evidence/profile-sample-summary.py"   --zip "$retained_zip" --member diagnostic-trace-A/run-1.trace.json   --source-sha "$observed_source_sha" --out "$new_summary_json"
```

It counts unweighted samples. Separate source/fixture/browser/package binding
receipts remain necessary. A supplied source label is not independent provenance
verification, and sample counts are not elapsed CPU time or a whole-import gain.

## Bounded production-options correctness replay

The exact executed runner, strict combiner and grouping manifest are preserved.
They import Node built-ins, `@zip.js/zip.js` from the baseline's locked dependencies,
and production modules from the two explicit source roots; there is no additional
local helper module to copy. Restore locked fixture ZIPs and build native libraries
for both roots using their repository instructions. Keep Node/dependencies aligned
with the baseline setup. This is a correctness replay, not a timing benchmark.

An example final VNDB partition is:

```bash
node "$tools_root/native-score-evidence/production-options-bounded-oracle.mjs"   --baseline-root "$baseline_root" --candidate-root "$candidate_root"   --cache-dir "$fixture_cache" --parser-workers 3   --group-manifest "$tools_root/native-score-evidence/production-options-group-manifest.json"   --require-plan --group-start 160 --group-count 32   --out "$parts_dir/vndb-161-170.json" vndb
```

Run these eight partitions in separate processes, serially, using the same frozen
roots/options and exact runner/manifest bytes:

| Output basename | Dictionary | Start | Requested count |
| --- | --- | ---: | ---: |
| `jmdict-full.json` | jmdict | 0 | 0 |
| `jitendex-full.json` | jitendex | 0 | 0 |
| `vndb-001-032.json` | vndb | 0 | 32 |
| `vndb-033-064.json` | vndb | 32 | 32 |
| `vndb-065-096.json` | vndb | 64 | 32 |
| `vndb-097-128.json` | vndb | 96 | 32 |
| `vndb-129-160.json` | vndb | 128 | 32 |
| `vndb-161-170.json` | vndb | 160 | 32 |

Count zero means all remaining groups. The final count **stays 32** and is clipped
to ten available groups. The historical count-10 invocation was rejected by the
strict combiner and retained separately; do not copy that rejected invocation.
Use `--require-plan` for native compact-plan coverage; omit it for the separate raw
score-cache comparison. Never combine different settings or interrupted parts.

```bash
python3 "$tools_root/native-score-evidence/combine-production-options-parts.py"   --parts-dir "$parts_dir"   --runner "$tools_root/native-score-evidence/production-options-bounded-oracle.mjs"   --manifest "$tools_root/native-score-evidence/production-options-group-manifest.json"   --out "$new_complete_summary"
```

The combiner checks exact ordered coverage, source/runner/options/fixture hashes,
row counts, record and lookup-sidecar bytes, and parser routes. It does not pool
timings. The successful corrected-origin historical receipts name local commit
`49b426371ace2542710ab2b7a3e0e0915b6c4e35`, tree
`17bc2b87d5c1c49b0e6c1f7ce1061de980186d5c`. The included Git bundle now preserves that exact original commit and its
history. It is not an equivalent-tree alias or a rewritten commit. The documented
AST/style bridges connect the historical proof to the published final product.
A fresh replay against final product 13e7 is new correctness evidence and must
not replace the old source-bound receipts.

## Restore exact local campaign history

`campaign-local-history.bundle` is a 57,536-byte standard Git bundle containing
all 18 local campaign commits and seven branch tips beyond prerequisite
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. It preserves the original identifiers,
including `49b426371ace2542710ab2b7a3e0e0915b6c4e35`,
`19495e4178a6ba2ee3fc7cf0be8b6f45003b40e6`,
`2c744b53f51abc5c53d855d60597b9e619725d45`, and
`592eca35ac3655b9279f06b84fe99a84a4a7527e`. Its SHA256 is
`e71e9d067fb774789651f083ff40c9d16ec3e231533804ccb59fe4d3792c41fd`.
The adjacent evidence receipt lists the exact refs and commits. This complete
bundle supersedes the earlier origin-only staging bundle.

Use a repository that already contains the baseline prerequisite. Restore into a
separate ref namespace, leaving any checked-out branch untouched:

```bash
git -C "$recovery_repo" bundle verify "$tools_root/campaign-local-history.bundle"
git -C "$recovery_repo" bundle list-heads "$tools_root/campaign-local-history.bundle"
git -C "$recovery_repo" fetch "$tools_root/campaign-local-history.bundle"   'refs/heads/*:refs/remotes/campaign-history/*'
git -C "$recovery_repo" rev-parse   '49b426371ace2542710ab2b7a3e0e0915b6c4e35^{tree}'
```

The last command must return `17bc2b87d5c1c49b0e6c1f7ce1061de980186d5c`.
Use ordinary detached worktrees at the original commits when reconstructing the
historical byte replay. Fetching the bundle restores exact Git objects; it does
not rerun tests or change any historical result.

## Reproduce the final runtime AST bridge

`native-score-evidence/verify-origin-style-bridge.mjs` is the exact executed
verifier. It needs Node, baseline-lockfile `espree`, and original commit49b
available through the restored bundle. It reads the historical store through
`git show` and the current store from the original candidate checkout path
`/workspace/scratch/2ed731c9ad68/native-score-plan`. Reconstruct a clean checkout
at the intended final runtime (local2c744 or the identical published product tree)
with its locked dependencies. The verifier imports no additional local helper.

```bash
node "$tools_root/native-score-evidence/verify-origin-style-bridge.mjs"
```

It writes only the fixed proof path
`/workspace/scratch/2ed731c9ad68/native-score-evidence/origin-style-ast-bridge.json`
with exclusive creation. Use a fresh reconstruction; it intentionally refuses to
overwrite an existing proof. It checks complete normalized runtime AST identity
except the sole proven unshadowed `undefined` to `void 0` spelling, and verifies
that no other extension file differs. It does not validate changed test files or
replace their separate unit/lint/type gates. No frozen verifier path or source
should be edited merely to simplify relocation.

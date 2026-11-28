# Corrected compression study: registration and preparation

This packet preserves the complete preparation history for one separately registered JMdict/Jitendex compression study. **It contains no corrected browser import, timing observation, memory scan, validation-job outcome, or performance result.** The original failed compression study remains failed and is preserved separately.

The source freeze is **2026-11-28 08:48:58 UTC**. A separately labeled publication appendix records the initial hosted status at **08:49:43 UTC**: the validation job was queued, with no browser observations. These two timestamps describe different events; the later metadata does not alter the frozen preparation files.

## Exact registered identities

| Role                                         | Exact identity                                                                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corrected study commit                       | [`3256036ff8534ba6de7bc9ecd74ec74d3c705603`](https://github.com/ManabiIO/manabitan/commit/3256036ff8534ba6de7bc9ecd74ec74d3c705603)                                                                                               |
| Corrected study tree                         | `42c3ac97086544bc35aa4895c30ba72e717bd33e`                                                                                                                                                                                        |
| Branch                                       | `perf/compression-proof-screen-20261128-1b47`                                                                                                                                                                                     |
| Active common baseline and commit parent     | `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`                                                                                                                                                                                        |
| Unchanged compression product/test origin    | `f7980e638ea1808701ac28339987663fd8b3dc4e`                                                                                                                                                                                        |
| Historical exact-storage prediction baseline | `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`                                                                                                                                                                                        |
| Registered Actions run                       | [46127578128](https://github.com/ManabiIO/manabitan/actions/runs/46127578128), created at 08:49:14 UTC                                                                                                                            |
| Initial validation job                       | `140925485554`, queued at the 08:49:43 metadata cutoff                                                                                                                                                                            |
| Original trial evidence                      | [Immutable original-compression packet at `128b8f8b`](https://github.com/ManabiIO/manabitan/blob/128b8f8bb69c1801f52242a9907b0b8f0bc3660c/dev/perf/import-evidence-20261128-1b47/compression-original-browser-addendum-README.md) |

The current common baseline contains the merged parser change from PR #972. Both corrected arms inherit that baseline. The candidate keeps exactly the original compression runtime blob and two expectation-only test blobs from `f7980e`; it adds no parser, worker, block-size, memory-budget, or other product change. The sixteen-file commit consists of those three product/test files, the three unchanged original compression-study helpers, and ten new study/tooling files.

`evidence/compression-proof-followup/root-freeze-3256036.json` records the exact parent, tree, sixteen Git blob identities, source/readback checks, and pre-acquisition freeze. `prepared-driver-source-map-final-v2.json` supplies byte lengths and SHA-256 hashes for all ten new files. The packet's source snapshot was checked against both records before copying.

## Why there is one separate correction

The original JMdict and Jitendex studies each stopped at the first candidate warmup. After their already-declared two storage-size adjustments, the differing canonical field was `common.validation.outputDigestSha256`. Their original physical digest includes representation-sensitive diagnostic inputs. The exact physical digest preimages were not retained in that study, so the old artifacts cannot establish the precise differing inputs or the sole cause of the mismatch.

Both original active-corpus studies therefore remain incomplete: two raw warmup reports each, zero measured A/B pairs, zero identical-code control pairs, and no later exhaustive-media or memory qualification. Their unchanged raw reports, receipts, failures, audits, and limits are in the linked original packet. Their warmups are not reused or treated as a performance estimate here.

The new study prospectively retains the missing physical and decoded evidence under a new source identity. It does not rewrite an old receipt, replace an unfavorable observation, relax the old recorded result, or pool old warmups with a new cohort. No compression product PR is justified by this preparation packet.

## Preserved design corrections and superseded preparation

The archive retains the first proposal, `evidence/compression-followup-validation-design-1b47.md`, byte-for-byte. It is historical design evidence, not the final schema. In particular, its suggestion that the references could remain logically invariant was corrected by inspection of the actual storage code.

`rawEntryContentOffset` is a **physical address** of a 20-byte compact reference in the content stream. The ordinary path places references after compressed frames; the shared-source path reserves a prefix at a cursor that includes preceding frame sizes. A compression-size change can therefore move offsets. The final policy allows only those explicitly understood physical differences while preserving the decoded entry length, stable reference identity, and exact bounded format. `reference-invariant-and-schema.md` and `reference-source-identities.json` preserve that source proof.

The first policy draft also needed a distinct digest domain. Earlier source/test bytes and `logical-domain-clarification.patch` are retained. The final labeled comparison record removes the physical digest field only from its own comparison copy and adds `compressionLogicalProjection` with a named logical domain; it never stores a logical hash under the original physical field name. The raw physical receipt remains intact.

The initially prepared corrected study used `9e10`. Before any corrected acquisition, the common baseline was advanced to `dcfc02a0`. The complete earlier preparation is preserved under `superseded-9e10-preparation/`, with a manifest recording **zero observations, zero registered acquisition plans, and no created remote refs**. The newer source context distinguishes the active baseline, original compression product, and historical storage calibration. The proof comparison functions are unchanged by that metadata revision; the independent AST comparison is retained.

The packet also retains the source immediately before the required-worker assertion, all earlier source maps, derivation patches, fixture logs, and reader plans. Earlier documents that say the reader was not yet implemented or that a plan was still being prepared remain historical statements. The final source map and root freeze identify the executable revision.

## Final proof and comparison contract

The symmetric harness overlay is derived from the exact original harness. It adds `report.benchmark.compressionProof` outside the unchanged original validation object. It retains the original physical digest and its restart equality, captures that digest's exact serialized preimage, and adds a decoded lookup pass for the same twelve terms before restart. The first existing post-restart lookup pass supplies the corresponding full decoded JSON; the six original post-restart passes and their numbering remain present.

The policy and matching step require all of the following before accepting an observation's labeled comparison:

- Exact preimage UTF-8 byte counts and recomputed hashes, with duplicate JSON keys and nonfinite values rejected.
- Exact physical pre/post-restart evidence and its binding to the original physical digest.
- Ordered term/probe/reference identities, successful decoded entry lengths, and the exact `raw-block-v2:jmdict` format. A reference occupies 20 physical bytes, and `offset + 20` must fit the actual content file. The uncompressed entry length is not used as the physical reference width.
- Full decoded `termsFind` JSON equality before and after restart, exact cross-arm decoded JSON, and binding of all 72 original post-restart lookup observations to those retained responses.
- Exact A/C and same-family raw physical receipts and proofs, including separate A-family and B anchors throughout warmups, measured imports, exhaustive-media checks, and memory imports, with only the declared sample/all media comparison exception.
- Only the predeclared cross-arm physical offset, raw preview, and validated content-file-length differences. A missing store total must retain the same documented `-1` availability state; missing diagnostic fields are not silently accepted.

This is the original fixed twelve-term semantic sample with stronger retained preimages and explicit decoded restart equality. **It is not exhaustive equality of every dictionary definition.** Additional proof capture occurs after the unchanged authoritative import endpoint and is identical across arms; this does not establish zero harness overhead or lookup non-regression.

Raw reports, raw canonical receipts, raw proofs, labeled comparison receipts, the new proof-policy audit, and the unchanged nested original storage-policy audit are separate retained files. An old artifact without the additive raw proof cannot pass this reader merely by acquiring a new sidecar.

## Exact storage tradeoff remains a rejection check

| Corpus   | Required B−A content-file delta | Required B−A complete-storage delta | Historical complete-storage denominator |
| -------- | ------------------------------: | ----------------------------------: | --------------------------------------: |
| JMdict   |                  +312,404 bytes |                      +312,404 bytes |                        43,520,477 bytes |
| Jitendex |                  +750,018 bytes |                      +750,018 bytes |                        67,466,332 bytes |

The original two-percent complete-storage ceiling remains in force. These exact deltas originate from the old `9e10` calibration and are kept as **fixed fail-closed predicates** on the current common baseline. They are not predictions recalibrated after seeing new data. A differing delta in a corrected result fails the declared policy; this packet does not authorize changing it.

The original three helper files are byte-identical to the original study. Both current plan and policy explicitly identify the historical prediction provenance separately from the active baseline. The complete browser storage denominators above are historical context, not measurements from the corrected cohort.

## Fixed future acquisition and decision rule

Only JMdict and Jitendex are declared for the corrected study. Each corpus has four excluded warmups, six A/B pairs alternating AB/BA from initial AB, and two identical-code A/C pairs interleaved after pairs three and six. Those are twenty timing observations, followed by two separate exhaustive-media imports and four separate memory imports: **26 planned reports per corpus**.

Every observation uses a fresh profile, production defaults, and empty import flags. The unchanged primary endpoint runs from file-input change through post-UI import completion. The paired median, equal-work change, descriptive 10,000-resample complete-pair bootstrap with seed 897, and original memory policy remain fixed. Every report must show exactly three parser workers; this is an observation assertion, not a worker setting or tuning flag.

The products are built independently before timing. The proof overlay is the only admitted dirty path during ordinary observations, and the separately registered memory markers compose on the same proof source. Exact package bytes are checked throughout, and a final restoration record must show the original tracked harness restored with clean trees and unchanged packages. A/C uses the exact A source and package under a distinct label.

There is no replacement cohort, retry, adaptive sample expansion, old-warmup reuse, control subtraction, or pooling with the original failed study. Timing or full-media failure stops subsequent acquisition; the separate memory stage retains its original fixed failure accounting and never replaces a failed record. Any failed gate remains a failure. The independent complete-artifact reader additionally requires all expected observation files and raw pointers, derives the exact harness bytes, revalidates the old receipt and memory gates, binds each timing observation to its raw summary, and recomputes the fixed statistics and final status.

The predeclared review rule requires both active-corpus semantic, exact-storage, and memory gates to qualify. At least one corpus must have candidate paired median and equal-work changes below zero, a descriptive upper bound below zero, and candidate median and equal-work changes more favorable than their corresponding identical-code controls. The other corpus blocks a compression PR if its descriptive lower bound is above zero, or if at least five of six pairs are slower while both median and equal-work changes are above zero. Remaining ambiguity must be reported.

These are review rules, not claims of statistical significance or merge readiness. Semantic/memory success does not establish latency non-regression. Even a qualifying outcome permits only provisional draft review from one host. If neither corpus meets the useful-signal conditions, the compression mechanism closes without a product PR. The old component replay alone cannot justify one.

## Local validation and unresolved hosted gates

The final combined preparation suite passed **45 synthetic fixtures in 1.833 seconds**. All eight new Python files parsed successfully. The source checks include explicit non-ignored Prettier checks for the final README and workflow, `git diff --check`, exact tracked product delta, and exact remote text readbacks. `actionlint` was unavailable and was not run.

All earlier attempts are preserved. The first overlay fixture attempted to assign Node's read-only global `crypto`; its log records that fixture failure, followed by the corrected seven-test pass. The first reader run had ten passing cases and one `KeyError` because the test used a pre-canonicalization media path; correcting the fixture to the canonical top-level media field produced the eleven-test pass. The final report-pointer guard adds the twelfth reader case. The combined 45-test log supersedes the earlier combined counts without deleting those logs.

These are tooling checks, not imports or measurements. Fresh native reproducibility, full unit, build, lint, and main/test type gates on the new combined source must still pass before the two browser jobs. At the separate 08:49:43 registration snapshot, only the queued validation job existed; this packet contains no later validation outcome or browser result.

Independent reviews cover the physical/reference contract and overlay, proof policy, current-baseline metadata revision, driver/workflow and dirty-path boundaries, and the independent artifact reader. Their exact source hashes and review scopes are retained. They are static/source and fixture reviews, not additional browser executions.

## Packet contents and verification

The snapshot includes all **82** files present in the reviewed preparation-history set at the source freeze, all **16** candidate-source files, the original design and failure-classification notes, the unchanged base auditor used for the reader derivation, and the byte-identical later queued-registration metadata. It also includes the bounded capacity-relocation receipt and helper as operational provenance; those relocated only already-published closed evidence and changed no study input.

The source and history files keep their original workspace-relative archive paths. The external manifest gives every included member's byte count and SHA-256; archive metadata normalization changes only tar/gzip metadata. The raw preparation bytes are not reformatted. Symlink components are rejected by the stager and packager.

Large original dictionaries, frame captures, extension packages, and the original browser cohorts are not duplicated. Their immutable manifests, recovery instructions, and complete raw evidence remain in the [original-compression packet](https://github.com/ManabiIO/manabitan/blob/128b8f8bb69c1801f52242a9907b0b8f0bc3660c/dev/perf/import-evidence-20261128-1b47/compression-original-browser-addendum-README.md) and earlier linked component/session packets. The corrected source snapshots are partial repository snapshots; they do not replace a checkout of the registered commit or its locked dependencies. Future corrected browser artifacts do not exist in this packet and must be preserved in separate append-only result packets.

Verify the distributed archive and every member after placing the archive, manifest, and checksum together:

```sh
sha256sum -c compression-proof-registration-20261128-1b47.sha256
tar -xzf compression-proof-registration-20261128-1b47.tar.gz
python3 evidence/durable-bundles/package-evidence-v2.py \
  --verify-manifest /absolute/path/compression-proof-registration-20261128-1b47.manifest.json
```

The verification helper reads the archive beside the supplied external manifest. It rejects missing, duplicate, unexpected, or changed archive members. `snapshot-receipt.json` binds the copied source/history files to their original byte hashes before packaging.

To reproduce the preparation fixtures, use a full checkout at the exact registered commit, its supported Node version and locked dependencies, then run the frozen workflow's fixture command:

```sh
PYTHONPATH=dev/perf/import-memory-20261125-a7f7:dev/perf/import-compression-level-20261128-1b47 \
  python3 -m unittest discover \
  -s dev/perf/import-compression-proof-20261128-1b47 \
  -p 'test_*.py' -v
```

A later complete corrected artifact can be independently read with the source-bound command retained in `artifact-reader-reconstruction.md`. The inherited `--baseline-root` option means the **verified study-source checkout containing the candidate tooling and both Git objects**, not a baseline-only checkout. The caller must supply the independently known original artifact SHA-256 and candidate commit. Its output and extraction paths must be new. That is an audit of an existing artifact; it does not authorize a new acquisition or allow an incomplete original trial to qualify.

No artifact reader was executed on corrected observations while creating this packet. Publication preserves the prospective protocol and its history; it makes no import-speed or merge-qualification claim.

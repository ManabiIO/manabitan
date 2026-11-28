# Exact lazy-ID source commits

`lazy-ids-source-f171-da03-b0a.bundle` preserves the local source commits used by the allocation, correctness and AST reproducibility scripts. The remote hosted-study commits wrap these sources with workflows and therefore have different Git IDs.

Bundle size: **5,949 bytes**. SHA-256:

```text
40240583af6404d86a0e9a09b70e6ce1814c8f628239e7db40b0d23c54f75ac4
```

The sole prerequisite is baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.

| Bundle ref | Exact commit | Evidence role |
| --- | --- | --- |
| `refs/heads/lazy-ids-initial` | `f17102bac19688f1115d1d630720838abf0df00c` | Initial browser campaign and all three complete-corpus allocation replays |
| `refs/heads/lazy-ids-measured` | `da03aa70f88d4b0616eeab8ed251f48a17f8de13` | Malformed-index parity correction, full unit/build gates and later exact-source browser campaign |
| `refs/heads/lazy-ids-review` | `b0a4532ed4209ad289aa28ac58a92a10e9d54841` | Whitespace-only runtime lint correction and typed test snapshots; runtime AST exactly equals measured source |

## Import and reproduce

From a repository that already has the prerequisite baseline and its normal source objects:

```sh
git bundle verify /path/to/lazy-ids-source-f171-da03-b0a.bundle
git fetch /path/to/lazy-ids-source-f171-da03-b0a.bundle \
  refs/heads/lazy-ids-initial:refs/heads/receipt/lazy-ids-initial \
  refs/heads/lazy-ids-measured:refs/heads/receipt/lazy-ids-measured \
  refs/heads/lazy-ids-review:refs/heads/receipt/lazy-ids-review
git worktree add --detach /path/to/lazy-id-review b0a4532ed4209ad289aa28ac58a92a10e9d54841
```

Install the review worktree's pinned package-lock dependencies, then run the retained verifier:

```sh
node /path/to/verify-lazy-ids-lint-ast.mjs /path/to/lazy-id-review
```

The verifier requires the review runtime file to match the frozen source, verifies that the complete `ext` diff contains only `dictionary-database.js`, and compares both full runtime ASTs after removing only source-location fields. Expected normalized AST SHA-256 is `e79e9632b18d66abfa223178589864fadbc52ca47174c6deef163ebbefe2d888`.

Do not change the measured source or package IDs in existing performance receipts to the review ID. AST equivalence establishes the explicit relationship between them; it does not make their bytes or Git identities equal.

## Independent import verification

The bundle was imported into a temporary repository under `/home/agent` that borrowed only a separately fetched shallow baseline-only store. The store contained one commit and 2,818 reachable objects, had no alternates, passed full strict `git fsck`, and contained none of the three candidate IDs. All three candidates were explicitly absent in the verifier before import.

After import, all advertised refs matched the expected IDs, every candidate's runtime bytes matched the source repository, full strict `git fsck` passed, and the unmodified AST verifier passed in the imported repository. The shared baseline store was checked again and still contained no candidates. The temporary verification repository was removed.

`lazy-ids-source-f171-da03-b0a.bundle.manifest.json` records bundle identity, prerequisites, refs, runtime hashes, import receipts and the reproduced AST result. `baseline-only-object-store.json` records the independently constructed baseline store. `prepare-lazy-id-source-bundle.py` preserves the procedure. A preceding verification with an intentionally partial baseline seed failed fetch connectivity; that setup failure is retained in `lazy-ids-bundle-initial-verification-failure.json` and was never counted as successful validation.

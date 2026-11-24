# Compact canonical import rollback journals

The native canonical scanner records every inserted metadata slot so JavaScript can undo an unaccepted synchronous segment after a rejection or trap. ABI 1 wrote three `uint32` values per insertion: the slot, its previous value, and the new dense metadata index. ABI 2 writes only the slot. This removes two stores and eight written bytes per native insertion, reducing journal word writes by two thirds.

The scratch offsets, capacities, fixed 8 MiB prefix, metadata layout, and persistent formats remain unchanged. The compiled scanner decreases from 1,624 to 1,587 bytes with the pinned Clang/LLD 21.1.8 toolchain. These are deterministic work and artifact-size reductions; the evidence below does not establish an import-time or peak-memory improvement.

## Rollback invariants

The probe reaches insertion only when the target slot is zero. A published exact candidate takes the earlier `continue` path, including after collisions. Native eligibility excludes free-ID reuse, and only an insertion advances the dense cursor. Therefore journal entry `j` always restores slot value `0` and clears metadata index `beforeDense + j`.

The volatile progress counter and compiler memory barrier still precede every authoritative mutation. A trap before or after slot publication can therefore roll back the same dense suffix. Accepted earlier segments and failed exact-match appends retain their existing handling. The adapter rejects ABI 1 before calling its scanner; the real previous module is retained as a test fixture. The shipped C source, WASM asset, loader, build manifest, and release audit now consistently use the v2 filename.

## Complete native replay

The baseline is `3d65e403c644b9a5a6be3128d72f9d30050b70e0`. [native-parity.json](native-parity.json) binds all source and module hashes, archive identities, and the complete [raw receipt](native-parity-raw.json.gz). The replay checks every bank in the three locked archives, including ZIP size/SHA-256, entry identity, inflated length/CRC, and JSON row count. It captures production parser output and metadata-owner state before each native call, using fixed four-bank component groups.

Every arm starts from the same complete pre-call memory image. All 209 native segments match return codes, output headers, other scratch bytes, and authoritative metadata bytes. Journal entries match after normalization to `[slot, 0, beforeDense + j]`; the candidate's unused journal tail remains identical to the initial image. Only one segment snapshot is retained at a time.

| Dictionary | Banks | Source rows | Native segments | Journal entries | ABI 1 bytes written | ABI 2 bytes written | Bytes avoided |
| ---------- | ----: | ----------: | --------------: | --------------: | ------------------: | ------------------: | ------------: |
| JMdict     |    53 |     528,299 |              13 |         354,890 |           4,258,680 |           1,419,560 |     2,839,120 |
| Jitendex   |   219 |     436,555 |              55 |         363,243 |           4,358,916 |           1,452,972 |     2,905,944 |
| VNDB       |   665 |   6,648,310 |             141 |         132,185 |           1,586,220 |             528,740 |     1,057,480 |
| Total      |   937 |   7,613,164 |             209 |         850,318 |          10,203,816 |           3,401,272 |     6,802,544 |

These counts belong to the recorded component grouping, not browser import-planner batches. The unchanged eligibility fallback covers one JMdict group (8,299 source rows) and 26 VNDB groups (1,008,310 rows); those rows are excluded from the native savings. The parity run's wall/CPU diagnostics were collected during other validation and are not a timing qualification.

## Actual adapter and database-owner proof

[owner-parity.json](owner-parity.json) independently runs the actual ABI 1 and ABI 2 JavaScript adapters in separate database owners across all 219 Jitendex banks and 436,555 rows. Its ten-bank groups produce 22 native calls, 363,243 insertions, 30 exact candidates, and zero fallbacks in each arm. Result columns, resolved plans, and authoritative metadata bytes match before and after every publication. Both owners together perform 60 persisted content reads. The final metadata SHA-256 is `d53d0e82bbee211da1a33962c2f2d45ba6328d0decb9748b69e88c3b02f4fa35`.

The first owner run ended at an incorrect harness-only assertion about compact source-metadata activation after all parity comparisons passed. The corrected run checks the production greater-than-50% repeat threshold; these Jitendex groups remain row-based. [The initial receipt, exact runner, and log](owner-parity-initial-compact-assertion.json.gz) are preserved. This proof does not exercise browser lifecycle, compression, OPFS durability, final record writing, or complete import timing.

## Validation and reproduction

Focused validation passes 87 tests in seven files, including 65 canonical fixture controls. Coverage includes collisions, mixed resolved/exact/pending rows, the 4,096-candidate handoff, rejection after prior insertions, synchronous traps, publication, and the actual ABI 1 module fallback. All four TypeScript projects, scoped JavaScript/JSON lint, pinned WASM reproducibility, and all seven target dry builds pass.

The local full-suite attempt, `npm run test:unit -- --maxWorkers=2 --testTimeout=60000`, ended without a result summary when its execution session was interrupted. [Its log is retained](unit-incomplete.log.gz); it is not a passing full-suite result. The normal unit suite with default timeouts remains a CI gate.

Use Node 22.22.0 and two dependency-installed checkouts: the fixed baseline above and this candidate. Prepare locked archives with `node dev/perf/prepare-dictionaries.js jmdict jitendex vndb`, and generate libraries in both checkouts with `node dev/bin/build-libs.js`.

The archived [native runner](native-parity-runner.mjs.txt) and [owner runner](owner-parity-runner.mjs.txt) are the exact executed sources, with hashes recorded in their receipts. Copy them outside the repository as `.mjs` files and change only their initial workspace/cache/output path bindings. The native runner uses `root`, `baseline`, `cache`, and `output`; the owner runner derives its checkouts and temporary backing file from `directory`, with a separate `cache` binding. Keep the baseline commit assertion and corpus selection unchanged. Run:

```sh
node /path/to/native-parity-runner.mjs parity jmdict jitendex vndb
node /path/to/owner-parity-runner.mjs
npm run test:ts
npm run test:build
```

Changing location bindings changes the runner hash, which the new receipt records. Candidate runtime hashes must match the archived receipt. Archives and temporary content backing remain outside Git. The ABI 1 test fixture is the baseline's 1,624-byte checked module, SHA-256 `40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af`.

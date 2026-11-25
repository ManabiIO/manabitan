# Chrome package audit

Four checkouts were built sequentially with `npm run build -- --target chrome`. That command invokes `buildLibs` internally. No separate duplicate library build, dictionary import, or timing run was performed.

| Checkout | ZIP bytes | ZIP delta vs baseline | Changed JavaScript bytes, uncompressed |
| --- | ---: | ---: | ---: |
| Baseline | 17,273,796 | 0 | 0 |
| JMdict | 17,274,263 | +467 | +2,012 |
| Jitendex | 17,273,972 | +176 | +771 |
| VNDB | 17,274,350 | +554 | +2,392 |

All four builds succeeded and left no tracked changes. Every package contains 616 ZIP entries, including 551 files. Each candidate changes exactly its intended JavaScript file; its other 615 entry-content hashes match baseline. There are no added, removed, or unexpected entries. All five WebAssembly files have identical names and SHA256 hashes across all four packages.

The changed files are `js/dictionary/term-record-opfs-store.js` for JMdict, `js/dictionary/zstd-term-content.js` for Jitendex, and `js/dictionary/dense-zip-directory.js` for VNDB. The package-lock hashes also match. Each package uses the requested Chrome target with the build command's default manifest version `0.0.0.0`; these are validation artifacts, not published releases.

`package-audit.json` records the exact baseline/candidate commits, package sizes and hashes, all WASM hashes, changed-entry hashes/sizes, and entry-manifest references. The four `*-entries.json` files contain complete decompressed-entry SHA256 manifests. Every archive member was read with ZIP CRC checking. The four build logs and receipts preserve successful commands and tracked status before/after each build.

## Disk recovery

All builds had completed when the first comparison hit `ENOSPC` while writing its first entry manifest. That failed comparison is retained in `comparison-initial-failure.json`. The recovery saved complete package sizes, package hashes, and per-entry hashes to temporary snapshots, then removed only this audit's four newly generated ZIP files after hashing them. It could then write this compact evidence package. No package was rebuilt and no authored source was removed. The ZIP binaries are not retained; their complete byte-content evidence is retained here.

## Reproduction

Use four separate checkouts named `manabitan-base`, `jmdict`, `jitendex`, and `vndb` below a task directory, at the exact commits recorded in `package-audit.json` or the equivalent published source trees documented with each candidate's evidence. Install the locked dependencies in each checkout. Node must satisfy the repository engine (`^22.22.0 || >=24.8.0`).

The helpers accept the task directory explicitly and write reports under its `evidence-staging/package` directory:

```sh
python3 build-one.py manabitan-base /path/to/task-directory
python3 build-one.py jmdict /path/to/task-directory
python3 build-one.py jitendex /path/to/task-directory
python3 build-one.py vndb /path/to/task-directory
python3 compare-packages.py /path/to/task-directory
```

Run these sequentially. If a build fails, preserve its receipt and stop. The comparator requires successful receipts for all four builds and retains generated ZIP files by default. Its explicit `--remove-generated-zips` option saves complete snapshots before removing those four generated archives; that option was used for the recorded disk-recovery comparison.

`evidence-hashes.json` records SHA256 hashes of this final evidence package. No elapsed-time or performance claim is derived from this audit.

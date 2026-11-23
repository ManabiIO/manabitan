# VNDB duplicate media projection qualification

**Decision: timing inconclusive; complete component output parity passed.** This evidence accompanies [PR #799](https://github.com/ManabiIO/manabitan/pull/799). It does not demonstrate a full import speedup or qualify browser persistence, lookup behavior after reopening, or peak memory.

The candidate skips an already projected media content ID before reading a duplicate source row's expression/reading indexes and equality flag. The gate requires the fused string plan, omitted term byte lists, and an emitted content slab. Native parsing has already produced the complete row columns and canonical content. The earlier parser still performs those row operations before its existing media deduplication check.

## Immutable inputs

| Input                                           | Identity                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| Baseline                                        | `5e1f8c12f7ff798ba407323aff675cb23b22af02`                         |
| Local isolated timing candidate                 | `6e6b8180265682a9c6af92219f82d08e56ae78f2`                         |
| Published PR #799 candidate                     | `0541343dfb9426317763185db03153bdafc96228`                         |
| Candidate tree, identical for those two commits | `ed9eb3eddffbe5202e98ec3371e09c730656ddc1`                         |
| Complete oracle candidate                       | `dbb19c26b9359f5abc237e5bb14ffd1c3f90d3f7`                         |
| Fixture                                         | VNDB Characters by Bee, revision `395525135651`                    |
| Fixture SHA-256                                 | `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792` |
| Archive bytes                                   | 291,705,969                                                        |
| Uncompressed term source bytes                  | 4,267,992,967                                                      |
| Term banks / rows                               | 665 / 6,648,310                                                    |
| Runtime                                         | Node.js 22.22.0, V8 identity recorded in each report               |
| WASM SHA-256                                    | `cc749c53fc32dfb28eefbd69f99868f8c303caa1a3f1354231516dfa5a6e1b0f` |
| Exact executed component harness SHA-256        | `2255e741b01673636f906cb9dd0d62c78f9171f2209b56635464b83c1da7ba8f` |

Download the fixture explicitly from [the upstream release asset](https://github.com/bee-san/VNDB-Character-Names-by-Bee/releases/download/1.0.0/vndb_characters_by_bee.zip). The harness verifies the entire archive's actual SHA-256 and byte length before any parsing. The archive is not included here and is not an unconditional test dependency.

The complete oracle ran before the performance change was split from the independent eager metadata fix in [PR #798](https://github.com/ManabiIO/manabitan/pull/798). [source-equivalence.json](source-equivalence.json) records the identical component file hashes and all tree differences between the oracle and isolated timing candidates. Those differences are `dictionary-importer.js` and its regression test; neither is imported by this component. The parser, its recorded dependencies, the dependency lock, and WASM match exactly.

## Production-shaped component boundary

The harness reads the real ZIP directory and partitions all term banks with the production lazy source planner's byte balancing. Its 24 MiB target yields 170 groups. The source size term dominates the default worker pipeline group count for this corpus. Bank order and the exact membership of every group are in every raw report.

At these source identities, the importer defaults content deduplication on. Its direct media artifact path enables the content slab, image projection, omitted term byte lists, and lookup preparation. The parser pipeline enables owned content and native escaped keys for projected imports of at least 512 MiB. This corpus exceeds that threshold. The harness records these options and requires zero fused parse fallbacks. It serializes those production-shaped groups; it does not invoke the browser's actual worker scheduler.

Each timer starts immediately before native compressed source inflation. It ends after fused column parsing, `copyWasmBackedColumnChunk(chunk, false, true)`, and completed lookup preparation. This explicitly includes the owned result and image projection copy boundary. Source payload reads, archive hashing, module imports, and WASM compilation are outside the timer. Output hashing runs only in `oracle` mode. Browser startup, worker overlap/IPC, global deduplication, media payload persistence, Zstd, OPFS, and UI are outside this component boundary.

No warmups are excluded. Each arm uses a fresh Node process. WASM compilation precedes the timers, but initialization performed by the first parser call remains included. The parser's built-in phase counters remain enabled identically for both arms; their integer millisecond totals are diagnostic, not separate performance claims.

## Complete component oracle

[vndb-oracle-all-complete.json](vndb-oracle-all-complete.json) covers all 170 groups, all 665 banks, and every one of 6,648,310 rows. Each baseline and candidate parser has independent WASM memory. Every group's complete deterministic output is hashed before either parser reuses its memory for the next group.

The oracle includes all row columns, key plans, reading equality flags, scores, sequences, canonical content bytes and metadata, both content hash columns, unique content IDs, complete deduplication plans, resolved-reference state, complete prepared lookup maps including their segment key plans, and projected media records. Recursive values include explicit structure framing. Each of the 170 paired digests matches. The report also records and rechecks source file identities and the actual archive hash.

There are 146,725 projected media representatives across parser groups. This is not the 146,570 distinct WebP payloads in the archive: the same content may produce a representative in more than one parser group. This oracle compares parser output and prepared indexes; it does not hash persisted database files or image payloads. An independent review checked the strengthened field coverage, completed group coverage, and timing arithmetic.

## Frozen timing observations

The schedule was written before the first measurement: four A/B/C triples, where A and C are unchanged baseline code and B is the isolated candidate. All 12 arms completed, each with 6,648,310 rows and zero fused fallbacks. No observations were discarded and sources stayed frozen. [timing/plan.json](timing/plan.json), every per-group raw JSON report, and every original log are retained. [timing/run-vndb-timing-original.py](timing/run-vndb-timing-original.py) is the exact original machine-specific scheduler. The portable replacement next to this README uses the same schedule and component script.

Negative candidate time change means less time: `100 × (B / mean(A, C) − 1)`. Baseline drift is `100 × (C / A − 1)`.

| Triple | A baseline (s) | B candidate (s) | C baseline (s) | Candidate time change | Unchanged baseline drift |
| ------ | -------------: | --------------: | -------------: | --------------------: | -----------------------: |
| 1      |          7.321 |           7.132 |          6.529 |                +2.99% |                  −10.82% |
| 2      |          7.249 |           6.426 |          9.848 |               −24.83% |                  +35.85% |
| 3      |          6.991 |           7.090 |          8.871 |               −10.60% |                  +26.89% |
| 4      |          8.743 |          10.219 |         10.081 |                +8.57% |                  +15.30% |

The median paired time change is −3.81%; the equal-work aggregate change is −5.94%. Unchanged-code variation is substantially larger and the candidate changes sign across triples. These summaries are descriptive only. The timing result is inconclusive; no component speedup or full import speedup is claimed. [timing/summary.json](timing/summary.json) contains the unrounded arithmetic and all phase totals.

## Reproduce

Create separate baseline and candidate checkouts at the recorded commits, install the locked dependencies, and build each source revision's libraries/WASM with its normal build commands. Confirm the WASM and source identities recorded by the harness. Keep the host quiet and sources frozen for the complete cohort. Supply absolute paths below.

```sh
node builds/perf/20261122-vndb-projection/vndb-component.mjs \
  oracle /absolute/baseline /absolute/candidate \
  /absolute/vndb_characters_by_bee.zip /absolute/oracle.json

python builds/perf/20261122-vndb-projection/run-vndb-timing.py run \
  --node /absolute/node-22/bin/node \
  --baseline-root /absolute/baseline \
  --candidate-root /absolute/candidate \
  --archive /absolute/vndb_characters_by_bee.zip \
  --output-dir /absolute/new-cohort-directory

python builds/perf/20261122-vndb-projection/run-vndb-timing.py summarize \
  builds/perf/20261122-vndb-projection/timing
```

The optional final component argument selects a limited smoke sample; omit it for full coverage. The scheduler refuses to reuse an existing output directory, preserves failed-arm logs, and stops without inventing missing observations. Its summarizer requires the complete schedule, exact source identities, all groups and rows, and zero fused fallbacks.

## Related correctness and validation

PR #798 separately fixes a reproduced eager image metadata bug: duplicate requirements previously filled the metadata cache before the first requirement could retain the media bytes. Both JavaScript and WASM regression cases failed on baseline with zero persisted media rows and passed after resolving the first requirements before duplicates. Default imports skip this eager metadata work, so that fix carries no default-import performance claim.

The initial focused run under host contention had seven existing 5-second timeouts. Its original log is retained under `validation/`; the sequential rerun passed all 365 tests across the importer media, term parser, and experiment suites. Changed-file ESLint and all seven dry-run build targets passed. Main TypeScript validation passed; full test TypeScript validation was killed with exit 137 locally and was left to CI. CI then found the newly added test helper's missing optional native parser flag type. The independent test-only fix `80fe0fdd1` adds that explicit optional field; changed-file ESLint and a focused TypeScript project inheriting the repository test configuration passed. No runtime source changed for that fix.

The pure performance runtime diff remains nine lines. Browser/OPFS qualification, full repository CI, memory, and reopened lookup behavior remain separate gates; consult the PR checks and the source-comparison browser qualification results rather than treating this component artifact as their substitute.

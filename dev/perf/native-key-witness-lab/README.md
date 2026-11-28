# Early bounded key-token witness laboratory

This branch contains an unqualified native parser prototype. It is not a product PR and claims no import speedup. The checked-in WASM remains the frozen baseline until the push-only workflow rebuilds both arms and checks the exact hashes; generated candidate artifacts are retained as workflow evidence.

## Hypothesis

The current fused importer scans expression and reading JSON strings, then compares bounded adjacent raw keys during interning. This prototype moves that same complete equality proof before the strict string grammar scan. Only an exact token from the preceding completed row can reuse grammar validity and its interned ID. The 32-byte raw-body bound is unchanged. Current-bank bounds and each current field delimiter remain checked. Empty/equal reading handling still precedes interning reuse.

Two stack-local masks retain escape flags and equality witnesses. Generic parser callers retain their existing post-parse comparison. Public WASM signatures, row metadata, worker policy, grouping, cache limits, source CRC validation, storage formats and compression settings are unchanged.

The previous unbounded adjacent-key experiment #756 and bounded interning change #762 compare keys after parsing the row. The proposed earlier grammar proof is the difference being tested.

## Frozen identities

- Baseline: 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2
- Recovered candidate C Git blob: 6c8f5ba9783cc95236ac55d7bc09c0a806720b80 (matches the locally observed diff)
- Baseline parser: 8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee, 67,659 bytes
- Candidate parser: a3b2e9c93668a96e067d0a948d0beff42385f38549526a30f7e82788c93234dd, 69,021 bytes
- Toolchain: Clang/LLD 21.1.8, verified by the repository build script

## Prospective screen

Each job uses twelve balanced A/B/C blocks covering every arm order twice. A and C are identical frozen baseline modules. Every observation runs in a new Node process with two excluded first-group warmups. The first warmup, module compilation and child-process elapsed time are retained separately from the resident measurement. The second independent JMdict cohort reverses the block and within-block order. Hosts and workloads are never pooled.

The measured component includes native source inflate/CRC, strict parsing, content encoding/interning, and complete lookup preparation. Separate parse-plus-lookup thread CPU is the primary screen metric. File reads, compilation, warmups, explicit GC, digest computation, result copies, IPC and OPFS are outside that component. It is not complete import latency.

Locked corpus partitions reproduce the default byte planner: 12 JMdict groups, 22 Jitendex groups, and 170 VNDB groups. Only one compressed source group is loaded at a time. Synthetic controls use 60,000 unique expression/reading pairs with 32-byte raw bodies, varying lengths crossing the bound, and long common prefixes outside the bound. They expose failed-probe costs; four identical repetitions are retained per observation.

Every timed observation has a complete byte oracle outside timing: row columns, canonical content slab and metadata, unique-content mappings/signatures, global and segmented key plans, complete persisted lookup bytes, and projected media rows. Fixture hashes, row counts, native fallback counts, module hashes and runner identity are recorded. Incomplete groups and failures are checkpointed.

The exploratory screen requires complete byte parity, at least a 1% primary equal-work improvement, a favorable paired median, less than 1% equal-work A/C drift, and no replicated unique-key penalty over 1% before considering complete-browser experiments. These are screening criteria, not promotion criteria. A product PR additionally requires representative full imports, memory/lifecycle validation, source-bound rebuilt artifacts and independent review.

## Prior local attempts

The executor became unavailable during local experiments. The C transformation was recovered exactly and its Git blob matched the locally observed diff. The expanded tests were recovered from executed tool calls. The captured summaries in local-attempts.json retain every displayed native observation, including the much slower JMdict candidate and the failed VNDB candidate process. The local full raw JSON is unavailable and is not represented as recovered. The local observations have no identical-code control and are not pooled with this new hosted cohort.

Before the executor failed, 349 targeted tests passed. Full JMdict and Jitendex output digests matched between arms with zero fused fallback. VNDB baseline completed, but its candidate was killed with exit 137, leaving that oracle incomplete. The hosted workflow reruns correctness and artifact identity gates before timing.

No compiler tuning, worker/cache size tuning, persistent-format changes, or source validation weakening are part of this experiment.

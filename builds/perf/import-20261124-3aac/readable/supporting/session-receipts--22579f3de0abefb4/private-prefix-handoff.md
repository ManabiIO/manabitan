# Accepted private-content compression overlap

## Frozen source

- Base: `bbccabd520972cc351a65d9f545bd5369b6e9747`, tree `f81fc2c29b58f1c2329de6b8fa6b2a91015b6b07`.
- Local candidate: `1b48960d2d6abc907d271be61b108d7573e60a4e`, tree `243ab638da9cb73e08d84609c41dcdfdf08475cd`.
- Local checkout: `/workspace/scratch/3aacd533c01f/round2/content-overlap`.
- Root published the same tree as PR #874, remote commit `ebb1da8d2cc2b28901400968891b632605f1b3f0`.
- Node 22.22.0 through `round2/env.sh`; native parser and Zstd WASM bytes are unchanged. Only the source Zstd wrapper gains a compression-bound query. Ignored library bundles were rebuilt for validation; no generated asset is committed.

The source remains frozen. Full-import benefit and memory qualification are pending; component correctness is not a performance claim.

## Critical-path hypothesis

The private content path already packs and dispatches each block using merged PR #851. It then waits for every compression result before publishing content references and encoding/appending records. Already-selected block storage has no remaining savings decision, so its known reference lengths can be reserved while those compression jobs are active.

This candidate allows that existing admitted batch's metadata publication and record append to overlap with compression. The database already joins content completion and record append before returning to its ordered producer. Parser lead, source batch limits, cache budgets, compression workers, block plan, compression level, and compression dictionary are unchanged.

The earlier frozen baseline's ordinary Jitendex diagnostic had 22 source groups, 467.1 ms of packing, 360 ms of compression, 17.9 ms of metadata work, and 28.1/63.8 ms of record encoding/writing over a 1929.3 ms complete import. These overlapping phase counters only motivate the hypothesis. They must not be summed into a wall-time saving. This candidate does not eliminate packing.

## Admission and ownership

`TermContentBlockStore.tryBeginAppendSpans` adds a private route only when all of these conditions hold:

- Compression dictionary resolves to `jmdict`.
- This import session previously selected block storage through its existing measured savings decision (`force === true`).
- The source is a complete, nonempty private `ArrayBuffer`.
- The existing parser ownership registry contains that backing buffer.

`hasOwnedTermContent` only observes the ownership witness. It does not consume cache adoption rights, detach the original buffer, alter borrowed-source leases, or change cache accounting. Ordinary caller arrays, borrowed parser heap views, and private first batches retain their existing route. The shared JMdict route retains its existing initial-selection and source-consumption behavior. VNDB does not resolve to the JMdict compression dictionary and is a negative control.

`_beginAppendSpans` uses the unchanged `compressWrappedTermContentZstdBlocks` factory for private inputs. This still snapshots and dispatches each block before its first await and drains all jobs before a worker error can trigger fallback. The original owned source stays available for retry packing, exact duplicate comparisons, in-flight reads, and cache adoption. Private `sourceConsumed` is resolved after successful validated compression or synchronous fallback, never on dispatch alone.

## Layout and format proof

Let `S` be the authoritative content append cursor, `F` the final total compressed-frame bytes, and `R = 20 * pendingUniqueCount` the compact reference bytes.

| Item | Original suffix layout | Accepted prefix layout |
|---|---|---|
| Physical ordering | Frames, references | References, frames |
| First frame | `S` | `S + R` |
| Reference `i` | `S + F + 20*i` | `S + 20*i` |
| Final content cursor | `S + F + R` | `S + F + R` |

Compressed frame/envelope bytes, entry lengths, intra-block offsets, canonical content, and row ordering remain identical. Compact references point to the relocated frames. Resolved record offset fields and their sidecar checksums intentionally differ on the prefix route. Do not claim equality of entire final v7 sidecar files.

Record chunks split when the range of non-null content offsets exceeds `0xfffffffe`. To prevent relocation from changing those partitions, the candidate admits prefix placement only when the final absolute content end is conservatively bounded at or below that limit. It obtains the native codec bound for every unchanged planned block and adds the existing 12-byte envelope per block.

`TermContentOpfsStore.beginAppendBatchWithDerivedPrefix` checks that bound under the existing exclusive mutation owner, after previous appends establish the authoritative cursor. It snapshots both limit scalars before awaiting, validates finite safe integers, and checks actual compressed bytes against the declared upper bound before mutation. An unavailable codec bound, invalid bound, or high cursor uses the same completed compression results with the original suffix layout. There is no recompression, speculative storage write, additional capacity, or relaxed threshold.

Both layouts validate derived chunk count, type, and exact reserved length. The suffix fallback also does so for an empty primary array. A violation rejects completion before append; the database's existing failure path drains all owners and rolls back metadata/publication.

## Local verification

- Ten focused suites passed: 521 tests, on the rebased `bbccabd` source.
- The corrected malformed-derived table was then rerun separately: all 17 reservation-limit tests passed.
- Main, test, and dev TypeScript checks passed.
- Scoped ESLint passed with no new semicolon suppressions.
- All seven target dry builds passed.
- The first test-TypeScript attempt was OS-killed with exit 137 while other tests were active. The standalone rerun completed successfully. This was not a clean initial run and should remain visible in the handoff.
- The full unit suite has not run locally; root's exact-tree source CI owns that required gate.

The focused coverage includes controlled stalled compression, stable-source recovery after transferred packed inputs detach, reservation-setup failure and terminal drain, cache-witness preservation, first-batch savings rejection, delayed suffix fallback, malformed derived output, mutable limit objects, a preceding queued append crossing the format limit, and actual compressed output exceeding its declared bound.

The native codec test compares ordinary suffix storage with this candidate at cursor zero and above 4 GiB. Every compressed frame/envelope and every canonical read matches, and final content length matches. Above the guard, all content bytes and offsets match exactly. High cursor tests use synthetic cursors rather than allocating a multi-gigabyte fixture.

The persisted record test mixes existing references, new relocated references, and a null reference, including a final-cursor boundary case. It verifies identical parser-prepared lookup payload bytes, partition count, field format, final persisted byte count, and decoded keys/scores/sequences/lengths. Offset fields reflect the explicit mapping above.

## Rejected fresh-owned-SAB alternative

The alternative of replacing the parser's existing compact private buffer with an equally sized fresh shared buffer was audited and rejected before implementation. It is already the core of PR #810. PR #839 additionally cleared compression message references after gathering, yet its qualified Jitendex replication still showed approximately +9.555% PSS and +11.517% private memory.

Current source inspection found no new slab-scale allocation fix. Shared compression reserves a private WASM input of one block's `contentBytes + 7`, not the entire source, plus its normal compressed-output bound and dictionary capacity. The significant extra owners are the whole shared source referenced by compression queues/events and the parser-side shared allocation awaiting collection. The source pipeline already clears consumed `result.chunk` and `result.consume`, and the fresh Jitendex diagnostic adopted zero source-cache bytes. Its 22 owned groups totaled 389,707,807 source bytes, with 102,415,569 maximum queued bytes.

Keeping suffix placement would avoid some metadata/record overlap, but there is no evidence that it resolves the prior cross-isolate memory increase. The candidate therefore retains the original private-buffer transport. The separate `/round2/owned-projected-shared` worktree contains no implementation.

## Activation diagnostics

A local persistent-profile launch failed before import at Chromium `process_singleton_posix.cc:297`: `socket() failed: Operation not permitted (1)`, followed by SIGABRT. No local activation observation was collected, and no sandbox workaround or repeated launch was attempted. The full log is `/workspace/scratch/3aacd533c01f/round2/activation-prefix-jmdict.log`.

The remote payload is `/workspace/scratch/3aacd533c01f/round2/activation-ci-payload`, containing exactly four publishable files:

- `.github/workflows/import-activation-20261124-3aac.yml`
- `dev/perf/activation-20261124/private-prefix.patch`
- `dev/perf/activation-20261124/cache-publication.patch`
- `dev/perf/activation-20261124/summarize.py`

Its four independent jobs pin PR #874's exact remote SHA/tree for all three locked dictionaries and PR #876's `cdb23a11d991a72f860e400d0d81bb0747a5b4f9`, tree `1edef4035041ef848175e3278169daf2260ac34a`, for JMdict cache activation. It verifies fixture-lock hash `60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89`, exact full-index source patches before and after build, package hashes, and complete import success.

Instrumentation collects plain per-batch events and appends one zero-duration diagnostic phase after the import returns. It retains no source buffers and changes no production decisions or awaits. The summary requires positive Jitendex private-prefix activation, unchanged shared JMdict activation, no private activation in the two controls, one placement per private admission, and immediate publisher-to-cache proof correspondence. Its timings are explicitly non-authoritative. YAML formatting, Python compilation, exact patch checks, a diagnostic prefix build, and synthetic extraction/rejection checks passed. Corrected CI activation has now passed, as recorded below.

## First whole-import screen and independent receipt review

Run `45465463257` produced six completed six-block screens when reviewed. Each retained three excluded warmups, eighteen measured imports, and two exhaustive media diagnostics. There were no retries or excluded measured tails. All 138 observations were independently reconciled against the frozen source, package, fixture, browser, schedule, and correctness receipts. The review data is `/workspace/scratch/3aacd533c01f/round2/six-screen-independent-review.json`.

The candidate comparisons below are paired median changes; negative is faster. C is an exact copy of A's source and package. These separate hosts and candidates are not pooled.

| Candidate | Dictionary | B/A | B/C | Identical C/A |
|---|---|---:|---:|---:|
| Private prefix | Jitendex | −1.1999% | −2.3758% | +1.0893% |
| Private prefix | JMdict | +0.2924% | −0.8704% | +0.4587% |
| Cache publication | JMdict | −0.4756% | +1.3890% | +0.9441% |
| Cache publication | Jitendex | −1.0782% | −0.7321% | −0.5217% |
| Media | JMdict | −1.3522% | +1.1368% | −0.5603% |
| Media | Jitendex | −0.2282% | +1.0965% | −0.5838% |

Prefix Jitendex won five of six B/A pairs and six of six B/C pairs. Its descriptive paired bootstrap intervals were −3.2896% to −0.0085% against A and −4.6569% to −1.2440% against C. Equal-work changes were −1.5014% and −2.7693%. The B/A point estimate is similar in size to the +1.0893% C/A control drift, whose descriptive interval was −0.4293% to +3.2755%. This supports an independent frozen qualification, not a material speedup claim or promotion. The other five completed screens do not establish a benefit. The JMdict prefix control includes a retained 1146.6 ms A observation; no outlier was removed.

The review recomputed the reported paired percentages, equal-work ratios, and bootstrap endpoints from each retained native timing. Every observation used Node 22.22.0 and Chromium 153.0.8010.12, a clean source checkout, production defaults, and an unchanged native harness. A and C had identical archive hashes and package-entry hashes, and A/B package differences matched the prospective allowlists exactly.

Every run retained the complete expected row count and passed restart checks and 72 canonical production lookup receipts. Jitendex's exhaustive diagnostics matched all 236 media files and 4,992,155 bytes; its OPFS total was exactly 67,466,332 bytes in both arms. JMdict's OPFS total was exactly 43,520,477 bytes. Individual file byte lengths also matched, after normalizing only random SQLite opaque filenames. These browser content checks cover twelve deterministic terms across six lookup passes; they are not exhaustive canonical-content comparison of all rows.

The prefix Jitendex `outputDigestSha256` intentionally differs between arms: A/C `4cd59b7bfc163d220f6e6a017fee6d2c2f3989cfde6a849233b1868aa85eb723`, B `c94528a8aee9404f2a675d3b8165d1f92c0ef11bcf678a2d4985c66997b92e7e`. The native harness's `probeDigest` includes `rawEntryContentOffset`, so this digest reflects physical relocation. It remains stable before/after restart and across every observation of the same arm. The canonical production lookup hashes match across arms. The other five screens have identical offset-sensitive digests across all three arms.

The activation tooling was committed normally as `34496cb470e6b5cf8ab90149417d50e7893a176d`, tree `efffe9f92863fdc0c8cb97c53d040ab57b85f28d`. Root published that tree as `81ebec7d94cea24c0b2b1ec88af78187b193905b` on `codex/import-activation-20261124-3aac`. Its exact four-file publication manifest is `/workspace/scratch/3aacd533c01f/round2/activation-publication-plan.json`. The workflow push trigger matches that branch. Actionlint, Python compilation, and diff checks pass; the normal Husky pre-commit hook ran.

Root published the independent forward/reverse prefix qualification workflow at `eeec4c2055ed911de92ba98fdc815c8ff0444edb`. Its results are recorded below. The independently reviewed memory tooling froze two separate Jitendex replications, ABBA and BAAB, all four observations retained per host, and prospective PSS/private limits of 5% for paired-median increase and 10% for any individual pair. It required both hosts to qualify and does not reinterpret instrumentation timings as authoritative.

The first activation run `45468163108` failed all four diagnostic jobs. Three imports completed, but the instrumentation hooked only the fallback `DictionaryWorkerHandler` while production used `OffscreenDictionaryWorkerHandler`; therefore no activation phase was captured. Jitendex separately timed out during pre-browser setup and produced no import observation. All failed logs and verified artifacts are retained under `/workspace/scratch/3aacd533c01f/round2/activation-failures-45468163108`, including a detailed `diagnosis.md`. Corrected tooling commit `62d238aad6d97a64c7702a09c7406c08fce9c7fd` adds the actual offscreen hook, requires its owner label, and prepares the exact fixture set before the diagnostic. A real-handler structured-clone transport witness passes, and the old missing-phase reports still fail. No runtime candidate changed and no original failure was discarded or reclassified.

Corrected activation run `45470204352` at published tooling `200b8680bad62e9f40b015ceebebc7382b54dd4b` passed all four jobs. Jitendex made 22 attempts: one unforced private selection attempt, followed by 21 forced private admissions and 21 bounded prefix placements, with zero suffix guard fallbacks. Those admissions cover 372,728,692 selected content bytes and 351,495 unique entries. JMdict made twelve existing shared admissions, including one initial selection, with no private admissions. VNDB made 170 attempts with no compression dictionary and no private or shared reservation admissions; its first two attempts remain unforced. PR #876's cache control recorded twelve immediately matching publisher/receiver pairs, all reusing true publication proofs, for 362,032 unique entries and 101,143,985 source bytes.

The independent activation audit verified the four archive SHA-256 hashes, exact committed tooling and patch bytes, frozen source/tree, fixture preparation, unchanged harness hashes, raw event sequences, offset arithmetic and bounds, package-hash receipts, report hashes, complete row counts and restart, 72 canonical lookup receipts per import, and normalized per-file logical sizes. It retains the product-package hashing limitation and the raw generic harness's authoritative-timing flag explicitly: instrumented activation timings are not speed evidence. Detailed receipts are `/workspace/scratch/3aacd533c01f/round2/activation-corrected-45470204352/activation-receipt.md` and `independent-review.json` in the same directory.

## Independent timing and memory qualification

The independent twelve-block forward/reverse qualification and both memory replications are complete. The detailed receipt is `/workspace/scratch/3aacd533c01f/round2/private-prefix-qualification-receipt.md`.

Recommendation remains **HOLD**. Jitendex forward gives B/A −0.8208% and B/C −0.2010% paired medians with descriptive intervals spanning zero; equal-work changes are +0.9831% and +0.3549%. Jitendex reverse gives −1.6260% and −1.4761%, with intervals below zero. This is a modest improvement on one host and an inconclusive result on the other, not a consistent material complete-import gain. JMdict controls are inconclusive. No hosts, stages, or tails were pooled or removed.

Both prospective memory bounds pass: replication 1 PSS/private paired medians +0.6794%/+0.8814%; replication 2 +3.6625%/+4.2566%. Worst individual pairs remain below +10%. All 164 timing-study imports, eight memory imports, and 808 raw scans independently reconcile with their recorded provenance, canonical lookup/media/storage receipts, process identity/coverage checks, and paired metrics. The memory pass is a bounded increase result, not a memory reduction. Corrected activation confirms actual route coverage and does not change the timing judgment.

## Remaining promotion gates

Root owns the final exact-source full unit/CI status and remote PR disposition. The completed whole-import timing, memory and activation receipts support retaining the PR as draft: activation is confirmed and memory bounds pass, but a consistent material complete-import gain is not established. No further identical-source timing acquisition is recommended by this handoff.

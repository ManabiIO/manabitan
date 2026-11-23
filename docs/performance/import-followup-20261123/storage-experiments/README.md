# Rejected import-storage experiments — 2026-11-23

**Neither experiment was promoted to a runtime PR in this follow-up.** The owned packed-buffer pool reduced allocation counts but failed to demonstrate a repeatable component speedup. Exact-parameter prepared Zstd dictionaries produced valid but different compressed frames, failing the selected byte-preserving gate before timing. Neither experiment established a browser performance improvement.

This bundle preserves the frozen pool patch, all four separately labeled diagnostic cohorts, exact runners and worker bridge, input manifests, validation logs, and the native CDict proof. It contains no dictionary archive, prepared source slabs, built extension, native library, or copied Zstd source. All original receipts and runner files are copied unchanged. `SHA256SUMS` covers the bundle files.

[Download the complete evidence archive](rejected-import-storage-20261123.tar.gz) and extract it before running the reproduction commands below. Paths in this report refer to that extracted bundle. Archive SHA-256: `3b6bd0baf81a06d6e50154b361cb35daf50bf4ec9a422e6a0f75d04c775831a8`.

## Frozen sources and workload

| Item                     | Identity                                                           |
| ------------------------ | ------------------------------------------------------------------ |
| Baseline A               | `467067650653c37c1f7d6b05d6737d070e1259cd`                         |
| Rejected pool B          | `c38459dcdf480a052db21efa9a4996f39f267cd8`                         |
| Dictionary               | `Jitendex.org [2026-10-03]`, 436,555 rows, 219 term banks          |
| Archive SHA-256          | `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356` |
| Prepared-input digest    | `bb4a7ffc8a206dd7b4bff985cc35c697deb14b98ebafdc00f96c3b11622b3d93` |
| Production content codec | JMdict trained dictionary, level −1                                |
| Component block target   | 1,048,576 bytes                                                    |
| Prepared unique content  | 363,243 contents; 389,687,485 bytes; 382 packed blocks             |

Preparation uses the baseline native parser and the actual owned-result helper, `copyWasmBackedColumnChunk(chunk, false, true)`. It retains native unique representatives and removes cross-group duplicates only after hash-pair and exact-byte comparison. The component fixes ten banks per group, giving 22 groups. This is a complete-archive component fixture; it does not replace the production import planner. Its group-local representative counts therefore differ slightly from the browser planner while the final unique-content count agrees.

## 1. Rejected owned packed-buffer pool

The patch transfers only explicitly owned private packing buffers back from the compression worker after compression finishes. A session-owned pool reuses their capacities for later packing. Capacity is rounded to 64 KiB; retention is bounded by 32 MiB, 32 buffers, and 4 MiB per buffer. A closed session rejects late returns. General transfer guards, borrowed/SAB behavior, compressed output ownership, source-consumed signaling, and fallback repacking remain separate from this opt-in path.

### Preserved cohorts

| Directory                                   | Work performed                                                                                   | Valid interpretation                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pool/cohorts/01-generic-instrumented`      | Four AB/BA pairs, null compression dictionary, prototype allocation instrumentation              | Historical allocation diagnostic. Wrong production codec and asymmetric timed instrumentation prevent a production timing ranking. |
| `pool/cohorts/02-generic-uninstrumented`    | Two AB/BA pairs, instrumentation removed, null dictionary retained                               | Historical generic-codec diagnostic. Does not measure the production Jitendex codec.                                               |
| `pool/cohorts/03-production-uninstrumented` | Fresh four AB/BA pairs, production title resolver → `jmdict`, level −1, instrumentation disabled | Corrected component timing cohort. Strong order dependence and no repeatable benefit.                                              |
| `pool/cohorts/04-production-allocation`     | Separate one-A/one-B runs with the production codec and allocation wrappers                      | Allocation counts only. Their timings must not be ranked.                                                                          |

No receipts were replaced or merged across cohorts. `pool/cohorts/PROTOCOL-NOTE.md` preserves the original correction note. The final runtime patch and 32 MiB/32-buffer limits were fixed before the corrected cohort.

### Corrected production-codec results

Positive differences mean the candidate took longer.

| Pair | Order | Baseline wall ms | Pool wall ms | Paired difference |
| ---- | ----- | ---------------: | -----------: | ----------------: |
| 1    | AB    |          227.726 |      404.725 |           +77.72% |
| 2    | BA    |          250.727 |      221.827 |           −11.53% |
| 3    | AB    |          213.625 |      246.615 |           +15.44% |
| 4    | BA    |          245.850 |      223.715 |            −9.00% |

Median paired wall change was **+3.22%**; geometric paired change **+13.37%**; equal-work total-wall ratio **+16.95%**. Arm wall medians alone were 236.788 → 235.165 ms and conceal the order-sensitive tail. Median packing time was 58.007 → 81.485 ms. These four pairs do not support adopting the pool. They also do not establish a precise browser slowdown.

Each observation uses a fresh Node process, one complete warmup, explicit GC before timing, four Node worker threads importing the real compression-worker entrypoint, actual Zstd WASM/dictionary resources, the real block/reference path, and a memory-backed `TermContentOpfsStore`. The timed region contains the 22 awaited appends and session close. Input loading/hashing and persisted-output hashing are outside that region. Parser work, deduplication, record/index writes, media, browser OPFS, and import finalization are excluded. Node was `v24.22.3`.

All eight corrected observations agree on source/resource identities, codec, worker count, selected content, and complete persisted output: **38,373,046 bytes**, SHA-256 `647d1b757c3e206aa037b4a31205651d8708e1a2a1f041162d96bb78344a9e2f`. The corrected runner SHA is `9e75db3ec08bcec9d92ce431e597410ea1001708ebc7ca68487d233fd1623d33`; worker bridge SHA is `f04d78ab2d17b05bab6bd523e5835d1abee4eb24b39f6f878910226871e787ec`.

### Separate production-codec allocation diagnostic

| Counter                             |    Baseline |        Pool |
| ----------------------------------- | ----------: | ----------: |
| Packed blocks                       |         382 |         382 |
| Packed logical bytes                | 389,687,485 | 389,687,485 |
| Newly allocated buffers             |         382 |          24 |
| Newly allocated capacity bytes      | 389,687,485 |  24,903,680 |
| Reused buffers                      |           0 |         358 |
| Peak capacity retained by this pool |           0 |  24,903,680 |

The pool returned/transferred 382 buffers totaling 395,837,440 capacity bytes. Its retained peak is **not total or peak process memory**: it excludes in-flight inputs, parser buffers, compressed outputs, WASM memory, and other storage. The allocation diagnostic has the same output hash as the corrected timing cohort. Reduced allocation counts did not establish a speedup.

### Correctness gates and their limits

The patch includes ownership, alias/detachment, lifecycle, late-return, worker-failure/fallback, actual-worker, and real-codec tests. Archived full-unit output reports 643 suites, 14,407 passing tests, and 47 skipped tests. That full run preceded the final retained-buffer-count adjustment from 16 to 32; final targeted cap tests and TypeScript checks passed afterward, but no new full-suite receipt is claimed for that one-constant adjustment. Main/test TypeScript, changed-file ESLint, and build logs are preserved. The initial failed full-unit log is also preserved: its two native compilation fixtures lacked the compiler configuration; the corrected run used LLVM 21. Build assets were copied into the worktree rather than left as a symlink when the build guard required that.

## 2. Rejected exact-parameter CDict reuse

The byte-only proof uses Zstd commit `82d322c4973d9e2968d94047a40892bc6d9a9bdf`, the repository's pinned source. It compares `ZSTD_compress_usingDict` with `ZSTD_compress_usingCDict`, caching `ZSTD_createCDict_advanced` results by all seven fields of `ZSTD_getCParams(-1, blockLength, dictionaryLength)`. The 16,384-byte trained dictionary, source bytes, level, and 382 block splits are unchanged. Four parameter tuples were used.

**All 382 frames differ.** Both arms pass all 764 native decode checks against their original blocks. The first block has 1,048,187 source bytes; usingDict produces 78,810 bytes and usingCDict produces 78,781, first differing at byte 14. Total compressed frame bytes are 31,103,602 and 31,076,057 respectively. This is a failed compressed-byte-preservation hypothesis. **No timings were performed.**

`cdict/result.json` records every block, tuple, source/compiler/dictionary hash, and output digest. `cdict/INITIAL-HARNESS-ASSERTION.md` preserves an initial pre-compression harness correction: CDict internally normalizes windowLog from the requested value to a dictionary-sized value, so the proof records both tuples instead of asserting internal window identity. The complete requested tuple remained the cache key; no candidate parameters changed.

Independent read-only review verified the ctypes signatures, field layouts, enum values, retained input lifetimes, pinned source, and recorded hashes. Native baseline frame bytes plus the 382 twelve-byte storage envelopes total 31,108,186 bytes, agreeing with the corrected component's compressed-byte total. This aggregate check does not replace frame-by-frame equality between native and WASM builds.

Native compilation used GCC 14.2.0 with `-O3 -DNDEBUG -fPIC -shared`. The pinned source loads raw dictionaries with its fast-table path and prepared CDicts with its full-table path; equal public compression parameters alone do not promise identical frames. This native proof is not a WASM or browser measurement. No `emcc`/emsdk installation was found on PATH or in the inspected common/workspace locations; the repository build recipe pins Zstd but does not pin an Emscripten version. No toolchain was installed and no runtime assets were changed.

## Reproduction

Verify the bundle first:

```sh
sha256sum -c SHA256SUMS
python3 verify.py
```

Use separate Manabitan checkouts rooted at baseline `467067650653c37c1f7d6b05d6737d070e1259cd`. For the candidate, apply `pool/frozen-c38459dcd.patch` to that exact base. `git am --committer-date-is-author-date`, with committer `Codex <codex@openai.com>`, reproduces commit `c38459dcdf480a052db21efa9a4996f39f267cd8`. Install the lockfile dependencies and run `npm run build:libs` in each checkout. This consumes the checked-in WASM resources and does not require a new Emscripten build. Compare generated resource hashes with the receipts before interpreting a rerun.

The locked Jitendex ZIP must be obtained separately and must match the archive hash above. Set `POOL_BASE_ROOT`, `POOL_CANDIDATE_ROOT`, `POOL_ARCHIVE`, `POOL_PREPARED`, and `POOL_OUTPUT` to absolute paths; use a new output directory. Prepare inputs once:

```sh
node pool/runners/prepare.mjs "$POOL_BASE_ROOT" "$POOL_ARCHIVE" "$POOL_PREPARED"
```

The resulting input digest and every group hash must match `pool/inputs/prepared-manifest.json`. Paths inside the manifest can differ. To repeat the corrected component, run the following sequentially while keeping other heavy work off the machine:

```sh
mkdir "$POOL_OUTPUT"
for pool_pair in 1 2 3 4; do
    if [ "$pool_pair" = 1 ] || [ "$pool_pair" = 3 ]; then
        pool_order='A B'
    else
        pool_order='B A'
    fi
    for pool_arm in $pool_order; do
        if [ "$pool_arm" = A ]; then
            pool_source="$POOL_BASE_ROOT"
        else
            pool_source="$POOL_CANDIDATE_ROOT"
        fi
        node --expose-gc pool/runners/run-jitendex.mjs \
            "$pool_source" "$POOL_PREPARED" \
            "$POOL_OUTPUT/jitendex-$pool_pair-$pool_arm.json" \
            > "$POOL_OUTPUT/jitendex-$pool_pair-$pool_arm.log"
    done
done
```

Run allocation diagnostics separately with `pool/runners/run-jitendex-allocation.mjs`; never combine those elapsed values with the timing cohort. Historical generic diagnostics use the preserved `run-instrumented.mjs` or `run.mjs` with `--no-instrumentation` as appropriate and remain labeled with their wrong-codec limitation.

For the native byte proof, obtain the pinned Zstd source separately and check out its exact commit. Set `CDICT_ZSTD_SOURCE`, `CDICT_NATIVE_LIBRARY`, and `CDICT_OUTPUT` to absolute paths. Build the native library:

```sh
(
    cd "$CDICT_ZSTD_SOURCE/build/single_file_libs"
    ./create_single_file_library.sh
    cc -O3 -DNDEBUG -fPIC -shared zstd.c -o "$CDICT_NATIVE_LIBRARY"
)
```

The original `cdict/prove.py` is preserved exactly, including its original local paths. `cdict/reproduce.py` rewrites only five filesystem path constants into a fresh output directory and launches the unchanged proof logic:

```sh
python3 cdict/reproduce.py \
    --prepared "$POOL_PREPARED" \
    --repository "$POOL_BASE_ROOT" \
    --zstd-source "$CDICT_ZSTD_SOURCE" \
    --library "$CDICT_NATIVE_LIBRARY" \
    --output "$CDICT_OUTPUT"
```

Exit code 2 means the expected byte-preservation rejection. Fresh output belongs in its own directory; original receipts must remain unchanged. The portable launcher does not produce a performance ranking.

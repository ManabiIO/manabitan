# Exact-tag score cache: complete held experiment evidence

This bundle preserves both fixed score-cache revisions and their complete experiments. **Neither revision is proposed for a runtime PR.** The repeat-only v2 retains a clear warm JMdict encoder benefit but fails every prospectively declared common-path bound. The first-use follow-up was conditional on passing those bounds, was never implemented, and has zero observations. Stop this mechanism; do not use the favorable actual-input result to erase the failed controls.

## Frozen source and exact input

Baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. V1 is local commit `bf44285cd06b1a4a832921c3669a2ca1659a9a76`, runtime SHA-256 `a05eb1220804d6ea79636a2e1575bd1e4378c29542b5cf09cfd138a958120f70`. V2 is `5565f279a12a6f99bc1719b9dbe9246f30624098`, runtime SHA-256 `7f4dbeb8447a0d2797b636cfcd5746a4c9c3b27df2f5b1526ff6b8fd7aa90871`. Both frozen runtime/test snapshots, exact baseline-relative patches, and the local checkpoint Git objects are included. No remote candidate ref is required to recover them.

One unchanged-baseline public-sink capture retains the actual 12 factory-admitted encoder inputs for all 528,299 JMdict rows. It includes every full private backing buffer, view offset, constructor, alias identity, descriptor, actual nonsequential row-to-unique reference, content offset base and expected output. The capture contains **8,618,752 input backing bytes plus 4,239,960 expected field bytes**, once, shared by both studies. No corpus data is normalized or reconstructed from the output to manufacture provenance. Its manifest SHA-256 is `3ee5d9636b63fb1d81faa59c782ed3388f67759dfacfa52ce391010e29bda9b7`.

All 12 groups' captured inputs are zero-offset, exact-size private backings. Every timed arm recreates those layouts through its own production factory. Full baseline source/storage parity also passes at capture: 43,315,677 persisted bytes, canonical digest `e61445478202dbbda9c22d91a5bc51e87b6b77ce0096898a37aad149cefa0400`, file-set digest `b9200f034c262f240ab55c1598c3c8a9703122c4495c1379deac06d6c80ac5f8`. This direct component is narrower than the enclosing sink and browser import.

## Changes and results

V1 retains the existing common-score table and adds a lazy 512-slot exact-tag cache for admitted private Int32 outliers. The authoritative Map retains every distinct score and insertion order. Actual Map reads fall from 269,193 to 6,223. Its fixed 24-block actual-input screen reports wall medians A/B/C of 10.844/7.810/10.761 ms per full input corpus. Geometric paired wall changes are −24.42% and −30.03% against the two identical baselines, with both descriptive 95% intervals below zero. Separate synthetic common-score controls remain too imprecise to exclude a small regression.

V2 confines all cache operations to the outlier branch, admits only existing authoritative Map hits, and allocates on the first repeated outlier. It removes v1's per-row cache-slot initialization and final refill guard. Actual Map reads are 7,676, with exact output and unchanged backings. Its fixed actual-input 24-block result remains favorable: geometric wall B/A −27.66% [−34.12%, −20.14%], B/C −25.44% [−34.56%, −14.53%]. Wall medians are 12.018/8.337/11.248 ms per full corpus. These are warm synchronous encoder results, not browser-import percentages.

Before any v2 observation, the original unstarted 24-block common-control plan was explicitly superseded by a fixed 144-block plan for each common scenario. Actual JMdict stayed at 24 blocks. Every observation still executes four complete input corpora, with two excluded warmup blocks and all six A/B/C orders balanced. The source, inputs, timing endpoint and v1 cohort did not change. The predeclared common criterion requires both geometric wall-time upper 95% bounds below +5% for each common scenario, plus CPU and identical-control review.

| V2 synthetic control   | Geometric B/A wall, 95% interval | Geometric B/C wall, 95% interval | Declared result        |
| ---------------------- | -------------------------------: | -------------------------------: | ---------------------- |
| Uniform zero           |          +2.49% [−2.40%, +7.39%] |         +4.96% [+0.22%, +10.00%] | Both upper bounds fail |
| All scores in −256…255 |          +5.24% [+1.16%, +9.38%] |          +5.69% [+1.90%, +9.62%] | Both upper bounds fail |

The all-in-range identical C/A wall estimate is −0.42% [−4.28%, +3.52%]. CPU estimates point in a similar direction but retain wider intervals. These controls change scores on cloned actual reference layouts; they are explicitly synthetic and establish neither an actual VNDB regression nor an import non-regression. Their failed predefined bound is sufficient to hold this candidate. There is no third refinement, larger replacement cohort, first-use acquisition or Jitendex capture in this bundle.

## Validation and retained failures

V1 has 81 focused tests, scoped lint and scoped types passing. Its earlier heap-capped lint OOM and pre-final style/type diagnostics remain. V2 has 87 focused tests across six suites, scoped lint, main types and scoped new-test types passing. Independent reviews cover exact tags, collision eviction/recovery, full Int32 extrema, first-score index zero, the Uint16/reserved-count boundaries, private versus shared/proxy/accessor fallbacks, original error order and lazy allocation. No full-suite/build pass is implied for v2: further optional validation was conditional on performance qualification and was not started.

Historical frozen manifests say zero measurements because they were written before acquisition; they remain unchanged. Current results are in the complete cohort reports and `score-cache-repeat-v2/disposition.json`. The conditional `first-use-design.md` is preserved as an unexecuted design, not evidence.

## Included material and archive verification

All original relative paths and payload bytes are preserved. The external manifest lists every member's byte count and SHA-256 and binds the full deterministic tar.gz. The manifest is external to avoid a circular self-hash exception. Symlink payloads and symlink directory components are rejected before any read.

The bundle includes the shared complete numeric capture, producer-capture helper and Node boundary adapters, original baseline verification receipt, three measured scenario reports and every observation for v1/v2, all module transformation bytes and identities, plans/protocols/analyses/reviews, original unstarted v2 plan and supersession receipt, source snapshots/patches/Git objects, census, failed and passed validation logs, fixture/runtime/dependency locks, and the unexecuted first-use design.

Omitted are dictionary ZIPs/media, installed dependencies, compiler/browser distributions, generated extension packages and full database files. Their exact fixture/runtime/complete file-set hashes and capture recipe remain. Numeric input replay and reanalysis do not require downloading the dictionary.

```sh
python3 evidence/durable-bundles/package-evidence-v2.py \
  --verify-manifest /absolute/path/score-cache-held-evidence-20261128-1b47.manifest.json
```

## Reanalyze the fixed data without new observations

Use Python with the recorded NumPy 2.3.5. Both scripts open the output exclusively and preserve every original block. Set `REANALYSIS` to a new output directory; never replace archived files.

```sh
python3 evidence/score-cache/encoder-inputs-plan/analyze.py \
  evidence/score-cache/actual-encoder-screen-v1 \
  "$REANALYSIS/cache-v1.json"
python3 evidence/score-cache-repeat-v2/encoder-study-common144-plan/analyze.py \
  evidence/score-cache-repeat-v2/actual-encoder-screen-v2-common144 \
  "$REANALYSIS/cache-v2.json"
```

The scripts verify their own source digest against the plan and the completed plan hash. Their fixed PCG64 seed is 20261128, with 100,000 paired-block resamples and linear percentile endpoints. V2 generates the identical index stream in bounded batches; the included synthetic preflight verifies this arithmetic.

## Recover exact source and reconstruct inputs

Start from a fresh baseline clone with its recorded dependency lock. The small Git pack contains only the two local candidate commits and their objects beyond the baseline; it needs that baseline ancestry. It creates no branch automatically:

```sh
git -C "$REPLAY/manabitan" checkout --detach 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2
git -C "$REPLAY/manabitan" index-pack --stdin \
  < evidence/durable-bundles/cache/cache-checkpoints.pack
git -C "$REPLAY/manabitan" worktree add --detach "$REPLAY/cache-v1" bf44285cd06b1a4a832921c3669a2ca1659a9a76
git -C "$REPLAY/manabitan" worktree add --detach "$REPLAY/cache-v2" 5565f279a12a6f99bc1719b9dbe9246f30624098
```

The original source snapshots also make the change reviewable without Git object recovery. Use Node 24.22.3 and build the unchanged generated libraries from the pinned lock in private ordinary directories. Do not point a candidate's generated `ext/lib` writes through a baseline symlink.

For a newly authorized recapture, the preserved capture helper accepts baseline, locked fixture directory and a new output report. Set `MANABITAN_ENCODER_CAPTURE_DIR` to a new directory (it must not exist). It calls the real parser/dedup/store path, copies actual encoder inputs before the unchanged production method, and requires complete equality with the retained baseline receipt. The pinned JMdict ZIP SHA-256 is `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`.

```sh
MANABITAN_ENCODER_CAPTURE_DIR="$REPLAY/new-input-capture" \
  node evidence/node-score-encoder-input-capture.mjs \
  "$REPLAY/manabitan" "$FIXTURES" "$REPLAY/new-capture-report.json" jmdict 0 1
```

Original plans and captures bind absolute runtime paths as well as bytes. A future acquisition in another workspace must register a new study and new complete baseline identity; do not edit the old plan or weaken its checks. For the existing capture, any path-only relocation of a working copy must preserve and independently verify all original source/runtime/input hashes and be explicitly recorded as a new derivation. The archived cohorts remain the authoritative completed evidence. This bundle does not authorize another timing run of the held mechanism.

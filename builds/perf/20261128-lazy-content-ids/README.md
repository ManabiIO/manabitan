# Lazy content metadata IDs: allocation review

This change avoids **4 MiB of live import-time ID-column capacity for JMdict and Jitendex, and 2 MiB for VNDB** in the pinned corpora. The six measured browser cells support an allocation-only review. They establish no repeatable import-speed gain or process-peak reduction.

The product change is one runtime file plus focused tests. The internal numeric-index accessor returns positive zero without allocating a Float64 column until a caller needs a nonzero ID or negative zero. Missing and malformed **numeric** indexes retain their prior undefined result. Legacy IDs, allocation failure handling, dictionary-name interning, growth, rollback/reuse, contiguous publication and alias checks retain their supported behavior. Arbitrary non-number TypedArray property keys are outside this private API; the independent review confirms production callers use numeric indexes.

## Direct allocation evidence

| Corpus   |   Rows / groups | Metadata entries | Live ID capacity before |   After |
| -------- | --------------: | ---------------: | ----------------------: | ------: |
| JMdict   |    528,299 / 12 |          362,032 |         4,194,304 bytes | 0 bytes |
| Jitendex |    436,555 / 22 |          363,243 |         4,194,304 bytes | 0 bytes |
| VNDB     | 6,648,310 / 170 |          157,150 |         2,097,152 bytes | 0 bytes |

These are directly inspected typed-array capacities from complete-corpus replays through the actual source planner, native workers and database owner. Every ID is positive zero, and metadata/reference/cache digests and exact-read counters agree. The replay uses temporary raw backing instead of compression/OPFS; the browser campaign separately exercises complete imports and retained persistence/readback/media checks. Import cleanup clears the metadata columns in both versions, so this is working capacity during import, not permanent memory per installed dictionary. Fixture URLs, SHA-256 values and source identities are in [index.json](index.json).

## Measured browser campaign

[Run 46104994552](https://github.com/ManabiIO/manabitan/actions/runs/46104994552) measures exact source `da03aa70f88d4b0616eeab8ed251f48a17f8de13` against baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Each independent host/order cell contains 12 paired comparisons and four unchanged-code controls, with fresh browser profiles. Node 22.22.0 and Chromium 153.0.8010.12 are recorded. Original and instrumented harness bytes, package-member identities, all observations and controls are retained.

| Dictionary/order | Paired median | Equal-work change | Descriptive 95% interval for paired median | Faster pairs | Control equal work | Memory screen                  |
| ---------------- | ------------: | ----------------: | ------------------------------------------ | -----------: | -----------------: | ------------------------------ |
| jmdict/AB        |       -0.501% |           +0.252% | [-1.828%, +2.762%]                         |         6/12 |            +2.454% | pass, 4/4 qualified            |
| jmdict/BA        |       +0.181% |           +0.248% | [-0.912%, +1.203%]                         |         5/12 |            -0.564% | pass, 4/4 qualified            |
| jitendex/AB      |       +0.835% |           +1.147% | [-1.393%, +3.629%]                         |         4/12 |            -0.359% | pass, 4/4 qualified            |
| jitendex/BA      |       -0.389% |           -1.551% | [-0.871%, +0.385%]                         |         8/12 |            -0.113% | pass, 4/4 qualified            |
| vndb/AB          |       -0.409% |           -0.595% | [-1.455%, +0.945%]                         |         7/12 |            +0.032% | unqualified, 0/4; metrics null |
| vndb/BA          |       -0.780% |           -0.439% | [-1.679%, +1.425%]                         |         7/12 |            +0.943% | pass, 4/4 qualified            |

Negative changes mean lower elapsed time. The intervals apply to paired medians, not equal-work totals. Every interval crosses zero; hosts/orders and controls are not pooled or subtracted. Jitendex AB's +8.951% worst pair remains in the record.

All **216 ordinary, 12 exhaustive-media and 24 instrumented semantic receipts** agree within their cells and across each dictionary's orders. Five of six memory cells pass the declared regression screen. The independent auditor recomputes **2,142 original scans**; 20 of 24 observations qualify. These counts describe evidence coverage, not pooled performance.

### Memory bounds and retained failure

The registered screen requires every observation to qualify and, separately for sampled peak PSS and private bytes, **median paired change <=+5% and maximum paired change <=+10%**. Each change is 100×(B/A−1) for one of two fixed pairs. The unchanged rule is in baseline `dev/perf/import-memory-20261125-a7f7/protocol.py`; `audit_memory.py` independently checks it. Jitendex AB private memory has +2.142% median and +5.249% maximum, so it passes those bounds. A pass is not evidence that process peaks fell.

VNDB AB fails only the fixed 250 ms covered-scan-gap criterion: A1 = 254.629514ms, B1 = 303.469410ms, B2 = 290.282453ms, A2 = 253.025429ms. Every import succeeds, but all memory comparison metrics remain null. Attribution finds long complete interior scans with normal 25–28 ms interscan waits; no threshold, observation or cohort is replaced. The independent VNDB BA cell passes, while the AB limitation remains disclosed.

The initial `f17102b` campaign is preserved separately: all semantic checks pass, all timing intervals cross zero, and 23/24 memory observations qualify. Its JMdict AB observer failure and unstable VNDB AB controls remain visible. Those observations are not relabeled as later-source qualification.

## Exact source and validation mapping

| Source                                     | Role and completed evidence                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `f17102bac19688f1115d1d630720838abf0df00c` | All three complete-corpus allocation/parity replays and the initial browser campaign                                                                                                                                                                                                                  |
| `da03aa70f88d4b0616eeab8ed251f48a17f8de13` | Corrects missing/malformed numeric reads; 670 unit files, 15,156 passing tests, 47 existing skips, zero failures; 230 focused cases; 30-seed differential replay with 7,500 operations and 315,604 comparisons; seven dry builds; four hosted TypeScript projects; complete six-cell browser campaign |
| `b0a4532ed4209ad289aa28ac58a92a10e9d54841` | Review source; 21 changed-file tests pass; required repository-configured scoped ESLint passes for all four changed JS files; independent numeric-API code review finds no blocker; complete runtime AST equals measured source                                                                       |

Full unit coverage was proven as the exact union of eight sequential one-worker shards on Node 24.22.3. Focused cases overlap that full-suite count. The review source fixes four original lint-style findings. Its only runtime delta from the measured source is whitespace; a provenance assertion checks the complete `ext` diff contains only the selected database file. Full Acorn ASTs match after removing only source locations, SHA-256 `e79e9632b18d66abfa223178589864fadbc52ca47174c6deef163ebbefe2d888`. Test-only edits use explicit typed snapshots and multiline formatting. Measured package bytes and Git IDs remain unchanged.

The extra [whole-repository static rerun 46111003657](https://github.com/ManabiIO/manabitan/actions/runs/46111003657) is **queued as of 2026-11-28 06:15:44 UTC**. It is additional evidence, not a missing required changed-code gate. Earlier exit 137 attempts, the wrapper exit 127 that never started ESLint, and the measured-source lint findings are retained. Its eventual result can be appended without rewriting any archived observation.

## Evidence archives

[index.json](index.json) maps claims, exact source revisions, fixtures, artifact IDs/digests and decisive receipts. The archives retain 2,771 indexed payloads. The outer archives and every internal payload were verified byte-for-byte. No current-workspace symlink is needed after extraction.

| Archive                                                                                  |     Bytes | Indexed payloads | SHA-256                                                            |
| ---------------------------------------------------------------------------------------- | --------: | ---------------: | ------------------------------------------------------------------ |
| [lazy-ids-initial-evidence.tar.gz](lazy-ids-initial-evidence.tar.gz)                     | 7,408,886 |            1,081 | `1a758f3f6a015a3e77adba4652184e65d6d42a824f603d62579496b5c99151c0` |
| [lazy-ids-final-first-three-evidence.tar.gz](lazy-ids-final-first-three-evidence.tar.gz) | 5,745,846 |              851 | `5789f4bff4e3438b9cfef5079c7039812e71270b4b3041527d1c054531438661` |
| [lazy-ids-final-remaining-evidence.tar.gz](lazy-ids-final-remaining-evidence.tar.gz)     | 5,302,296 |              839 | `61761ed4ff8bc51a8d4a016122352856f1c1da619c22b83e82742253d7fbfddd` |

Run the portable verifier from this directory before extraction:

```sh
python verify-lazy-id-evidence.py
```

The retained [verification receipt](lazy-ids-evidence-verification.json) reports all 2,771 payloads verified. The first archive contains `initial-browser/` and `component-and-gates/`. The second contains final JMdict AB/VNDB AB/VNDB BA under `measured-da03/`, original static-gate receipts, and `source-and-review-validation/`. The third completes `measured-da03/` with JMdict BA/Jitendex AB/Jitendex BA and adds `review-audit/`, including the complete independent audit, native source review and portable auditor.

## Reproduce the receipt audit

Set a study root and extract each archive separately so each internal `receipt-index.json` remains distinct:

```sh
export MANABITAN_STUDY_ROOT="$PWD/replay"
mkdir -p "$MANABITAN_STUDY_ROOT/unpacked/initial"
mkdir -p "$MANABITAN_STUDY_ROOT/unpacked/first-three"
mkdir -p "$MANABITAN_STUDY_ROOT/unpacked/remaining"
tar -xzf lazy-ids-initial-evidence.tar.gz -C "$MANABITAN_STUDY_ROOT/unpacked/initial"
tar -xzf lazy-ids-final-first-three-evidence.tar.gz -C "$MANABITAN_STUDY_ROOT/unpacked/first-three"
tar -xzf lazy-ids-final-remaining-evidence.tar.gz -C "$MANABITAN_STUDY_ROOT/unpacked/remaining"
mkdir -p "$MANABITAN_STUDY_ROOT/hosted-studies/lazy-ids"
mkdir -p "$MANABITAN_STUDY_ROOT/hosted-studies/lazy-ids-final"
cp -a "$MANABITAN_STUDY_ROOT/unpacked/initial/initial-browser/." "$MANABITAN_STUDY_ROOT/hosted-studies/lazy-ids/"
cp -a "$MANABITAN_STUDY_ROOT/unpacked/first-three/measured-da03/." "$MANABITAN_STUDY_ROOT/hosted-studies/lazy-ids-final/"
cp -a "$MANABITAN_STUDY_ROOT/unpacked/remaining/measured-da03/." "$MANABITAN_STUDY_ROOT/hosted-studies/lazy-ids-final/"
```

Create a Manabitan checkout or worktree at `$MANABITAN_STUDY_ROOT/baseline`, checked out at `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The auditor imports its frozen baseline protocol and reads exact Git source objects. Import the preserved source commits into that repository:

```sh
git -C "$MANABITAN_STUDY_ROOT/baseline" bundle verify "$MANABITAN_STUDY_ROOT/unpacked/first-three/source-and-review-validation/lazy-ids-source-f171-da03-b0a.bundle"
git -C "$MANABITAN_STUDY_ROOT/baseline" fetch "$MANABITAN_STUDY_ROOT/unpacked/first-three/source-and-review-validation/lazy-ids-source-f171-da03-b0a.bundle" \
  refs/heads/lazy-ids-initial:refs/heads/receipt/lazy-ids-initial \
  refs/heads/lazy-ids-measured:refs/heads/receipt/lazy-ids-measured \
  refs/heads/lazy-ids-review:refs/heads/receipt/lazy-ids-review
python "$MANABITAN_STUDY_ROOT/unpacked/remaining/review-audit/audit-current-receipts.py" \
  "$MANABITAN_STUDY_ROOT/hosted-studies/lazy-ids-final/jmdict/AB" \
  "$MANABITAN_STUDY_ROOT/hosted-studies/lazy-ids-final/jmdict/BA" \
  "$MANABITAN_STUDY_ROOT/hosted-studies/lazy-ids-final/jitendex/AB" \
  "$MANABITAN_STUDY_ROOT/hosted-studies/lazy-ids-final/jitendex/BA" \
  "$MANABITAN_STUDY_ROOT/hosted-studies/lazy-ids-final/vndb/AB" \
  "$MANABITAN_STUDY_ROOT/hosted-studies/lazy-ids-final/vndb/BA" > "$MANABITAN_STUDY_ROOT/replayed-audit.json"
```

Inspect every returned object for `auditError`; the script retains its original report-oriented exit behavior. Compare parsed results by `cohort` against `unpacked/remaining/review-audit/lazy-final-independent-receipts.json`; all fields should agree despite array ordering. The explicit `MANABITAN_STUDY_ROOT` override was checked on one existing cell using a genuinely separate directory skeleton, with output identical to the original auditor. Original and portable script bytes and their hashes are retained.

The 5,949-byte Git bundle has baseline as its sole prerequisite and preserves all three exact local source IDs. Its independent import proof used a baseline-only store, confirmed candidates absent before import, then passed strict fsck and the unmodified AST verifier. For AST reproduction, create a worktree at `b0a4532ed4209ad289aa28ac58a92a10e9d54841` with its pinned dependencies and run `source-and-review-validation/verify-lazy-ids-lint-ast.mjs WORKTREE`. The replay/validation scripts, source hashes and original failures are indexed rather than replaced by a summary claim.

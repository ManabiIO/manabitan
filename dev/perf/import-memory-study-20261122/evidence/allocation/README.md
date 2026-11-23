# Import content-plan scratch allocation evidence

These receipts measure scratch buffers for every term row in the pinned JMdict,
Jitendex, and VNDB archives. They establish allocation removal and component
output parity. They do not measure elapsed import time, process RSS, persistent
storage, media file readback, or browser restart behavior.

The eight original files, including the original runner, are preserved byte for byte.
`provenance.json` binds their sizes and SHA-256 values, records the published
source mapping, and identifies the portable runner. `verify-receipts.mjs`
independently checks all original records, sums, maxima, formulas, and digests.

## Source identity and results

- Baseline: `5e1f8c12f7ff798ba407323aff675cb23b22af02`.
- Original local candidate: `de6027ee16ee91b8c57f3087f4628817678ff177`.
- Published runtime candidate: `f8dae7026d57488d4097caba942783bc1bbef6d4`.
  Its three measured runtime files match the original candidate's source hashes
  exactly. Its other runtime changes are outside this component measurement.
- Pinned fixture tooling: `4e568fcde29fb93df9a856eab5d177b741d99bce` (PR #803).
- Original environment: Node `v24.22.3`, hardware concurrency 9, no device-memory
  hint. The portable runner explicitly recreates that planner profile and
  reports it; the unchanged production policy selects five workers.

| Dictionary |      Rows | Groups | Parser output scratch removed | Canonical scratch allocation removed | Maximum canonical scratch per group, before → after |
| ---------- | --------: | -----: | ----------------------------: | -----------------------------------: | --------------------------------------------------: |
| JMdict     |   526,942 |     20 |                   7,137,008 B |                          4,215,536 B |                                 437,264 → 197,264 B |
| Jitendex   |   435,448 |     22 |                   6,381,056 B |                          3,483,584 B |                                 358,704 → 166,704 B |
| VNDB       | 6,648,310 |    170 |                  54,449,392 B |                         53,186,480 B |                                  330,072 → 10,072 B |

For a group with `R` rows and `U` unique contents, baseline scratch is `8U + 8R`
bytes. Candidate parser scratch is zero; the canonical owner allocates `8U`
bytes. The cumulative reduction is exactly `8R`, totaling **60,885,600 bytes**
across 7,610,700 rows. The parser omits 848 scratch buffers across 212 groups.
These totals describe allocated buffer capacity; they are not process-memory
high-water marks. The per-group maxima are component maxima.

## Measurement scope

The runner invokes the production group planner with a metadata-only worker
shim. The shim records planned jobs and acknowledges empty results; its
synthetic timing/profile values are discarded. Each planned group is then
inflated by zip.js with CRC verification and passed sequentially through the
real native parser. A fresh database and real native canonical resolver process
each group, so cross-group persisted-content lookup is outside this receipt.

The digests cover parser columns, content bytes, media-row representations,
prepared lookup output, and the canonical pending hash/span/reference columns
selected in the runner. Every group matches between arms. Both arms make one
native canonical call per group with zero fallbacks. Actual parser-worker
transfer behavior is covered separately by the runtime PR's unit test.

The frozen `plan-scratch-receipt.mjs` contains the original local fixture paths
and uses host CPU information. Use `portable-runner.mjs` for reproduction. It
accepts exactly four positional arguments: dictionary ID, source checkout,
output JSON, and fixture checkout. It loads the pinned lock including VNDB from
the fixture checkout and reads archives under its `builds/e2e-dictionary-cache`.
It resolves the same ESM zip.js dependency from that checkout's installed
dependencies, so this evidence directory needs no adjacent `node_modules`.

## Verify the archived evidence

From the repository root containing this package, using Node 24.22.3:

```sh
cd dev/perf/import-memory-study-20261122/evidence/allocation
node verify-receipts.mjs
```

This command needs only Node and the package files. It does not download data,
parse dictionaries, or modify files.

## Reproduce baseline and candidate

Continue from the evidence directory above. These commands create three
detached worktrees and leave the current checkout untouched:

```sh
study_evidence="$PWD"
study_repo="$(git rev-parse --show-toplevel)"
study_root="$(mktemp -d "${TMPDIR:-/tmp}/manabitan-allocation.XXXXXX")"

git -C "$study_repo" fetch origin 5e1f8c12f7ff798ba407323aff675cb23b22af02
git -C "$study_repo" fetch origin f8dae7026d57488d4097caba942783bc1bbef6d4
git -C "$study_repo" fetch origin 4e568fcde29fb93df9a856eab5d177b741d99bce
git -C "$study_repo" worktree add --detach "$study_root/baseline" 5e1f8c12f7ff798ba407323aff675cb23b22af02
git -C "$study_repo" worktree add --detach "$study_root/candidate" f8dae7026d57488d4097caba942783bc1bbef6d4
git -C "$study_repo" worktree add --detach "$study_root/fixtures" 4e568fcde29fb93df9a856eab5d177b741d99bce

for study_arm in baseline candidate fixtures; do
    npm --prefix "$study_root/$study_arm" ci
done
for study_arm in baseline candidate; do
    npm --prefix "$study_root/$study_arm" run build:libs
done
node "$study_root/fixtures/dev/perf/prepare-dictionaries.js" vndb
```

`build:libs` validates and copies the checked-in native artifacts; this
component reproduction does not require a Clang installation. Fixture
preparation maintains the standard cache, including JMnedict, and explicitly
adds VNDB. The receipt commands below process only JMdict, Jitendex, and VNDB.
Existing valid cached archives can be reused at those cache paths.

```sh
study_output="$study_root/output"
mkdir -p "$study_output"

for study_dictionary in jmdict jitendex vndb; do
    for study_arm in baseline candidate; do
        node --expose-gc "$study_evidence/portable-runner.mjs" \
            "$study_dictionary" "$study_root/$study_arm" \
            "$study_output/plan-scratch-$study_dictionary-$study_arm.json" \
            "$study_root/fixtures"
    done
done

node "$study_evidence/verify-receipts.mjs" \
    "$study_evidence" "$study_output"/*.json
```

The final command compares every reproduced group and count against the
archived receipts. To reproduce only the JMdict candidate, run its single
portable-runner command and pass that JSON alone to the verifier. No browser
or extension session is required.

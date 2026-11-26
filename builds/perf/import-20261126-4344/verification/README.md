# Import optimization verification — 2026-11-26

This bounded evidence set independently checks the archive-classification and
compact-score-validation changes against develop
`0143e9596cd8f790d5e166d4ba6a2425fbc57f14`. It contains correctness and exact work
counts. It contains no complete-import performance measurements.

## Results

- **Archive classification:** all three complete locked ZIP catalogs and a
  15,023-name adversarial catalog produce identical ordered bank lists and retain
  the original entry objects. Default, explicit `undefined`, explicit custom,
  and pruned query callers are checked. The built-in prefix guard skips 1 / 255 /
  146,571 entries for JMdict / Jitendex / VNDB, avoiding exactly 6 / 1,530 /
  879,426 regular-expression tests respectively.
- **Compact score validation:** 42 single-process comparisons pass through the
  actual sidecar constructor. They compare exact output bytes or exact exception
  type/message with baseline, including odd/even row counts, first/middle/last
  invalid keys, sentinel values, aligned shifted views, shared buffers, padding,
  invalid dimensions, truncated fields and surplus bytes. This is an independent
  Node assertion replay, not a successful Vitest run.
- **Fixture acquisition:** all three ZIP sizes and SHA-256 hashes match the lock.
  A separate complete JSON traversal counts every term row: 528,299 JMdict,
  436,555 Jitendex and 6,648,310 VNDB rows. The receipt's media fields are expected
  values from the lock, not a new media-content verification.

| Corpus   | Term banks | Term rows | Uncompressed term JSON bytes |
| -------- | ---------: | --------: | ---------------------------: |
| JMdict   |         53 |   528,299 |                  171,617,523 |
| Jitendex |        219 |   436,555 |                  538,927,310 |
| VNDB     |        665 | 6,648,310 |                4,267,992,967 |

## Storage evidence audit

`storage-evidence-audit.json` independently reconciles the adjacent
`score-validation-index.json` and its 23-member raw archive. All member sizes and
hashes, fixture hashes, source pins, source-bank names and sizes, group/profile/run
counts, and timing statistics agree. The accepted native component acquisitions
cover 7,613,164 rows in 937 record/sidecar runs, with exact writer-argument and
sidecar-envelope equality. All rows use compact score fields. The audit reads
the original evidence and ZIP directories; it does not rerun the native parser.

Encoded output digests agree with the original receipts; raw envelopes are not
archived, so those digests are not independently recomputed. The index explicitly
corrects old JMdict/Jitendex CPU/memory labels and excludes the interrupted first
VNDB attempt. One-bank replay does not establish production-worker, compression,
persistence or browser correctness. Exploratory validator timings improve in the
local sample; full sidecar timings remain inconclusive and establish no complete
import speedup. The portable audit script and its exact scope are retained here.

## Composed source

Both independent checks also pass against composed commit
`feac5eeb8a058b976a5f49448a870ec2be6ad183`, tree
`378638700e03c64fadcaa87624bc0726d68f3fe2`, compared with a detached
`0143e9596cd8f790d5e166d4ba6a2425fbc57f14` checkout. The four catalog cases and all
42 sidecar/rejection cases pass. Their fresh receipts and logs are in `combined/`.
This checks the two changed product functions in the composed tree; it is not a
new complete-import, browser or full-suite execution.

## Reproduction

Both JavaScript programs accept repository and fixture paths as arguments. They
import the actual product modules, record their hashes, and reject source changes
during execution. Use baseline and candidate checkouts with installed dependencies
and generated libraries. Run from any directory; write fresh receipts outside
this preserved evidence set.

```sh
node catalog-independent-review.mjs /path/to/baseline /path/to/catalog-candidate /path/to/fixtures /tmp/catalog-review.json
node compact-score-independent-review.mjs /path/to/baseline /path/to/score-candidate /tmp/score-review.json
python count-fixture-rows.py /path/to/baseline /path/to/fixtures /tmp/fixture-rows.json
```

The JSON receipts preserve their original absolute acquisition paths and local
Git commits. Those paths are provenance, not required reproduction locations.
`provenance.json` records frozen tree identities and confirms unchanged runtime
hashes after subsequent test-only formatting commits. The scripts' hashes match
their own acquisition receipts. The fixture-count reproducer was packaged after
the original inline Python traversal; it uses the same hash/count algorithm and
was not reacquired to create this bundle.

Frozen remote source heads and trees are recorded in `provenance.json`: PR #931
head `752706ebbc0156096cf2727ba6651d223a9132fd`, tree
`ce9d574df46be5c8f8f223ba311a07f7e9197771`; PR #944 head
`fbc49eb08c00097b91ddf9c90ab94e90b9da799b`, tree
`6a68b5724de33799e77f2ae68690612913621bd8`. The shared import-experiment handoff
contains the native corpus and read-only evidence-audit reproduction commands.

## Local limitations and retained failures

The two successful independent Node checks used Node 24.22.3. No browser import
timing was acquired locally. The Playwright browser download returned HTTP 403,
and the installed Chromium launcher pointed to an absent executable. The attempted
release baseline run then failed during package creation with `ENOSPC`, before
browser startup or import.

The new focused Vitest run used one worker but timed out during worker startup:
zero tests executed. Initial test lint found six style errors; all were corrected
before the final test commit. The final source/test lint process was killed with
exit 137 before producing a lint result. The source-bound Node assertion replay
passed all 42 cases. Hosted product-PR checks remain the full-suite gate.

The adjacent logs retain these failures; they have not been replaced by passing
measurements. This bundle does not claim complete persisted media equality, a
browser speedup, or a measured peak-memory reduction. The audited native
record/sidecar parity has the narrower scope described above.

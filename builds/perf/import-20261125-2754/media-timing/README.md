# Current native media projection: whole-import screen

The current-base VNDB screen shows approximately **4–5% lower import time**
for native media-path projection. These six paired blocks are exploratory.
The separate memory study remains blocked by VNDB scan-coverage failures, so
this result does not establish promotion or independent qualification.

## Frozen source and acquisition

- Workflow: [45642169759](https://github.com/ManabiIO/manabitan/actions/runs/45642169759).
- A and identical-product control C: `7d1643e6147a10cb2165e9744cf0e63b59e46632`, tree `99d23f16e973c7ae9feba77ca3643d1c27dfb93d`.
- B: `7a8b25a44a3fe165107ed816377cc72bb0fac67d`, tree `093a0be94fcf336ab5a0113b80fae7481855935a`.
- The later PR #875 head `5afd2e97ec2707b150acfde61115aee688547a78` changes only `test/term-bank-experiments.test.js` and `test/term-bank-media-projection.test.js`. Product source and build inputs match the frozen candidate exactly; these measurements remain labeled with their actual source commit.
- Six fixed balanced block orders: `ABC`, `CBA`, `BAC`, `CAB`, `BCA`, `ACB`.
- Each corpus retains three excluded warmups, 18 timed observations, and two separate exhaustive-media diagnostics: 23 reports per corpus, 69 total.
- Node `v22.22.0`, Chromium `153.0.8010.12`, ordinary Chrome release packages, no harness overlay, no import flags, and no tracing.

All three cohorts completed their original schedules. Every raw report was
reopened with the unchanged frozen benchmark validator; source/package identity,
lookup/content receipts, storage policy, and paired analysis reconciled exactly.
No observation was replaced or dropped. The original protocol and all warmups,
diagnostics, raw reports, runner logs, manifests, source hashes, and audit code
are retained.

## Paired timing results

Negative changes mean lower candidate import time. Intervals are descriptive
percentile bootstrap intervals using 10,000 block-paired resamples and the frozen
seed; no multiple-comparison correction is applied.

| Corpus   | B/A paired median | Descriptive 95% interval | B/C paired median | Identical-product C/A median | B/A faster pairs |
| -------- | ----------------- | ------------------------ | ----------------- | ---------------------------- | ---------------- |
| JMdict   | -1.0439%          | [-4.0248%, +1.4776%]     | -1.1512%          | +0.0549%                     | 4/6              |
| Jitendex | -0.1231%          | [-0.3968%, +0.8376%]     | +0.0482%          | +0.3524%                     | 3/6              |
| VNDB     | -5.0427%          | [-6.5649%, -1.8562%]     | -4.0169%          | -0.6947%                     | 5/6              |

VNDB baseline A's median is 6,593.85 ms and B's is 6,292.20 ms. The sum-of-work
B/A change is -4.5244%. Against control C, all six VNDB pairs favor B, with a
descriptive interval of [-5.7527%, -2.9346%]. The identical-product C/A interval
is [-2.6279%, +2.5532%]. Read these controls alongside the candidate comparison;
the current screen is not pooled with the earlier PR #875 studies or another
stage.

The [independent audit summary](independent-audit-summary.json) retains every
pair, all medians and intervals, equal-work comparisons, and audit outcomes.
All individual durations remain in the archived `analysis.json`,
`observations.json`, and original observation reports.

## Correctness and storage

The baseline/candidate exhaustive diagnostics match all source-media receipts:

| Corpus   | Media files | Media bytes | Complete OPFS byte range |
| -------- | ----------- | ----------- | ------------------------ |
| JMdict   | 0           | 0           | 43,520,477–43,520,477    |
| Jitendex | 236         | 4,992,155   | 67,466,332–67,466,332    |
| VNDB     | 146,570     | 188,131,284 | 609,553,611–609,553,611  |

VNDB's exhaustive source-media digest is
`ea94d392bc833baf0bee7b3d6becc3d3517eee84ee314a44986438ac6d5217cb`.
Every observation also passes full row inventory, deterministic lookup/content
receipts, and restart checks. These are the harness's defined semantic checks;
exhaustive media equality does not imply exhaustive lexical readback.

## Retained archive and portable replay

`media-timing-45642169759.text.tar.gz` retains 635 text files totaling
22,648,187 uncompressed bytes. Its compressed size is 2,848,626 bytes and its
SHA-256 is
`5e40ca5d689ac40c942cd1767b943ed0f1dfd350704b84321fb82f81ad0580fa`.

[archive-manifest.json](archive-manifest.json) records every retained member,
all three original artifact identities/digests/URLs, and six omitted generated
Python bytecode files. Every original textual artifact member is retained
verbatim. The original Actions ZIP containers are omitted. Release ZIP payloads
were absent from the original timing artifacts; their original package-entry
manifests and exact ZIP hashes are retained as supplied.

Run these commands from a checkout containing this evidence branch, replacing
the repository, Node, and fresh extraction paths with locations on your machine:

```sh
python3 builds/perf/import-20261125-2754/tools/verify_text_archive.py \
  builds/perf/import-20261125-2754/media-timing/archive-manifest.json \
  --extract /absolute/path/to/fresh-media-timing-extraction

python3 builds/perf/import-20261125-2754/tools/audit_timing.py \
  --auditor /absolute/path/to/fresh-media-timing-extraction/independent-audit/audit_cohort.py \
  --repository /absolute/path/to/repository-checkout \
  --node /absolute/path/to/node-v22.22.0 \
  --candidate 7a8b25a44a3fe165107ed816377cc72bb0fac67d \
  /absolute/path/to/fresh-media-timing-extraction/artifacts/jmdict/cohort \
  /absolute/path/to/fresh-media-timing-extraction/artifacts/jitendex/cohort \
  /absolute/path/to/fresh-media-timing-extraction/artifacts/vndb/cohort
```

The portable adapter loads the hash-verified captured storage policy and binds
only the repository and Node locations of the original auditor. The original
validation, schedule, calculations, and acceptance rules remain unchanged. It
requires exact equality with the retained independent audit result. Saved
reports are replayed without browser acquisition. The repository's relevant
harness files must match the frozen hashes; this evidence branch preserves
those baseline files.

# Independent latest metadata Jitendex/VNDB audit

Both completed A/B corpus receipts pass the independent read-only audit. This supplement reviews hosted run **46144729522**, tooling **8ec2c45d182dd7615317e1675197aadd494ae964** (tree **b306fdf5aca3b73064ae74835bdac7e30ef1b9fb**). Product A is **a300da36d00df8e353c5679b1528b50a1299b75f**; product B is **86cd5c18d325488b0ecb04c552d1dc83567de9d2**. Their exact source trees and full helper/source identities are pinned in `audit-pins.json` and the raw artifacts.

| Corpus | Rows | Actual groups | Owned backing avoided | Complete persisted-output oracle |
| --- | ---: | ---: | ---: | --- |
| Jitendex | 436,555 | 22 | 4,194,304 bytes | `16ea2af33a07c79d163d5c16cc73276940a9d5ab46776c0b2d300d70514ae6ff` |
| VNDB | 6,648,310 | 170 | 1,048,576 bytes | `01aa55b3440a4bb5f6831a5e3c94eb20c2f7a672029824b00b31e3738043ea62` |

Jitendex avoids 2 MiB each for the signature1 and dictionary-name backing columns. VNDB avoids 1 MiB for signature1; its mixed dictionary names require the physical name-ID array, so that column contributes no final saving. These are exact owned-array allocation differences, not measured process peak-memory reductions or import speedups.

## What was independently checked

The auditor independently downloaded and checked both complete ZIP identities, enumerated and hashed every original member, bound all reported source and helper identities to the frozen public tooling, checked all source/fixture/group/output receipts, and reran the exact frozen comparator. Every recomputed comparison field matches its original; only the independently relocated input directory strings are normalized after their final path components are checked. The complete output-oracle bytes are also compared to the separately fetched eight-member frozen oracle archive, rather than relying only on A/B equality.

All 23 independently decoded logical metadata columns match. The raw-file checks retain generation linkage before normalizing the declared generation bytes. All 26 unchanged contracts and all 15 real-SQLite/OPFS/public-sink controls pass on each arm: 112 passing contract observations across the two hosted jobs. Source gates include 42 canonical runtime/asset identities per arm and 20 frozen helper files. Every actual legacy-root state, worker/store drain and owned-resource cleanup receipt passes.

The public-sink control writes two real term rows during one record import session, closes only content I/O for the intermediate cold exact-read boundary, retains the immutable-shard append guard, performs real scoped glossary invalidation and decodes both final rows. Empty-glossary invalidation preserves the entire fresh SQLite export. The separately seeded real invalidation correctly changes SQLite bytes while preserving unrelated rows and the epoch-zero legacy root. No resolver, exact comparison, invalidation or append guard is bypassed.

The acquisition ran Node **v22.22.0**. The local read-only receipt/comparator audit ran Node **v24.22.3**. No corpus, importer, worker, browser or timing acquisition was rerun during this audit.

## Retained evidence

`independent-audit-index.json` is the compact result. `independently-recomputed-receipts.tar.xz` contains both full independently recomputed comparisons, exact command/status/stdout/stderr receipts, all raw-artifact member hashes, the exact two comparator sources and the audit-schema correction history. `receipt-archive-members.json` records every member and confirms reopened byte verification. Raw hosted artifacts remain separately preserved by the producer publication:

- Jitendex artifact **15263545780**, 195,000 bytes, SHA256 `be4d01efa18294ea5b67366949267db2288635afffdf5af9f07ad7d83a4259a5`; Git blob `380883689ffc295d00a503358c01606e8624e3cf`.
- VNDB artifact **15263351327**, 833,958 bytes, SHA256 `0440aa2918394ffe7aaec47adfaf910ff5333f6995e60a4ade3e0ce3e12cfc8d`; Git blob `f12994a851d44a3d216e40aba3c6408550e49a6b`.

An initial custom-auditor attempt incorrectly assumed that `metadata-allocation.json` was the final allocation object instead of its wrapper. The original script and exact one-check correction are preserved. Version2 checks every wrapper field and passes. The underlying source, raw reports, frozen comparator and independently retained oracles were unchanged; this was not a product or acquisition failure.

## Reproduction without another import

Use Python3 and Node, preserving enabled Python assertions. Put the two exact ZIPs in a directory under their original names:

- `latest-metadata-legacy-context-jitendex-46144729522.zip`
- `latest-metadata-legacy-context-vndb-46144729522.zip`

Retrieve the exact `verification-oracles.tar.gz` from tooling commit `8ec2c45d182dd7615317e1675197aadd494ae964`, path `builds/perf/20261128-4d9f-latest-metadata-legacy-context/verification-oracles.tar.gz` (Git blob `ae9a7d731b0b257e71256726003b3fe25699c69c`, 74,109 bytes, SHA256 `456120a04cb75c4772aeedba7738060d0a7ed956f18610f292aea5b501022a71`). Then run from this directory:

```sh
mkdir retained-receipts
tar -xJf independently-recomputed-receipts.tar.xz -C retained-receipts
python3 audit-latest-metadata-v2.py \
  --artifacts /absolute/path/to/hosted-zips \
  --helpers retained-receipts/audit-tools \
  --oracle-archive /absolute/path/to/verification-oracles.tar.gz \
  --pins audit-pins.json \
  --output /absolute/path/to/a-new-empty-audit-output
```

The output directory must not exist. The script verifies all archive/helper/source pins before checking results. It reads retained receipts and invokes only the read-only comparator.

## Scope limits

This is the production-group term-sink/file/metadata boundary, not full SQLite publication, browser import timing or process peak memory. VNDB media projection/path coverage remains checked by the frozen acquisition/comparison; separate media file persistence, browser UI/restart and lookup qualification belong to the separately retained browser evidence. The original failed acquisition/control attempts remain in their own chronology and are not replaced by these successful runs.

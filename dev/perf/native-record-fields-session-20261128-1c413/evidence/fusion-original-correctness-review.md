# Independent audit of original whole-record fusion correctness run

**Verdict: PASS for the declared correctness boundary. No performance or PR qualification is claimed.**

This review uses only original completed GitHub metadata, both complete original artifacts, full decoded job logs, exact source/fixture-lock blobs, and retained receipts. The reviewer ran no product modules, imports, benchmarks, replacement observations, workflow reruns, source changes, refs, or PR operations.

## Immutable provenance

- Repository: ManabiIO/manabitan.
- Original run: [46149981540](https://github.com/ManabiIO/manabitan/actions/runs/46149981540), attempt **1**; both jobs and the run are terminal success.
- Producer head: a9debd150d65c8d11884dadcdf162e7898dea309.
- Producer tree: 56af9b6152630c9e7b11c30652e21fb88e69aa34.
- Sole parent / product B: 01eb863506012136e417167f445b2708d9136293.
- Exact A: a300da36d00df8e353c5679b1528b50a1299b75f; tree 5fe9ee5a3e2c27ce4e099cb3d6a598077027eac4.
- Branch: test/native-record-fields-fusion-20261128-1c413.
- Workflow blob: 0544c5cab2a62ff4dde4e95b51805451ce822097.
- Source manifest blob: 75c7b527113a83126acb0b1e935d85427f89d2ce.
- Source manifest SHA-256: 28b0894c47adaadae564e50ef89a391fc6b323d6de5db4b4d6c0d9bdbd0be86b.
- Aggregate source digest: 2b6ea2c90f870ced276c6bf49a67b6d1b1aead8fe144956b321d6af37ee0c132.

All 36 bound files (16 product plus 20 workflow/kit files), plus source.json itself, match their Git identities and complete original validation payload bytes. Every corpus artifact overlap matches the validation payload byte-for-byte. The exact A→producer change set is those 37 paths. The protected baseline sources and fixture lock were independently verified against Git. The dictionary fixture lock is blob eb72e9afb9feb0be1e7ebf9b807344cf6c9333e2, 3,047 bytes, SHA-256 60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89.

| Job | Original artifact | ZIP bytes | Original ZIP SHA-256 |
|---|---:|---:|---|
| 140994295297 — Untimed original baseline and candidate importer parity | 15265171488 | 1,171,200 | c3923ee6d8a1ddfc06a136ee33f2da18ef64420b9f95498212e3148964218559 |
| 140994295588 — Rebuild, complete units, types, lint and all-target builds | 15265507175 | 437,013 | d5719dd7ca0b34c4b31663dc9ca7b8feb47caedb65a5c70693f8dc9e7f9b31b6 |

Both ZIP digests equal GitHub metadata and their completed uploader logs. Full decoded UTF-8 logs are retained:

- Job 140994295297: 1,155,161 bytes; SHA-256 0fcb7ab7bc75e73f5660151095ec04132a98f06a2f93565ff05bc9c8be064eb7.
- Job 140994295588: 1,138,726 bytes; SHA-256 e18acd11a9da1ecab4e1b74b34242a158355a16ac14891e1de252d69a0f3717b.

The corpus ZIP contains the original PAX tar and full member receipt. The tar is 1,167,889 bytes, SHA-256 4ceb96fc3026c39bce4df6a8a21360a77a2a8188830d86d5a35a814e0ba8276b. All 233 members were independently traversed and verified: 205 complete regular-file payloads (5,296,768 bytes), 26 directories, and two smoke symlink metadata entries retained inert. No symlink was followed or materialized; no requested evidence root is missing. The validation ZIP contains 50 complete regular files. Every member was fully read and CRC-checked.

## Terminal validation

All 12 mandatory step outcomes and conclusions are success: source, setup, generated assets, toolchain, native reproduction, lint, ordinary units, options units, main types, development types, test types, and all-target dry builds. The workflow binds attempt 1 and uses pipefail; its final outcome check examines underlying outcomes so artifact upload cannot hide a failed gate.

- Ordinary suite: **701 files passed; 16,035 tests passed; 47 skipped**, 16,082 total.
- Options: **32 tests passed** in one file.
- Relevant original test files passed: fusion 35, native fields 110, import fields 20, dictionary WASM build 20, release-package native assets 24.
- All three type projects passed.
- Changed-source lint passed; its original pako vendor CommonJS warning is retained.
- Clang/lld **21.1.8** reproduced all three checked-in native targets exactly.
- All seven dry builds passed: chrome, chrome-dev, chrome-playwright, firefox, firefox-dev, firefox-android, edge.
- Corpus prerequisites passed: 27 pure comparator cases, 14 pure owner cases, nine archive cases, and 11 actual-I/O/worker/media-adapter smoke cases in each original arm.

Native reproduction hashes:

- term-content-canonical-scan-v1.wasm: 40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af.
- term-bank-parser.wasm: 5d216041823936521f8a70b721472fb8c42052d165d771a92b59ed967d8d2695.
- term-record-fields.wasm: 1ffc9e804789f09681041a7f701d18fcf32268d3bcf697c6b2d7d7493abe0aa9.

## Original imports and native coverage

The serial sequence was JMdict A→B, Jitendex A→B, VNDB A→B. All six were fresh Node v22.22.0 processes; every original process exited 0 with an exact full-log digest. Source-before equals source-after in each arm. The bound producer enforces fixture-before/after equality; retained fixture receipts match the exact lock. Every cleanup receipt has completed=true and no cleanup error.

| Corpus | Fixture archive bytes | Terms | Banks | Parser groups | Whole calls / rows / attempts | Ordinary native calls / rows | Owners / fields |
|---|---:|---:|---:|---:|---|---|---|
| jmdict | 15,645,766 | 528,299 | 53 | 12 | 12 / 528,299 / 12 | 0 / 0 | 12 / 12 |
| jitendex | 38,831,822 | 436,555 | 219 | 22 | 22 / 436,555 / 22 | 0 / 0 | 22 / 22 |
| vndb | 291,705,969 | 6,648,310 | 665 | 170 | 162 / 6,328,310 / 162 | 30 / 320,000 | 189 / 192 |

**Total: 7,613,164 term rows per arm.** Candidate JavaScript field calls and readiness fallbacks are zero in every corpus. All three decline maps are empty; overlapping whole/ordinary decline maps are never blindly added. Baseline native metrics are null and it never fetches the candidate asset. Candidate fetches it once through actual lifecycle initialization without an optional readiness wait.

VNDB ordinary-native work is 175 rows in ten raw-v6 owners plus 319,825 rows in 17 raw-block-v2 owners producing 20 fields. Whole-native work is one raw-v6 owner of 40,000 rows plus 161 raw-block-v2 owners of 6,288,310 rows. These are observed ordinary paths with no whole attempt, not readiness fallbacks or native declines.

## Enclosing-owner and byte accounting

Every owner is settled and error-free; contiguous owner partitions match A/B. Candidate metrics chain continuously from zero cumulative work to final store/publication metrics. Whole fusion occurs before the ordinary field hook: this audit recomputed whole work at owner boundaries, and ordinary work at field boundaries. It did not infer whole work from field-hook differences.

Input copies equal rows×8 + unique references×12 for each attempt. Table allocation matches the exact power-of-two slot formula. Successful whole output copies contain all field bytes **plus eight bytes for the scalar base**. A successful whole field hook does not repeat native work or output copies. No native work escapes the recorded owners.

| Corpus | Input copies | Field bytes per arm | Whole scalar output bytes | Native output copies | Table bytes | Memory growth | Maximum linear / scratch bytes |
|---|---:|---:|---:|---:|---:|---:|---|
| jmdict | 8,618,752 | 4,239,960 | 96 | 4,240,056 | 6,291,456 | 2,293,760 | 2,424,832 / 824,288 |
| jitendex | 7,851,764 | 3,497,796 | 176 | 3,497,972 | 4,980,736 | 1,179,648 | 1,310,720 / 406,144 |
| vndb | 55,332,860 | 53,191,776 | 1,296 | 53,193,072 | 84,559,232 | 1,638,400 | 1,769,472 / 764,288 |

Every field ordinal, owner ordinal, row/unique count, byte length, complete SHA-256, scalar numeric base, and little-endian Float64 base bits matches A/B. Explicit bits preserve signed zero independently of JSON numeric zero. No negative-zero base was observed in these three corpora; signed-zero test coverage is not misrepresented as a corpus observation.

Complete canonical field-output witnesses (algorithm retained in independent-receipt-audit.py):

- jmdict: ea62dfe8f99607275c55fed1ab687c079f4d22fca943112a74ee9df5189488f2; owner partition f7592b1cdcd93f336d2394a1d56b4a9ca3086f2a74efcfa7b6324b8ca011996e.
- jitendex: d62fe55297e80d49aadd808414cfc5cab9a5f332609e88f9afa3b0c5a0f89c8e; owner partition 9c23c3d69621b7b8980fd613d20173bafc45256764b85520374619e8966ed2c9.
- vndb: db05087053f32b43eea453dd3e690cdfcbe759ff88dba7f532c0b0b92ca1768a; owner partition 5fd3b670474d3d66aec2827c521b883b3478ef18815955857275fafbcc6a02db.

## Complete finalized term output

All finalized term-content/record/index paths, lengths, normalization declarations, and complete normalized SHA-256 values match. Only documented generation bytes are normalized: MBTRD16X offset 8, length 16; MBTIDX11 offset 24, length 16. Content is never normalized. The source oracle includes legacy numbered term-content segments and fails closed on unknown online/arena layouts; the actual runs used epoch-zero legacy roots with no numbered segment.

| Corpus / file role | Bytes per arm | Matching normalized SHA-256 |
|---|---:|---|
| jmdict / content | 19,566,680 | f436eb66405233aa7e6b2f9baaf45b444c4f9e976449fb189e7b7846814d6963 |
| jmdict / record descriptor | 45 | 3da3e40645ac7525cdc30dbc11ff66e9e9ca4ed169fe9550aaf3336dca2cae26 |
| jmdict / index | 23,748,952 | 397dae5e5f86853b47a90384739e42754e7ed84869a2d2142d05220f3600114f |
| jitendex / content | 38,386,795 | 664c13a8f93f089d04023460fd01f56117744b41d72c3fd8608bb9ebfa217fc9 |
| jitendex / record descriptor | 45 | 3da3e40645ac7525cdc30dbc11ff66e9e9ca4ed169fe9550aaf3336dca2cae26 |
| jitendex / index | 23,590,852 | 696c9f5506f32ceba7ecfe6834b69cd3ffdac83c0d6eec74afe4923a0b354a2b |
| vndb / content | 7,533,449 | f50a48e23056054a13f90dfa7aad53ba3a80a6f6e7125289a5ad52dc2f9f686e |
| vndb / raw-block-v2.mbtr | 38 | 046cfa639d53adfb65a9b2f1a0d48009e48c97606721708a260373749b0d352e |
| vndb / raw-block-v2.mbtr.mbti | 399,513,708 | c533b5176fc5a57d3a3b2e19f6648fadba13ceb5707bfb2f65de1e2d5c0ff175 |
| vndb / raw-v6.mbtr | 26 | 868ae810f872c67ba23c3d0f09176fa14946bee24cb66335f63f603d66641527 |
| vndb / raw-v6.mbtr.mbti | 2,386,124 | 7c0c01f91e2c92fd5bfcc6c57e9dd905bc991ef6622f7708a5724e1303bf446f |

Finalized term sink totals per arm: **43,315,677 JMdict; 61,977,692 Jitendex; 409,433,345 VNDB bytes**. Complete paths/raw hashes/normalized hashes remain in original files.json and independent-receipt-audit.json.

The producer retired only successful paired sinks after a second full raw hash matched files.json and staging was empty. Every retired-disk.json binds its complete original inventory. This reviewer independently reconciled both retained inventories; it cannot rehash absent raw sinks. **Hashes are not retained raw files.** No failed original was removed or replaced.

For disabled CPU-screen storage planning, 42 JMdict sinks require **1,819,258,434 bytes**, excluding auxiliary files and the mandatory four-GiB free-space admission floor. Each arm emits 4,239,960 field bytes plus 12 scalar-base witnesses (96 bytes). These fixed byte counts do not establish future host capacity.

## Source, worker, parser and lifecycle checks

Each arm used three actual Node production-parser worker threads, four compression workers, and VNDB additionally one production index worker. Every asset matches the bound runtime inventory. Each worker became ready once with no failure event. Explicit termination is recorded, explaining final Node termination exit code 1. Every parser request ID has one result; every source bank occurs once. Complete bank group, CRC signature, source byte metadata, and returned-row identities match A/B independently of worker assignment.

| Corpus | Compressed / transferred bytes | Uncompressed bytes | CRC scanned bytes | CRC reused bytes / glossary count | Pipeline groups/worker | Compression requests/results/consumed |
|---|---:|---:|---:|---|---:|---:|
| jmdict | 15,632,849 | 171,617,523 | 0 | 0 / 0 | 4 | 103 / 103 / 103 |
| jitendex | 33,829,614 | 538,927,310 | 0 | 0 / 0 | 3 | 385 / 385 / 385 |
| vndb | 86,850,424 | 4,267,992,967 | 568,284,368 | 3,699,708,599 / 6,490,145 | 3 | 0 / 0 / 0 |

Fused parser attempts are 12/22/170 and fallbacks zero. Compact-content-metadata groups are 0/0/170. Parser/source work counters match except the scheduling-dependent JMdict queued-byte peak below. VNDB index-worker actions match: open 2, writeChunks 87, seek 2, close 2; 93 sent/94 received messages.

All initial states have epoch 0/high-water 0; final epoch is 0. Final logical high waters are 19,566,680, 38,386,795, and 7,533,449. SQLite is a real nonpersistent memory database. The exact inner admission helper is rebound only for external host/diagnostic dependencies and schema 12. The outer _openConnection body, schema/root/purge/recovery decisions remain unchanged. usesFallbackStorage=false selects the documented adapter route; this is not persistent SQLite or browser OPFS.

Complete generated runtimes contain A 582 / B 586 files, unchanged from preflight through all imports, with exactly the seven declared runtime differences. Both independent npm installations use package-lock SHA-256 01e065503317a90b43a5bc60cd9f874238762c75a13c8115a9c484a626960a96 (333,801 bytes), package.json SHA-256 d23b58a7e5aab32183d4f09e38067d7bacd6b67229c14b18e1e8aa3a0a6c22f9 (9,595 bytes). Generated license bytes equal the committed document and match A/B; the permitted tracked exception was unused.

## Every observed A/B difference

The full structural diff of every shared arm JSON receipt is preserved in all-receipt-differences.json. Its differences have these explicit categories:

1. Arm/source/producer-tree identity; seven declared runtime source differences; added candidate helper/asset; candidate native metrics and route witnesses. Unchanged source, fixture lock, flags, semantics, scalar/field output, SQLite adapter, cleanup, initial state and final state match.
2. Record/index raw hashes differ within documented generation-header normalization; complete normalized hashes match. Each second raw inventory equals its own first inventory.
3. Parser groups move among workers in JMdict and VNDB while canonical source groups and result rows match. JMdict keeps 4/4/4 requests; VNDB A 56/57/57 versus B 55/57/58, with corresponding per-worker sent/received changes and equal totals. Jitendex keeps identical 8/7/7 assignment.
4. Asset completion order differs in compression-worker receipts: JMdict indices 0/1/3, Jitendex index 0, VNDB index 2. Complete asset multisets/hashes match.
5. These are all scheduling/coalescing product-counter changes (JMdict only):

| Counter | A | B |
|---|---:|---:|
| parserParallelPeakQueuedOwnedContentBytes | 58,114,957 | 45,111,679 |
| fastPathParserParallelPeakQueuedOwnedContentBytes | 58,114,957 | 45,111,679 |
| termContentWriteCallCount | 2 | 3 |
| termContentMergedWriteCount | 2 | 3 |
| termContentFlushFinalGroupCount | 2 | 3 |
| termContentMaxMergedGroupChunkCount | 85 | 56 |
| termContentMaxWriteBytes | 14,617,938 | 9,507,564 |

Those seven values plus added native metrics are every product-work-count difference. Jitendex/VNDB differ only by added native metrics. Coalescing and occupancy remain diagnostics, not semantic equal-work identity or performance evidence.

6. Host free bytes differ after A retains a sink: JMdict 90,237,554,688→90,193,702,912; Jitendex 90,236,346,368→90,173,759,488; VNDB 90,234,859,520→89,624,903,680. Both satisfy the original admission floor. These are not timing observations.
7. **VNDB non-term media differs outside the declared term-byte oracle.** Its generated paths have UUIDs f7622bb8-bc17-4290-ba66-818cdbd67f96 (A) and 62e32300-88d8-4fbb-93e2-49b6e14e9ba6 (B). Both files contain 199,220,580 bytes. SHA-256 A: e844ea5ee183a7da95553fd0de6b6e2a6edd48880664eb7caa80d7a86e53702c; B: e81a121f0bca858180cb50565756c7a5b77b03310361f8fe358a2b0f05f09295. No media bytes are normalized; no exact cause or equality is inferred from absent raw sinks. Media remains explicitly unqualified. JMdict and Jitendex have no non-term disk payload in these receipts.

## Scope and durable evidence

This passes the fresh original Node correctness gate: actual worker threads, memory SQLite plus disk OPFS adapter, complete term-output equality and successful native accounting. It does not qualify browser/persistent SQLite operation, restart, image decoding, full media, or comparative performance. No historical/old-source receipt or work count was substituted. The separate CPU study is outside this audit.

git-blob-ledger.json records exact Git blob, SHA-256, length, and original path for every complete original artifact/member/log/result/metadata item and this review plus independent audit outputs. These are unreferenced blobs for the parent to anchor; this reviewer created no ref.

Independent outputs: independent-source-audit.json; corpus-independent-archive-verification.json; independent-validation-audit.json; independent-receipt-audit.json; all-receipt-differences.json. The pure receipt-audit source is independent-receipt-audit.py and never invokes product imports.

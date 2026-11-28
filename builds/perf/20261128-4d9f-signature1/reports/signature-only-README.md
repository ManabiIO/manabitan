# Constant first-signature allocation evidence

The candidate avoids storing an otherwise repeated first signature word for MBR6 content. Complete parent/candidate term-sink verification passed for all three pinned dictionaries, with identical logical canonical metadata and persisted file bytes. The measured saving is the actual final native-arena backing size: **2MiB for JMdict, 2MiB for Jitendex and 1MiB for VNDB**. No complete-browser speed or process-memory result is claimed.

| Corpus | Rows | Source groups | Final canonical entries | Parent owned arena bytes | Candidate owned arena bytes | Bytes avoided |
|---|---:|---:|---:|---:|---:|---:|
| JMdict | 528,299 | 12 | 362,032 | 26,214,400 | 24,117,248 | 2,097,152 |
| Jitendex | 436,555 | 22 | 363,243 | 26,214,400 | 24,117,248 | 2,097,152 |
| VNDB | 6,648,310 | 170 | 157,150 | 17,301,504 | 16,252,928 | 1,048,576 |

The parent runtime is `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`, which already contains the merged compact-glossary parser improvement. The final candidate runtime is `232de57c6fd78ef1115d6db97d2ac5bb2c224417`. Earlier S1 tests and the first JMdict acquisition used `df25b497c46d79e72d1cd3b52589e31ade24b35a`; the later commit changes runtime JSDoc and blank lines only, and its own full JMdict acquisition is retained. Jitendex and VNDB were acquired directly on `232de57`.

## Evidence and provenance

`reports/jmdict-final-source-comparison.json` binds the final candidate JMdict run to the current parent and original complete `5a2d8167…` oracle. `reports/summary.json` gives the compact Jitendex/VNDB results; their complete comparisons and every per-group observation are preserved as `original-jv/jitendex-comparison-1.json` and `original-jv/vndb-comparison-1.json` inside `original-evidence.tar.gz`. `reports/original-jv-report.md` explains those acquisitions, the independent media oracle, resource observations and the exact preflight revision in more detail. The original JMdict protocol and earlier comparison remain separate; the final-source receipt identifies which acquisition establishes the final runtime's result.

Complete file-and-metadata oracle SHA256 values:

| Corpus | Oracle SHA256 |
|---|---|
| JMdict | `5a2d8167f046e313949af8005ed493b651d10a4de95bfc5a2de24699ec61a58e` |
| Jitendex | `16ea2af33a07c79d163d5c16cc73276940a9d5ab46776c0b2d300d70514ae6ff` |
| VNDB | `01aa55b3440a4bb5f6831a5e3c94eb20c2f7a672029824b00b31e3738043ea62` |

Each oracle includes every final persisted file and every logical `_termEntryContentMeta*` property. Raw final-file hashes are also preserved. The comparison normalizes only the independently linked random 16-byte generation IDs in record/index headers and decodes candidate presence marker 2 as the literal MBR6 first word. It does not normalize content payloads or row fields. The decoder never calls the product's getter or materializer.

The original JMdict workload checks all source slabs/descriptors, compressed frames, registered spans, 103 codec replies and final drain. Jitendex covered 385 codec requests/replies and 61,977,692 persisted bytes. VNDB covered 409,433,345 persisted bytes and used its existing uncompressed content route, with zero codec requests and the real import-index worker's asynchronous fallback. Candidate physical S1 remained null throughout the complete corpora; capacity, dense counts and hash-slot counts matched the parent.

VNDB checks all 170 source groups and the independent media projection/directory oracles: 146,725 group representatives, 146,570 distinct paths and 155 repeated references. These are references checked at the term-sink boundary. Separate image persistence is excluded.

The original raw reports, exact original helper sources, commands, successful and failed launches, and unit/static/build logs are stored in `original-evidence.tar.gz`. `original-evidence-index.json` lists every member's size and SHA256 plus the archive digest. It excludes release ZIPs, dictionary archives, installed dependencies and large reconstructible binary captures. It retains the complete result/oracle data needed to audit every stated result; the portable helper below regenerates the verification from the pinned dictionary archives.

## Retained failures and validation

The first Jitendex A attempt failed at source preflight, before any group parsed, with exit code 1 and no terminating signal. It detected that regenerated `zip.js` contained 24 changed esbuild installation-path comments. A/B raw ZIP assets matched; replacing that exact comment prefix reproduced the full frozen file byte-for-byte. The failed launch, original protocol, revised protocol, exact comment diff and two-hash provenance receipt are retained. Runtime code and generated assets were not edited to satisfy the guard.

The archived validation includes the initial focused-test/static failures and subsequent fixes. Root's full unit run on the functional S1 patch passed 15,170 tests with 47 pending; the final runtime/test commit passed the focused tests, scoped lint, all main/dev/test/bench type checks and dry build. Those statements refer to the recorded commands and source receipts in the archive, not to an inferred whole-repository rerun after documentation packaging.

The parameterized helper is new packaging of the corrected bounded corpus replay. Its own validation passed syntax, scoped lint and bounded OPFS contracts, followed by a complete fresh JMdict A/B acquisition matching all original per-group field/lookup/envelope digests and the full `5a2d8167…` oracle. Both runs exited 0 without a signal. Compact receipts are under `reports/portable-validation/`; complete raw reports, logs and formatting-only lint failures are in `portable-validation-raw.tar.gz` with member hashes in `portable-validation-raw-index.json`. The original successful observations above remain unchanged. No helper result is substituted for an original failure.

## Reproduce

Use [`test/perf/signature1-corpus-verification`](../../../test/perf/signature1-corpus-verification) from this PR. Its README documents the complete A/B commands, Node version, archive cache, output directory, independent media-directory check and bounded OPFS contracts. Expand `verification-oracles.tar.gz` into this directory first; its index contains every input member's size and SHA256. `verification-manifest.json` then pins those complete oracles and the runtime source trees/files. Later helper/evidence-only commits retain the same runtime proof. `protocol.json` records the verification boundary and fixed resource policy.

The replay invokes the production parser worker handler through an in-process transport adapter, retaining real grouping, structured clone and borrowed-source leases. It feeds the public sink sequentially and uses real codec and selected index workers. Its filesystem OPFS adapter preserves committed visibility and lazy snapshots, with the production asynchronous fallback for unavailable synchronous handles. This is not a concurrent browser import.

The saving above concerns owned arena backing bytes. Sampled RSS, resource counters and elapsed durations remain in raw reports solely as diagnostics. Browser peak/settled memory, whole-import latency, settings UI, SQLite transactions, separate media persistence, restart and lookup qualification remain outside this evidence.

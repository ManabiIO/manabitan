# Import optimization evidence: 2026-11-25

**The three candidates remain held under the evidence in this bundle.** Native media projection shows an exploratory VNDB improvement, but both VNDB memory replications fail the fixed coverage rule. The CRC candidate does not establish a reliable complete-import benefit. Native metadata preflight regresses on its JMdict target. Component improvements and passing correctness checks do not override these complete-import outcomes.

This separate evidence branch starts at develop commit `7d1643e6147a10cb2165e9744cf0e63b59e46632`. Product source is unchanged here. The bundle preserves **25 original Actions artifact identities, 207 timing reports, 64 memory observations, and 6,425 raw process-tree scans**. Every original textual artifact member and every failed observation is retained. No acquisition was repeated or observation replaced for these audits. Separately planned work in PR #918 is outside this archive.

## Decisions

Percentages are medians of within-block complete-import changes. A and C are the same baseline product, acquired separately. Negative values mean faster. Each corpus has six balanced ABC blocks: fixed exploratory screens, without independent timing qualification.

| Candidate and PR | Target timing | Memory | Decision |
| --- | --- | --- | --- |
| [Native media projection, #875](https://github.com/ManabiIO/manabitan/pull/875) | VNDB B/A **-5.043%**, B/C **-4.017%**; non-target changes near zero | Jitendex passes both replications; VNDB fails both on coverage | Preserve the speed signal; hold memory promotion. No additional timing acquisition bypasses the unresolved memory gate. |
| [Contiguous source CRC, #910](https://github.com/ManabiIO/manabitan/pull/910) | Jitendex B/A **-1.186%**, B/C **-0.792%**; B/C interval crosses zero | JMdict/Jitendex pass both; VNDB fails both on coverage | Unqualified experiment; no material, reliable whole-import gain established. |
| [Native metadata preflight, #914](https://github.com/ManabiIO/manabitan/pull/914) | JMdict B/A **+1.471%**, B/C **+1.724%**, **0/6 faster pairs against either control** | JMdict/Jitendex pass both; VNDB passes replication 1 and fails all four observations in replication 2 | Hold for target regression and incomplete memory qualification. Admission review found no concrete structural fix. |

The reports preserve descriptive bootstrap intervals, identical-product controls, per-pair outcomes, tails, equal-work changes, qualified maxima, and null unqualified metrics. Thirteen memory observations fail coverage. These failures are not measured memory regressions and cannot support a memory pass. No threshold was loosened, failed scan reclassified, tail discarded, or failed replication replaced by its passing peer.

## Evidence index

| Evidence | Original scope | Result |
| --- | --- | --- |
| [Media timing](media-timing/README.md) | Run `45642169759`; three corpora; 69 reports | All raw reports reconcile; exploratory VNDB signal only. |
| [Media memory](media-memory/README.md) | Run `45642179064`; two replications each for Jitendex/VNDB; 1,504 scans | Two passing Jitendex cells and two failed VNDB coverage cells. |
| [CRC hosted study](crc-hosted/README.md) | Timing `45644628634`, memory `45644635208`; nine artifacts; 69 timing reports, 24 memory observations, 2,435 scans | Evidence reconciles; timing remains inconclusive and both VNDB memory replications fail. |
| [Metadata hosted study](metadata-hosted/README.md) | Timing `45645363685`, memory `45645371602`; nine artifacts; 69 timing reports, 24 memory observations, 2,486 scans | Evidence reconciles; JMdict regresses and VNDB memory replication 2 fails. |
| [Component and validation receipts](components/README.md) | All three candidates; complete-corpus parity, source manifests, available original logs, failed diagnostics, and independent reviews | Component correctness remains separate from browser qualification. |

The 207 timing reports comprise 162 timed observations, 27 excluded warmups, and 18 separate exhaustive-media diagnostics. Their unchanged full report validators and receipt checks pass. All 64 memory correctness receipts pass; 11 of 16 memory cells meet the complete frozen gate and five fail coverage. Acquisitions, source candidates, stages, and memory timings are never pooled.

## Frozen sources and later published heads

| Candidate | Frozen hosted source | Later validation head | Relationship |
| --- | --- | --- | --- |
| Media | `7a8b25a44a3fe165107ed816377cc72bb0fac67d` | `5afd2e97ec2707b150acfde61115aee688547a78` | Two test files change; product source/build inputs are byte-identical. |
| Metadata | `b2e816c4714f42f87cbb6a1ebc7fe1a2d2fd863b` | `b273513dab4fa409a0213a2db470e52b4a0f559c` | Source formatting has exact normalized-AST proof; subsequent fixture guards affect tests. Timings keep the frozen preformat label. |
| CRC | `c2cf7647c67b02474301ed48e54a53205be0f027` | `2fe47fa3db04342d04eb4f309c5d74ef45eef9e3` | One test JSDoc annotation fixes literal inference; product/build inputs remain byte-identical. |

The [source index](components/source-identities.json) records trees, equivalent local commits, changed-file hashes, asset manifests, and exact relationships. Later validation does not relabel frozen observations. Older PR #875 results and rejected component experiments remain historical; they are not pooled into the current-base screen.

## Validation limits

Media source CI run `45644262132` at the later test-only head completes with 15 passing required jobs and four scope skips, including full unit, build, types, Chromium, and Firefox gates. Original API job/run receipts are retained.

CRC's frozen-source local full unit run passes 647 files and 14,567 tests, with 47 skips. Pinned native checks, main/test types, scoped lint, and all seven dry builds pass at their recorded heads. The initial three test-type errors and test-only correction remain preserved.

Metadata's focused 207 tests, native check, lint, main/test types, and seven dry builds pass. Its later two-worker full unit run **remains failed**: 644 files and 14,561 tests pass, with 64 skips, one five-second XXH32 timeout, and one ten-second compiler setup timeout. A separate diagnosis runs the same two suites once per arm with one worker and original timeouts; baseline and candidate each pass 107 tests. Directly involved test/runtime/compiler sources are byte-identical. Those isolation passes do not replace the failed full run or establish a passing full suite.

The component archive preserves rejected experiments, missing-result exit-137 attempts, the test-type heap-limit failure, initial formatting/nullability errors, and later corrections. Transcribed outcomes are labeled; missing original logs are not reconstructed. The final metadata admission review records native publication call count as unmeasured and does not assign causation to overlapping phase timers.

Latest metadata and CRC source CI gates remain unresolved in the retained final snapshots. Both CodeQL runs fail during result upload after query evaluation and SARIF generation; a more specific cause is not established. The metadata main workflow has six successful, nine queued, and four skipped jobs; both browser E2E jobs pass. CRC has four successful, eleven queued, and four skipped jobs; Firefox E2E and test build pass, while Chromium is queued. These are labeled snapshots, not final workflow passes, and do not alter the frozen performance results.

## Preservation and portable reproduction

Every archive has a complete file manifest, compressed/per-member SHA-256 digests, deterministic normalized metadata, and a repeated-build identity check. Original Actions IDs, names, URLs, sizes, expiry metadata, and service digests are retained. Every original textual ZIP member was compared byte-for-byte. Supplemental independent audits are identified separately from uploaded members.

Original ZIP containers, duplicate release ZIP payloads, and generated bytecode are omitted with exact hashes and reasons. Product ZIPs were never in the original timing artifacts; their supplied manifests are preserved. No large fixture cache is included and no original download was deleted.

[Portable audit tools](tools/README.md) verify and safely extract each archive, reopen original timing reports with explicit Node/repository paths, and recompute coverage, process sums, pairs, and memory metrics with each captured unchanged auditor. Reconciliation requires whole-result equality and preserves failed gates and null maxima. Fresh-extraction replay covers every timing cohort and every raw memory audit, without a new browser acquisition.

Full package/receipt replay additionally requires matching omitted A/B release ZIP bytes; manifests are not substitutes. Use ordinary Python without optimization and Node 22.22.0 for timing replay. Per-study instructions distinguish saved-evidence replay from a new acquisition.

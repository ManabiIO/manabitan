# Independent JMdict, Jitendex and VNDB import evidence

This evidence accompanies [PR #917](https://github.com/ManabiIO/manabitan/pull/917).
It extends the existing runtime PRs [#897](https://github.com/ManabiIO/manabitan/pull/897)
and [#875](https://github.com/ManabiIO/manabitan/pull/875), without publishing
duplicate implementations. The frozen current baseline is
`7d1643e6147a10cb2165e9744cf0e63b59e46632`.

## JMdict split-origin optimization

[Independent exact-head review and replay](jmdict-independent/README.md) confirm
that #897 preserves all 528,299 rows. The existing two-worker grouping takes the
split path and avoids 2,089,794 cumulative temporary offset/length column bytes.
The ordinary three-worker grouping avoids zero bytes. Exactly one shipped file
changes; the remaining 550 files, including all five WASM files, match baseline.

The complete-import and separate memory study is frozen at
`b1a0c5b78295def8cc91e4fca5e831d2248c7d01` in
[run 45646399468](https://github.com/ManabiIO/manabitan/actions/runs/45646399468).
Two hosts use opposite orders, twelve alternating A/B pairs each, interleaved
identical-product controls, exhaustive media verification, and separate memory
observations. They use the existing two-worker setting; no default-config or
two-core-hardware performance claim follows from this configuration.

Both hosted jobs completed successfully. Three independent audits reconciled
all 84 imports, every raw timing observation and all 571 memory scans. The
hosted configuration used two workers, eight source groups and 15 native
segments in every import. All 528,299 rows, output and lookup digests, restart
receipts, and exact 43,476,429-byte storage layout match across arms and hosts.

| Host | Candidate paired median | Equal-work change | Descriptive 95% interval | Faster pairs | Identical-code control median |
| ---- | ----------------------: | ----------------: | -----------------------: | -----------: | ----------------------------: |
| AB   |                 +0.136% |           +0.774% |       [-2.953%, +2.078%] |         6/12 |                       +3.750% |
| BA   |                 -0.707% |           +2.709% |      [-5.507%, +13.123%] |         7/12 |                       -5.052% |

The study does **not** demonstrate a complete-import latency improvement. Both
intervals span zero, both equal-work changes are positive, and identical-code
controls show substantial variation. The slowest candidate pairs, +21.728% on
AB and +36.842% on BA, remain included. Hosts and stages are not pooled.

Both separate memory cohorts pass the fixed gates. Median PSS/private changes
are -2.669%/-3.396% for ABBA and +1.375%/+1.860% for BAAB. All eight observations
qualify; the largest coverage gap is 157.220357 ms against 250 ms. The largest
individual increase is +4.913596% private memory, below 10%; both median
increases remain below 5%. These are sampled memory qualification results,
not exact peak measurements or proof of a memory reduction.

The component replay's 2,089,794-byte saving remains limited to that replay and
its split groups. It is not a browser allocation counter, a measured speedup,
or a benefit for ordinary three-worker imports. The completed browser study
qualifies the explicit two-worker workload's correctness and sampled memory.

## Current-source native media projection

[The independent VNDB review](vndb-independent/README.md) binds the integrated
#875 runtime to tree `093a0be94fcf336ab5a0113b80fae7481855935a` and exact pinned
LLVM-generated WASM. All 6,648,310 source rows and 146,570 unique media paths
remain equivalent. The projection removes 146,725 full-glossary parses, replacing
84,398,732 bytes of JSON input with 2,391,178 bounded path-token bytes. This is a
component work reduction. The independent package comparison finds exactly four
changed files and a 2,752-byte local archive increase.

### Timing screen

All 69 observations from
[run 45642169759](https://github.com/ManabiIO/manabitan/actions/runs/45642169759)
were independently reconciled against the frozen plans, raw reports, source and
package-entry identities, semantic receipts and reported arithmetic. Each
dictionary has three excluded warmups, six balanced A/B/C blocks and two
separate exhaustive-media diagnostics. A and C are identical baseline products.

| Dictionary |             B/A paired median |             B/C paired median |         Identical-product C/A |
| ---------- | ----------------------------: | ----------------------------: | ----------------------------: |
| JMdict     | -1.0439% [-4.0248%, +1.4776%] | -1.1512% [-3.3503%, -0.1880%] | +0.0549% [-1.1258%, +2.1667%] |
| Jitendex   | -0.1231% [-0.3968%, +0.8376%] | +0.0482% [-1.8340%, +0.4681%] | +0.3524% [-0.3588%, +1.6721%] |
| VNDB       | -5.0427% [-6.5649%, -1.8562%] | -4.0169% [-5.7527%, -2.9346%] | -0.6947% [-2.6279%, +2.5532%] |

Negative changes mean faster. Intervals are the original registered descriptive
bootstrap intervals. These are exploratory screens on one host per dictionary;
hosts and dictionaries are not pooled. VNDB's equal-work changes are -4.5244%
against A and -4.2506% against C. JMdict and Jitendex do not establish a clear
improvement. The separate memory hold is unchanged.

Every content, lookup, restart and media receipt reconciles. All three cohorts
also pass the stricter exact per-file and total storage equality check; the
predeclared VNDB active-SAH allocation allowance was unused. Exhaustive readback
verifies all 236 Jitendex images and all 146,570 VNDB images.

Timing ZIP containers were not retained by the original screen. Their recorded
hashes bind to the raw reports; all 551 recorded package-entry hashes match
independently retained and verified memory-study packages. The audit explicitly
does not claim to have recomputed hashes of absent timing ZIP containers.

### Memory remains unqualified for VNDB

All 1,504 raw scans and 16 fixed observations from
[run 45642179064](https://github.com/ManabiIO/manabitan/actions/runs/45642179064)
were independently recomputed. All correctness receipts and eight actual
packages were checked. Both Jitendex replications pass the unchanged memory
gates. Both VNDB replications fail coverage:

- ABBA: A2 has a 350.425804 ms covered-scan gap.
- BAAB: B1, A1 and B2 have gaps of 324.494085, 258.866332 and 275.215655 ms.

The limit remains 250 ms. Unqualified maxima and aggregate changes remain null;
no failed observation was replaced or rerun. The historical older-baseline
Jitendex +11.5409% private-memory pair remains a separate failed result. The
current source includes subsequent ownership changes; these studies are never
combined to erase the historical failure or calculate a speedup.

## Withheld experiments

[Jitendex investigation](jitendex-investigation/README.md) retains the short-field
comparison experiment, prepared compression-dictionary feasibility probe and
ordinary-policy split replay. None established a supported complete-import
improvement, and their runtime changes were reverted. The VNDB review retains
the rejected extra duplicate-reference filter: only 616 projected rows and
33,265 cumulative bytes were removed, while adding Set work.

## Raw evidence and independent audits

- `baseline-profiles.tar.gz`: the separate ordinary and traced diagnostic
  imports for all three dictionaries from run 45639067285. Single diagnostic
  timings are not comparison results.
- `current875-screen.tar.gz`: every screen observation, failed-state record if
  present, original plan, source/package manifests, harness and protocol files.
- `current875-memory.tar.gz`: all four memory cells, including every raw process
  scan, marker, report, failure, and source/package manifest. Nested product ZIPs
  remain in the original Actions artifacts and were independently inspected.
- `current875-audits/`: independent timing and memory audit reports, reproduction
  scripts, current-head status receipt and the complete VNDB timing job log.
- `jmdict-two-workers-AB.tar.gz` and `jmdict-two-workers-BA.tar.gz`: every
  observation from the frozen two-host JMdict study, including source/package
  manifests, raw browser reports, memory scans, markers and original/overlay
  harnesses. Actual package ZIPs are independently verified and remain in the
  original Actions artifacts; exclusions and their exact hashes are explicit
  in the adjacent member manifests.
- `jmdict-hosted-audits/`: independent statistical, semantic and raw-memory
  audits, their reproduction scripts, original artifact identities and
  successful job/acquisition receipts.
- Adjacent `*-manifest.json.txt` files bind every archive member's unchanged
  bytes and the complete deterministic archive. Gzip/tar metadata is normalized;
  member contents are not altered.

Original logs and patch inputs retain their original trailing whitespace and
blank lines. An unrestricted whitespace check therefore reports those archived
inputs; it is not recorded as a pass. The changed executable tooling, workflow,
metadata and authored Markdown are checked separately. Historical evidence is
not reformatted to make a source-code whitespace check pass.

Historical JSON and reproduction inputs are stored as text to preserve their
original bytes without registering them as active project configuration or
tests. Extract a raw archive with `tar -xzf ARCHIVE.tar.gz` into an empty local
directory. Independent audit scripts document their original input paths; pass
or adapt only acquisition paths when replaying them. Product source, observation
order, receipts, gates and reported measurements must remain unchanged.

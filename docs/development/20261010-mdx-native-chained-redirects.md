# Native MDX chained redirect review — 2026-10-10

## Scope and source

Independent native-helper converter branch from remotely verified develop `e05294d263582b58bbe92c5e9f97349f6f60df31`. Isolated worktree `/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-redirect.d3JmSt/manabitan`. Parent/repository AGENTS and previously read optimize-manabitan architecture and MDX references apply. No lookup, generic importer/storage, parent pins/source, installed dependencies, original dependency checkout, old task, or native closeout worker was modified. Existing drafts #482/#483/#484/#486/#487/#488 remain independent; none is composed into this branch.

## Confirmed loss of aliases

Native `_build_redirect_map` records direct target-to-alias edges, but conversion previously emitted only `[term, *redirects.get(term, [])]`. For deep -> chain -> direct -> main, only main and direct became archive rows. Chain and deep records were skipped as redirects and never reached the archive. A stub-reader conversion with two main definitions produced main/direct twice rather than all four expressions twice. This is inherited from experimental helper addition `2de4150cb`; the browser Worker converter already performs iterative alias traversal and does not call the helper.

## Focused fix

Traverse exact-name target-to-alias edges iteratively, retaining encounter order and a per-definition visited set. This emits transitive aliases once per actual definition, suppresses repeated edges and terminates reachable cycles. Each original non-redirect definition is still converted separately; its aliases share its converted glossary and sequence. No recursive call depth, copied dictionary payload, extra MDX reader pass, full transitive map, or change to assets/CSS is introduced.

Per non-redirect definition, work is proportional to reachable redirect edges and names; metadata storage is proportional to emitted expressions. Dictionaries with additional legitimate aliases generate more rows and ZIP output as required for correctness. Ordinary entries add a small set/helper call. No throughput measurement or zero-regression claim; this is correctness-only evidence.

## Actual evidence

Python 3.14.6, stdlib and existing fake MDX/MDD reader registry:

- Before fix: filtered archive conversion test failed; rows were `[main, direct, main, direct, other]` instead of the expected two groups of main/direct/chain/deep followed by other.
- After fix: that test passed. Coverage was extended with a reachable back-edge; it verifies deterministic expression order, duplicate alias suppression, sequence preservation across two different main definitions, exact glossary equality within each group, and termination while unrelated cycles/missing targets remain omitted.
- Existing filtered `test_convert_writes_redirects_assets_styles_and_description_override` passed, preserving its direct alias, media bytes, CSS, and description assertions.
- git diff --check passed.

No real PyGlossary encoding/encryption fixture, large dictionary, browser/native suite, full tests/builds, benchmark, installed database, user database, merge or deployment. Existing PR results are historical and were not rerun here. Commit requests [skip ci] to avoid heavyweight automatic jobs; not release-ready.

## Remaining gaps

Exact-name traversal does not add the browser's KeyCaseSensitive/StripKey fallback normalization. Dangling and pure-cycle aliases still have no emitted definition and no new diagnostics; nonempty all-redirect archives still need an explicit failure policy. Real parser compatibility, native/browser HTML/CSS parity, upload retirement and repeated-job matching, Unicode filesystem aliases, composed PR validation, and installed storage integration remain unverified. This change deliberately stays within confirmed chained alias loss.

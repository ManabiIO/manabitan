# Native definition reference and nesting review — 2026-10-10

## Scope and source

Longer bounded review of native HTML conversion, internal search links, stylesheet references, inline style case handling and parser stack ownership. Independent branch `fix/mdx-native-reference-fidelity-20261010` from remotely verified develop `e05294d263582b58bbe92c5e9f97349f6f60df31`, isolated at `/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-reference-fidelity.o8oeef/manabitan`. Read applicable parent/repository AGENTS, current native functions and browser equivalents; previously read optimize-manabitan architecture/MDX references apply.

Prior drafts #482/#483/#484/#486/#487/#488/#489/#490/#491/#492/#493/#494/#495/#496, original clean dependency worktrees, old tasks, native closeout workers, parent tracked source/pins and lookup/storage ownership remain preserved, not composed into this branch. No workers or new chats were created.

## Confirmed failures and targeted fixes

1. Bare stylesheet URLs resolved at the dictionary root. styles/main.css containing url(images/a.png) referenced images/a.png instead of styles/images/a.png. A fixture with different ROOT/SIBLING bytes proves the wrong path selection. Resolve all non-root, non-prefixed references relative to the stylesheet directory, preserving explicit ./, ../, /, file:// and already-prefixed controls. Preserve query/fragment suffixes.
2. Internal links interpolated headwords directly into query strings. entry://A&B#C?D+E became a query for only A with a fragment, across entry, bword, d and x schemes. Percent-decode once and encode as a single query value; Japanese spaces, encoded plus/percent and already-escaped ampersands remain semantically intact.
3. Inline styles only called URL rewriting if the literal lowercase url( appeared. Valid uppercase/mixed-case URL functions bypassed migration despite the URL regex already being case-insensitive. Use a case-insensitive precheck.
4. An unmatched HTML end tag popped every open context. In div/span text followed by </ghost>, subsequent text moved outside the intended span/div. Check for a matching open context before popping. Valid ancestor close, transparent custom tags, class metadata and text grouping retain their current behavior.

These native methods are inherited from experimental helper addition 2de4150cb. Browser conversion already encodes search values, handles all stylesheet-relative references and uses an HTML tree parser. The production Worker does not invoke this helper. No broad parser replacement or policy/refactor work was performed.

## Costs and limits

Asset normalization adds root/prefix checks and directory joining for legitimate sibling references. Search links add temporary decoded/encoded strings proportional to the headword. Inline style detection lowercases each declaration value before the existing precheck, adding a short value-sized temporary string. End-tag validation scans open contexts until a match (O(1) for ordinary top-of-stack close, O(depth) for ancestor/unmatched closes), without copying the stack. No dictionary-sized buffers, additional source-reader passes, archive extraction changes, cache changes or scheduling work. No throughput measurement or zero-regression claim.

This preserves valid reference semantics; it does not establish complete URL/CSS/HTML5 grammar equivalence, percent-encoded media path matching, malformed encoding policy or implicit HTML closing rules.

## Actual verification

Python 3.14.6 with stdlib, real ZIP files and the existing fake MDX/MDD reader registry:

- The first URL pass failed eight subcases before fixes; the subsequent unmatched-endtag regression also failed before its guard.
- Final exact baseline export: six filtered reference test methods produced eleven failures using the final fixtures against develop. Controls passed. This is the final failing-before evidence rather than a historical claim.
- Changed source: the same six methods passed all thirty scenarios: sixteen scheme/headword combinations, eight stylesheet path forms, three inline function-case forms, archive identity, unmatched-close structure and ancestor/transparent-tag control.
- Archive checks preserve original CSS/root/sibling bytes, select the sibling URL, and preserve the decoded query value in exported structured content.
- Four existing filtered methods passed: common HTML mappings, inline URL/embedded assets, redirect/assets/CSS/description archive conversion, and stylesheet selector/resource migration. Total current validation: ten selected test methods; no full helper suite.
- git diff --check passed. Parent tracked diff remained empty; original dependency statuses remained clean.

Raw exact-baseline source/test export and before/after logs are retained at `/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-reference-fidelity.o8oeef/before-after-ucb_s9u0`. Reproduce new cases with `python3 -B dev/native/mdx-import/test_native_helper.py -k reference`.

No installed dependencies, real binary parser, browser/native suites, rendering, full tests/builds, benchmarks, large dictionaries, user databases, merges or deployment. Other PR results remain historical and were not rerun. Commit requests [skip ci] to avoid heavyweight automatic jobs; not release-ready.

## Reviewed boundaries and remaining work

The review also inspected source asset prefix/suffix normalization, embedded asset registration, stylesheet decoding, tag mapping, media links/source tags, CSS selectors, and source-comment emission. Their presence is not validation. Prior independently fixed encoding, data URL, collision and literal-rewrite paths were not duplicated here. Broader stylesheet scoping, media child-selection semantics, implicit/unclosed HTML behavior and rendered parity require their own concrete fixtures.

Real PyGlossary definition encoding/encryption, upload retirement/repeated-job ownership, full composed-draft validation, alias normalization/diagnostics, Unicode resource lookup and installed storage/media integration remain open. No unsupported performance or general format-compatibility conclusion is made from these fixtures.

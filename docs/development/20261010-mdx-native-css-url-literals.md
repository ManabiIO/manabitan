# Native CSS URL literal preservation — 2026-10-10

## Scope and source

Independent native converter branch from remotely verified develop `e05294d263582b58bbe92c5e9f97349f6f60df31`; isolated at `/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-css-literals.PoszTu/manabitan`. Parent/repository AGENTS and previously read optimize-manabitan architecture/MDX references apply. Prior drafts #482/#483/#484/#486/#487/#488/#489/#490/#491/#492/#493/#494, original clean worktrees, old tasks, native closeout workers, parent sources/pins and lookup/storage are preserved. This is not a composed state.

## Confirmed corruption

Native _rewrite_css_asset_urls applied its URL regex without lexical context. It rewrote content: "url(example.png)" into content: "url("mdict-media/example.png")", changing the literal and breaking quote structure. Comments and larger identifiers such as myurl(example.png) and non-ASCII prefixed function names were also changed. Unterminated comment/string regions were rewritten despite not containing actual CSS URL tokens. The browser converter already skips these regions and checks identifier boundaries. Native code dates to experimental helper addition 2de4150cb; the Worker does not call it.

## Fix and costs

Extend the existing regex alternation to consume comments and escaped quoted strings first. Those matches have no path group and are returned verbatim. Actual URL matches require an identifier boundary including non-ASCII characters. Relative asset normalization and the existing URL-path parser remain unchanged; this is a focused lexical context fix, not a CSS grammar rewrite.

The rewrite still scans stylesheet text using one compiled regex substitution. It now invokes the callback for matched literal regions as well, returning their original text. Literal match strings and output construction consume text-sized storage as before; no asset byte buffers, dictionary passes, caches or ZIP pipeline changes. No throughput measurement or zero-regression claim. Complex CSS escapes inside URL paths remain outside this fix.

## Actual verification

Python 3.14.6 and stdlib:

- Before: five subcases failed across two filtered methods: quoted content, escaped quote/comment, identifier prefixes, unterminated comment and unterminated string.
- After: both methods passed. Three valid mixed snippets preserve their literals byte-for-byte while still rewriting an uppercase real URL function to the expected media path. Unterminated literal regions remain unchanged.
- Existing filtered stylesheet/root-selector asset URL migration test passed.
- Existing filtered direct-redirect/assets/CSS/description archive test passed.
- git diff --check passed.

No dependencies, broad suites/builds, native/browser validation, benchmarks, real PyGlossary, rendered stylesheet, large dictionary, user database, merge or deployment. Other PR evidence remains historical and was not rerun here. Commit requests [skip ci] to avoid heavyweight automatic workflows; not release-ready.

## Remaining gaps

Full CSS escape/URL grammar, CSS data URLs, selector semantics, codec parity, rendered style equivalence, real encoded/encrypted dictionaries, alias normalization, upload retirement/repeated-job matching, composed draft validation and installed media/storage integration remain unverified. Existing independent #494 handles encoding and #493 handles HTML data URL decoding; neither is composed here.

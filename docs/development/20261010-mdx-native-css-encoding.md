# Native MDX stylesheet encoding review — 2026-10-10

## Scope and source

Independent native converter branch from remotely verified develop `e05294d263582b58bbe92c5e9f97349f6f60df31`, isolated at `/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-css-encoding.TqgsTF/manabitan`. Parent/repository AGENTS and previously read optimize-manabitan architecture/MDX references apply. Existing drafts #482/#483/#484/#486/#487/#488/#489/#490/#491/#492/#493, original worktrees, old tasks, native closeout workers, parent sources/pins and lookup/storage remain preserved, not composed here.

## Confirmed fidelity bug

_decode_stylesheet_asset tried UTF-8 then arbitrary UTF-16 variants, ignoring declared encoding. A Shift-JIS stylesheet could be omitted or interpreted as nonsensical UTF-16 text; BOM-less UTF-16BE decoded as little-endian gibberish. Unsupported and mismatched @charset declarations were also accepted through unrelated codec guesses. A real encoded CSS resource in a stub-reader MDD archive lost Japanese font-family text and URL migration.

Existing browser stylesheet decoding already uses BOM, declared encoding, UTF-8 and a bounded ASCII-NUL heuristic for BOM-less UTF-16. The native method dates to experimental helper addition `2de4150cb`, not recent browser optimizations; the Worker does not call this helper.

## Fix and costs

Honor BOM before declared @charset, decode declarations using Python's supported codecs, and strip the initial declaration from migrated text. Unsupported or failed declared decoding returns None instead of trying a different encoding. Without an explicit encoding, try UTF-8 then inspect at most 32 byte pairs for a strong endian-specific ASCII-NUL pattern before UTF-16. Original raw CSS assets remain byte-for-byte unchanged.

Header matching examines at most 128 bytes; endian detection copies/counts at most 64 bytes. Actual decoding and declaration stripping scan the stylesheet and retain its decoded text as before. The function can still decode twice on UTF-8 failure; no additional dictionary pass or asset-byte copy pipeline is introduced. No measured performance or zero-regression claim. Python and browser codec label sets are not asserted to be identical.

## Actual verification

Python 3.14.6 with stdlib codecs and existing fake MDX/MDD registry:

- Before: filtered stylesheet tests produced five failures: Shift-JIS decoding, BOM-less UTF-16BE, unknown declaration, malformed declared UTF-8, and archive CSS text migration. UTF-16LE/BOM controls and existing selector migration passed.
- After: four filtered stylesheet methods passed. New controls cover seven valid encoded forms including UTF-8/UTF-16 BOM precedence over conflicting declarations, two declared rejection cases, and archive migration preserving Japanese text, normalized image URL, original CSS bytes and original image bytes. The fourth method is the existing root selector/asset URL migration regression.
- Existing filtered direct-redirect/assets/CSS/description archive regression passed.
- git diff --check passed.

No dependency installation, real MDX/MDD binary parser, image/font rendering, full suites/builds, native/browser validation, benchmarks, large dictionaries, user databases, merges or deployment. Prior draft evidence remains historical. Commit requests [skip ci] to avoid heavyweight automatic checks; not release-ready.

## Remaining gaps

Real parser definition encoding/encryption, codec-label parity, undeclared legacy CSS, Unicode normalization, full CSS grammar fidelity, alias normalization/diagnostics, upload retirement/repeated-job matching, composed draft validation and installed storage/media integration remain unverified. This is encoded stylesheet fidelity, not a broad HTML/CSS parser rewrite.

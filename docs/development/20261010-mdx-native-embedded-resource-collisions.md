# Native embedded/source asset collisions — 2026-10-10

## Scope and source

Independent native converter branch from remotely verified develop `e05294d263582b58bbe92c5e9f97349f6f60df31`; isolated at `/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-embedded-collision.XAEMCG/manabitan`. Parent/repository AGENTS and previously read optimize-manabitan architecture/MDX references apply. Prior drafts #482/#483/#484/#486/#487/#488/#489/#490/#491/#492/#493/#494/#495, original dependency worktrees, old tasks, native closeout workers, parent sources/pins and lookup/storage are preserved, not composed here.

## Confirmed wrong resource bytes

Generated embedded resources use a digest-based path under the same media root as MDD resources. The collector did not reserve source names, and final assets.setdefault preferred existing MDD bytes. A source key matching the generated PNG path caused the generated image reference to resolve to SOURCE bytes rather than PNG. A case-only source name also occupied the same portable namespace despite distinct ZIP entries. The existing browser collector reserves source keys before choosing generated names; native code inherited from experimental helper addition 2de4150cb did not.

## Fix and costs

Build a casefolded source-path set once after MDD extraction and share it with definition collectors. Retain the existing digest name when available; otherwise append a deterministic numeric suffix until a source-free path is found. Original source resources retain their paths and bytes. Repeated embedded content selects the same generated path across definitions and remains deduplicated by existing asset merging. No whole transitive resource remap or asset-byte copy is introduced.

This adds O(source filename metadata) retained storage and normalization at dictionary setup. Embedded registrations perform a set lookup and, only on collisions, additional lookups proportional to occupied suffixes. Existing media decoding, digest hashing, byte retention and ZIP pipeline remain. Empty source assets do not allocate a reservation set. No throughput measurement or zero-regression claim. Unicode filesystem aliasing and cryptographic digest collisions are not newly addressed.

## Actual verification

Python 3.14.6, stdlib and existing fake MDX/MDD registry:

- Before: two filtered subcases failed. Exact path collision returned SOURCE instead of PNG; case-only collision violated the casefolded namespace check.
- After: both passed. They include a second occupied suffix, exact bytes for both preserved source assets, exact generated PNG bytes, stable path reuse across two definitions, and exactly one generated archive entry.
- Existing filtered embedded image/audio archive test passed.
- Existing filtered inline URL/embedded-data structured-content test passed.
- git diff --check passed.

Tiny arbitrary media bytes test archive identity, not rendering or real binary parsing. No dependencies, full suites/builds, native/browser validation, benchmarks, real PyGlossary, large dictionaries, user database, merge or deployment. Other PR results remain historical. Commit requests [skip ci] to avoid heavyweight automatic workflows; not release-ready.

## Remaining gaps

Real rendering/encoding/encryption, native/browser HTML/CSS parity, malformed data URL policy, CSS embedded assets, alias normalization, upload retirement/repeated-job matching, Unicode path equivalence, composed draft validation and installed media/storage integration remain unverified. Independent #493 fixes valid data URL decoding and #495 CSS lexical context; neither is composed here.

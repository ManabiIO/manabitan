# Native MDX data URL fidelity — 2026-10-10

## Scope and source

Independent native converter branch from remotely verified develop `e05294d263582b58bbe92c5e9f97349f6f60df31`, isolated at `/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-dataurl.7sMO1r/manabitan`. Parent/repository AGENTS and previously read optimize-manabitan architecture/MDX references apply. Parent source/pins, lookup/storage ownership, original dependency worktrees, old tasks, native closeout workers and existing drafts #482/#483/#484/#486/#487/#488/#489/#490/#491/#492 are preserved and not composed here.

## Confirmed fidelity bugs

Native data URL parsing filtered empty header fields before selecting the media type. `data:;base64,UE5H` became media type base64 and literal UE5H bytes; `data:;charset=utf-8;base64,UE5H` became media type charset=utf-8 rather than the omitted-type default text/plain.

It also passed escaped base64 directly to b64decode. `data:image/png;base64,%2B%2F8%3D` returned None instead of exact bytes fb ff, so the structured-content converter omitted the image entirely. A tiny archive fixture reproduced the missing image. Existing browser decodeDataUrl preserves the empty media-type field and percent-decodes base64 before decoding; native logic diverged from that behavior. The native module is inherited from experimental helper addition `2de4150cb`; the production Worker does not call it.

## Fix and costs

Preserve header field positions and default an empty first field to text/plain. Percent-decode base64 payload bytes before base64 decoding, using the existing unquote_to_bytes dependency. Existing permissive base64 validation behavior and malformed-input fallback are unchanged; this is format fidelity, not a security-policy change.

Percent decoding requires a payload scan and encoded/decoded byte storage before base64 output. Escaped payloads therefore incur temporary memory proportional to that individual data URL, not to the entire dictionary; no new whole-file buffers, source passes, asset hash/cache strategy, or ZIP pipeline change. Unescaped base64 still produces its original bytes. No throughput measurement or zero-regression claim.

## Actual verification

Python 3.14.6, stdlib and existing stub MDX registry:

- Before: two filtered base64 test methods produced three failed parsing subcases and one archive IndexError from the missing image. Unescaped base64 and percent-encoded plain-text controls passed.
- After: both methods passed. Five parsing subcases verify omitted types with/without charset, escaped base64 byte equality, unescaped base64, and plain-text escapes; archive test verifies the generated image path resolves to exact fb ff bytes.
- Existing filtered embedded image/audio archive regression and inline URL/embedded-asset structured-content regression passed (one each).
- git diff --check passed.

Tests use arbitrary tiny media bytes to check transport/archiving fidelity; they do not prove image rendering or real format parsing. No dependencies, full suites/builds, native/browser validation, benchmarks, real PyGlossary, large dictionaries, user database, merge or deployment. Prior draft evidence remains historical. Commit requests [skip ci] to avoid heavyweight automatic workflows; not release-ready.

## Remaining gaps

Malformed percent/base64 policy, real image/audio rendering, CSS data URLs, charset-dependent definition decoding, real encrypted/encoded dictionaries, native/browser HTML/CSS parity, upload retirement/repeated-job matching, composed draft validation, and installed storage/media integration remain unverified. This fix covers the demonstrated valid data URL decoding differences only.

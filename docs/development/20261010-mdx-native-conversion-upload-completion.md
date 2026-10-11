# Native MDX conversion upload completion — 2026-10-10

## Scope and source

Independent helper-only branch from remotely verified develop `e05294d263582b58bbe92c5e9f97349f6f60df31`; isolated worktree `/Users/alex/.codex/worktrees/2f82/yomitan-benchmark/mdx-completion.d1eUxS/manabitan`. Parent/repository AGENTS and previously read optimize-manabitan architecture/MDX references apply. Existing drafts #482/#483/#484/#486/#487/#488/#489/#490, original worktrees, old tasks, native closeout workers, parent sources/pins, lookup and generic storage remain preserved.

## Confirmed bypass

finish_upload checks declared versus received bytes, but convert previously neither called it nor checked companion uploads. Calling convert after receiving two of three declared bytes staged the incomplete source and invoked conversion. A permissive reader could return a downloadable job from those bytes. Three fault tests confirmed the bypass for primary MDX, explicitly selected MDD, and automatically matched MDD. This inherited helper behavior is not called by the production browser Worker.

## Fix and costs

At conversion entry, validate the primary using finish_upload and check each selected companion's received count before allocating the job ID or staging. Errors retain source bytes so upload completion and retry remain possible. Receiving all bytes is sufficient; no mandatory prior finish_upload RPC state or protocol version change is introduced. Automatically matched incomplete companions now reject instead of being staged or silently omitted.

This adds constant-time checks per selected source, no file reads/writes or dictionary-sized buffers. Existing selection/sorting/copy/conversion paths remain in place. No measured throughput or zero-regression claim.

These checks rely on received_bytes. Develop's sparse/replayed chunk accounting is independently corrected by #483; this branch alone does not claim to close that separate integrity hole. Companion-selection ambiguity and retirement/reuse remain separate.

## Actual verification

Python 3.14.6, stdlib and existing stub converter/reader infrastructure:

- Before: all three incomplete-source subcases failed because convert did not raise ValueError.
- After: all three passed, proving zero staging/converter calls on rejection, no job directory/registration, completion without a finish_upload RPC, successful retry using j1, and exact staged ABC bytes for both sources.
- Existing filtered staging/description-override test passed.
- In a fresh three-file source export only, applied this exact admission check to the exact #483 head `29c6c2113f5952ba62eb8d5e6ca07a748113bcdf`; the same three subcases passed with contiguous chunk enforcement. This is narrow ephemeral composition evidence, not a combined branch/PR or full integration validation. Export retained at `focused-483-composition-v5_h1rbb` beside the worktree.
- git diff --check passed.

No dependencies, full tests/builds, browser/native suites, benchmarks, real PyGlossary, large dictionaries, installed user database, merges or deployment. All other prior evidence remains historical. Commit requests [skip ci] to avoid heavyweight automatic workflows; not release-ready.

## Remaining gaps

Real parser encoding/encryption, browser/native HTML/CSS parity, alias normalization/diagnostics, upload retirement and same-basename automatic selection across jobs, platform filename equivalence, installed storage/media integration, cancellation during synchronous conversion, and full composed-draft validation remain unverified. Independent #483 chunk integrity, #484 explicit resource gaps, #486 framing, #487 failed-job cleanup, #488 collision rejection, #489 chained aliases, and #490 zero-usable rejection still require deliberate integration.

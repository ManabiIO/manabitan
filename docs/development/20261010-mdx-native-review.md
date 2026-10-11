# MDX native helper follow-up review — 2026-10-10

## Scope and ownership

Correctness-only follow-up in an isolated local clone under the owning yomitan-benchmark chat. Base: develop `e05294d263582b58bbe92c5e9f97349f6f60df31`, verified remotely at review start. No parent source/gitlinks/pins, shared dependencies, lookup partition, old tasks, or native closeout workers were changed. The preserved original dependency worktrees remain untouched.

Verified open draft PR heads: #482 `650bd14cbeeb045f5d6521dc054eafd39a611cef`, #483 `29c6c2113f5952ba62eb8d5e6ca07a748113bcdf`, #484 `b6f915e061dd0b4e93a08c226cb6bb46cc0c066a`. These are independent branches from develop, not a combined dependency state. This follow-up also starts directly from that develop baseline; it does not compose those drafts or update them.

Read parent/repository AGENTS, optimize-manabitan architecture and MDX/MDD references, the existing audit/ownership report, all three product diffs, native transport/conversion staging and cleanup, and native redirect conversion. Browser client uses Worker, not this retained experimental Python host. Native host framing dates to `2de4150cb`; this finding is not attributed to recent browser optimizations.

## Confirmed finding and fix

Medium correctness: `write_message` ignored the return values of both `os.write` calls. A short header/payload write could truncate a response, corrupt framing, and leave the receiver waiting for missing bytes. Zero progress was also treated as success. Deterministic fault injection limiting writes to two bytes reproduced malformed framing before the fix.

Add `_write_all` over memoryview slices for each existing header/payload buffer. It completes short writes, rejects zero progress with EOFError, and lets BrokenPipeError propagate through the existing `main` finally cleanup. This does not retry whole responses or restart conversion after a disconnect. Healthy full writes still use two write syscalls. Each partial write adds a syscall and a small view object; payload slicing does not copy remaining bytes. JSON encoding allocation is unchanged. No throughput measurement or zero-regression claim.

## Actually executed verification

Python 3.14.6 with stdlib and existing stub reader definitions; no installed dependencies.

- Before fix: three new framed-write tests ran; two failed (short frame and zero progress). Broken-pipe host cleanup passed.
- After fix: all five filtered `framed_` tests passed. They verify exact framed JSON under short writes, zero progress/BrokenPipe propagation, main cleanup after write disconnect, fragmented input reads, and truncated header/payload rejection.
- Fresh three-file source exports of exact PR #483 head: three `test_upload` cases and one staging test passed.
- Fresh three-file source exports of exact PR #484 head: selected noncontiguous MDD byte equality, staging/description override, and companion sorting tests passed (one each).
- `git diff --check` passed.

#482 received source review here; its ten-case failing-before/passing-after and focused Vitest results remain historical evidence in `20261010-mdx-bug-audit.md`. Earlier lifecycle/multipart/cache/asset/progress/worker results also remain historical, not rerun here. All new framing evidence uses injected stdlib I/O, not a launched native browser transport.

## Remaining gaps

- Failed conversion workspaces are removed only at host shutdown; repeated failures can retain staging/partial archive files. Successful download cleanup does not release original uploads. Automatic companion matching scans all retained uploads by basename, so repeated jobs and directory identity require a separate ownership contract and regression work.
- Staging flattens logical paths to basenames without collision checks. Explicit selections with equal basenames can overwrite earlier resources. This follow-up does not alter selection/lifecycle semantics.
- Native redirect map associates direct aliases only; chained redirects and missing/cyclic targets need explicit fidelity tests and policy. No broad HTML/CSS rewrite was made.
- Real PyGlossary encoding/encryption, native/browser HTML/CSS/redirect parity, installed database/media integration, cancellation during synchronous conversion, and real pipe disconnect timing remain unverified.

No full tests, builds, benchmark, browser/e2e/soak, native build, real parser, large dictionaries, user database, server, merge, deployment, or production action. The commit requests `[skip ci]` because automatic PR workflows include heavyweight jobs; pending required checks may remain. This is a reviewable draft, not release evidence.

# Import qualification — 2026-11-25

This measurement-only branch freezes independent complete-import comparisons for
[metadata witnesses (#831)](https://github.com/ManabiIO/manabitan/pull/831) and
[native media projection (#875)](https://github.com/ManabiIO/manabitan/pull/875).
Production candidates remain in their existing PRs. This branch is not intended
to merge.

## Frozen acquisition

[Protocol](../import-qualification-ca365.json) pins baseline and candidate commit
identities, exact release-member allowlists, browser version, observation orders
and decision thresholds. [Timing and memory methods](../import-memory-ca365/README.md)
describe the separate uninstrumented timing and instrumented memory acquisitions.
Each candidate is evaluated independently against the same develop baseline.
Their combination is not qualified by these comparisons.

Two independent hosted jobs per candidate and corpus collect complete timing
cohorts. Two further jobs collect separately instrumented memory observations.
A successful acquisition does not imply that the candidate passed its numerical
performance screen. All failures and observations remain part of the record.

## Local preparation and correctness

- [Complete metadata parser parity](metadata/README.md): all 7,613,164 rows per
  arm across the three pinned corpora; exact output agreement and source binding.
- [Native projection differential replay](media/report.md): 10,000 deterministic
  cases, with every usable projection matching the JavaScript collector and
  every malformed source returning the raw fallback sentinel.
- [Release preparation](package-preparation/review-summary.json): both candidate
  ZIPs have exactly their four allowed differences from the 551-member baseline.
  Every native module matches its own arm's manifest and the packaged C matches
  its exact source commit. This local helper check used Node 24.22.3; it is not a
  browser observation under the Node 22 qualification protocol.

[The archive](local-correctness-evidence.tar.gz) preserves the exact local oracle
programs, raw JSON and replay receipts. [Its manifest](archive-manifest.json)
records every input hash. Archive members retain their original formatting.
The media replay accepts a repository checkout as an argument. The metadata
scripts retain their original sibling-worktree paths for provenance; reproduce
that layout using the exact source commits documented in the parity record.

These checks establish parser correctness and package identity. They do not
establish whole-import latency or browser-memory behavior. Hosted results will
be recorded separately with their exact workflow and candidate identities.

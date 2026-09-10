# Multi-batch admission qualification

This branch contains verification transport only, not product ancestry. The source job reconstructs the four-file patch on PR #31, checks the complete Git tree and deterministic source commit, executes full units/options/types/lint/build checks, then publishes a source-only child. No PR or release merge is automatic.

The compressed transport files are exact copies of locally tested files. Decompress them with gzip; the workflow checks their SHA-256 values before use. Published product source is ordinary readable JavaScript and tests, not encoded patches.

Baseline for performance is accepted develop da8f7436d34e510441d30692c8d698806b70e13f. Candidate tree is 4035249c23197b72d8be9d4cca7ebd6476771ef1. Compare fixed adjacent alternating A/B pairs, excluded warmups and same-binary controls on native constrained Chromium. No navigator overrides, retries, outlier removal or partial-plan estimates. Check actual compressed versus ordinary transport, full bank/byte/row accounting and sampled persisted-content readability. Source source-batch bounds are not whole-process memory bounds.

The user-facing PR is opened or updated only after inspected whole-import results justify it. The original #31 and rejected experiments remain separate evidence.

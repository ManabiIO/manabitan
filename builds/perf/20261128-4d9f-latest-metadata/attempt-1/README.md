# First latest-source cohort and strict artifact audit

Run [46140311762](https://github.com/ManabiIO/manabitan/actions/runs/46140311762) used exact tooling `92467bf27b8ed0661085d65eaad8f134dc2f04cc`, A `a300da36d00df8e353c5679b1528b50a1299b75f`, and B `86cd5c18d325488b0ecb04c552d1dc83567de9d2`. All three original artifact ZIPs are retained unchanged and matched to GitHub's SHA256 receipts in `artifact-index.json`.

JMdict completed both fresh processes with exit 0, all 12 groups and 528,299 rows. Its complete original output oracle remains `5a2d8167f046e313949af8005ed493b651d10a4de95bfc5a2de24699ec61a58e`; the observed retained native/array backing reduction is exactly **4 MiB**. Every candidate group retains both implicit columns.

Jitendex and VNDB each failed in both arms at zero-based groups 4 and 11 respectively. The actual error is `TermContentLookupReadError: Database not open` during a cold persisted exact-dedupe read. Merged #982 now consults real SQLite legacy-root metadata on that path; the original scoped OPFS-only harness never opened SQLite. These are retained failures, not completed latest-source proofs. The previously completed f28 acquisitions remain separate.

The original workflow did not explicitly select Bash pipefail, so `tee` could mask a failing producer. Workflow status alone is therefore insufficient. The strict read-only audit verified all original artifact digests, source/profile hashes, helper identities, complete 26/26 TAP summaries on every host, exact Node22 binary and launcher exit receipts. It then re-executed the unchanged comparator on the same JMdict reports with an authoritative subprocess exit check. The result matched the original report exactly after excluding only the two local directory names. An intentionally invalid copied receipt failed through explicit Bash pipefail with exit 1 and produced no comparison output. **No dictionary import was re-executed.**

The original imports used pinned Node v22.22.0. The read-only JSON/comparator audit used local Node v24.22.3; this adds no performance observation and changes none of the original source/runtime receipts. Audit source, report and negative-control log are preserved here.

To reproduce the audit, copy the three ZIPs and `strict-readonly-audit.py` into a fresh directory, extract each ZIP into its named `jmdict`, `jitendex` or `vndb` subdirectory, and copy the exact public `test/perf/signature1-corpus-verification` files from commit `3da567143d51e2857eeec7550aef4e7e4de921e6` into an `audit-helper` subdirectory. Run `python3 strict-readonly-audit.py`. Start with a fresh directory because the unchanged comparator refuses to overwrite its output.

The prospective workflow correction explicitly selects Bash and adds a real exit-37-through-tee control. This audit branch does not match the acquisition workflow's push trigger. No unchanged corpus retry is authorized by this publication.

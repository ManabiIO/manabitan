# Final inspected decision — isolated i64 inflater, September 9, 2026

**Do not promote PR #28 as a whole-import speed improvement. Keep it draft and out of the release integration.** The component decompressor improved, but the latest complete JMnedict comparison was slower in all six pairs. This finding supersedes the provisional assessment in `inflate64-followup-20260909.md`; that report's earlier results remain valid and retained, not replaced.

Product controls are unchanged: baseline #24 `ff9cbf2e848a86d6bbfd281179a6d753349e52f4`, candidate `dc226aaf88a0f8d2d4b2bcc37778352be0104622`. The confirmation run [34335944244](https://github.com/ManabiIO/manabitan/actions/runs/34335944244) uses helper head `60ab7874bf2fc67181b7d1c8f25dd5389c64830a`; only the typed component-oracle location/documentation changed from the preceding verification. Whole-import driver, product code, inputs, six-pair A/B protocol, two interleaved A/A pairs, excluded warmup pair, fresh profiles and native memory selection did not change.

Both inspected JMnedict plans completed 18/18 imports, with all 36 reports independently revalidated. Artifact ZIP SHA-256, report hashes, source/package provenance, row/bank counts, complete source-byte accounting, native memory tier and sampled persisted readability passed. No outliers, retries or spliced jobs.

| Confirmation lane | Paired median | Equal-work total | Faster pairs | Worst pair |
|---|---:|---:|---:|---:|
| JMnedict 1 | -2.92% | -1.31% | 4/6 | +24.14% |
| JMnedict 2 | **+6.35%** | **+8.57%** | **0/6** | +21.51% |

Lane 2's exact pair changes: `[7.828122217417022, 4.868338339038347, 21.50936607524332, 8.44029919660123, 3.411625472256863, 4.453830936215963]` percent. Its same-binary baseline and candidate pairs varied -2.12% and +2.61%, respectively. Lane 1's same-binary baseline varied -45.53%, candidate +2.38%. Hosts are not pooled. These data justify withholding acceptance; they do not establish the underlying cause of the slower whole imports.

The earlier complete JMnedict jobs had paired medians +3.53% and -10.39%, as recorded in the preceding report. A faster isolated stage cannot be used to average away this whole-import concern. Previously established correctness and component results remain separate from release approval.

Confirmation artifact 10098193792: SHA-256 `af203297abe348195bb30145ac49905ef4b8e4991876aa94bdc3f3a63e4190d9`.
Confirmation artifact 10098172081: SHA-256 `81081df8486a3d1c6306001b64c13fd1c18198f9c783b9d2788f0f94fde08206`.
Full-precision independent recalculation and all raw inspected reports are retained as `CONFIRMATION-AUDIT.json` and `import-audit/confirmation/` in the delivered evidence bundle.

The other confirmation lanes and later queued helper-only workflow are not given effect estimates in this decision; only downloaded and validated complete plans support its claims. The preceding complete six-lane audit retains all 65 successful observations, including incomplete lanes with no effect estimates. The two sets together contain 101 revalidated retained reports; this count is not 101 independent A/B pairs.

Next useful work is paired attribution of parsing, copying/compression, storage and waits on a runtime that can complete the fixed plan reliably. Do not combine this candidate with #27/#29 to hide regression, change dictionary-specific policy, or weaken correctness gates. Reconcile the selected release ancestry separately and apply any shared #22 header change only once if later accepted. No release merge, Reader vendor update or v3-hotfix modification was made.

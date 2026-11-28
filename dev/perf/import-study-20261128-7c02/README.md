# Manabitan import optimization study — completed

**Final decision: no optimization PR.** The VNDB image-path candidate passed its component screen, saving about 25% projection CPU (roughly 80 ms per complete projection workload). The complete browser qualification did not meet the publication requirements. All six original cohorts are independently audited and preserved; no result remains pending.

## Final results

- [Final decision and findings](FINAL.md): the component gain, six-host browser results, JMdict findings, all eighteen avenues, incomplete experiments and limitations.
- [Investigation ledger](investigation-ledger.json): final experiment dispositions, original failures, infrastructure history and evidence identities.
- [Browser campaign result](browser-campaign-result.json): per-host statistics and unchanged qualification rules. Results are not pooled or adjusted by control drift.
- [Current-develop compatibility review](current-develop-compatibility.md): read-only source comparison with the later develop revision. No combined-tree execution or performance claim is made.

All 252 browser import receipts passed semantic checks. Three cohorts failed mandatory memory-sampling coverage across five invalid slots; this does not establish memory growth. Both VNDB cohorts also missed the stronger whole-import speed requirements independently of memory. No observations were replaced, no thresholds were relaxed, and no optimization PR was opened.

## Evidence and history

The final report and campaign result link every cohort's immutable raw-evidence bundle and independent audit. The original [hosted campaign](https://github.com/ManabiIO/manabitan/actions/runs/46113567719) is also available. Compact bundles retain all non-package original observation files; only the two rebuildable extension ZIP containers per host are omitted, with exact ZIP hashes and complete entry maps preserved.

The earlier [overview and ledger snapshot](https://github.com/ManabiIO/manabitan/tree/165c6a97b2a09004cdea460055747811569ff382/dev/perf/import-study-20261128-7c02) remain immutable history. Existing audit-preparation files and early publication receipts in this directory are historical records, not indications of outstanding work. Some early local experiment raw files were lost during executor resets; the ledger names those limitations explicitly.

Measurements use their recorded source revisions and scopes. The six browser cohorts compare baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` with candidate `e90c4c04172b691985858609094887f9541541dd`. Develop's later `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16` revision was not the measured product.

This study used three subagents extensively and did not use Work mode. All publication changes on this branch are research evidence; no change from this study was merged into the product.

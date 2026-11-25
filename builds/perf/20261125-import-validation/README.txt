Import validation evidence — 2026-11-25

Start with combined-validation.json for source heads, the original failed broad unit run, targeted recoveries, all four type checks and the combined Chrome package receipt. The JMdict-only sequence-hash experiment is outside that combined branch and remains unpublished.

logs/ and fixtures/ preserve the original evidence bytes. Receipt paths are relative to this directory and each linked raw file retains its source SHA-256. The original/fixed borrowed-worker reports are both included. The combined wrapper test passed in 1.56 seconds; its stdout was observed in the tool result but no separate stdout log was retained. Do not treat the targeted recoveries as an uninterrupted green broad run.

ci-observation.json is a dated read-only GitHub snapshot with exact PR and tested merge-checkout identities. Completed old-head checks are not attributed to a queued newer head. Its browser artifacts use cached recommended-feed fixtures and do not qualify the current locked JMdict/Jitendex/VNDB benchmark set or exhaustive media byte parity.

browser/ contains the frozen VNDB package/source/runtime identities, original driver and preparation scripts, raw startup reports and logs. Both baseline attempts failed before extension startup; no candidate/import/performance observation exists. Sandbox exception approval was automatically rejected before process creation. Package, source checkout, dependency, runtime and dictionary binaries are excluded. Duplicate HTML reports and initial complete package-member maps are omitted; their hashes remain in browser/evidence-manifest.json and the compact initial package delta. The final complete identity manifest is retained once.

Raw command paths, runtime paths and stack traces intentionally record the original environment. These are receipts, not a self-contained executable benchmark bundle. receipt-manifest.json enumerates all included files except itself, with sizes and SHA-256 hashes.

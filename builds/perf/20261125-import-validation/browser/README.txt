Browser qualification blocked before startup

Two baseline JMdict startup attempts failed when Chrome could not create a Unix socket (EPERM). Neither attempt imported a dictionary, so no import time or candidate comparison exists. Root permission escalation was automatically rejected before process creation. All local browser attempts stopped.

Read blocked-qualification.json for the exact status, missing gates and observation paths. identity.json records every tracked source-file hash, package member hash, frozen fixture identity, harness hash and actual runtime identity. The candidate package differs from baseline only in four intended dictionary JavaScript entries. A normal build initially introduced checkout-path differences in generated libraries; initial-package-delta.json preserves that finding and the original manifest hash. The qualification package was regenerated with the identical baseline library bytes using the unmodified build exporter, before either attempt.

The staging directory contains evidence and preparation/observation scripts only. Source clones, packages, dependencies, runtimes and dictionary archives are intentionally excluded. Paths in the identity and raw receipts refer to the original staging locations; these files are records, not a self-contained executable benchmark bundle. No repository files were changed or committed for this qualification attempt.

Portable publication omits duplicate HTML renderings and the initial full package-member manifests. Raw JSON observations, harness logs and the final complete identity manifest are retained. Evidence paths are relative to this directory; original runtime/command paths in raw receipts are intentionally unchanged.

# Portable evidence checks

`verify_text_archive.py` checks the compressed size/hash, exact sorted file
inventory, every member's size/hash, UTF-8 encoding, and normalized archive
metadata. An optional extraction destination must be new or empty. It can
verify every archive in this evidence collection using that archive's manifest.

`audit_timing.py` runs the unchanged retained timing auditor with explicit
repository and Node paths. It preloads the hash-verified captured storage
policy and binds only filesystem/runtime locations. It requires Node 22.22.0,
frozen harness file hashes, and exact equality with the recorded independent
audit result. It reopens raw reports and recomputes the paired analysis. The
original auditor is preserved as `audit_cohort_original.py` and inside each
applicable timing archive. Failed or incomplete cohorts continue to fail the
original auditor; the adapter supplies no retry or acceptance exception.

Use a repeated `--recorded-audit` for studies whose per-cohort independent
result is retained in an external envelope. Each explicit file must have
`status: "passed"` and an `audit` member; the result must equal that whole member
exactly. There is no missing-envelope fallback. These tools use Python assertions
as the captured auditors do; run ordinary Python, without `-O` or
`PYTHONOPTIMIZE`.

Raw memory scans can be replayed directly with each artifact's captured
`source/dev/perf/import-memory-20261124-3aac/audit_memory.py`. That auditor has
no dependency on the original workspace path. Pass the extracted artifact
directory as its argument. The `audit_memory_saved.py --candidate SHA ARTIFACT...`
adapter instead imports each hash-verified captured observer/auditor and compares
its entire result with the original summary without overwriting it. Successful
reconciliation preserves failed memory gates and null unqualified maxima.
A full package/receipt replay additionally needs the
matching omitted release ZIP payloads, whose exact sizes and hashes are in the
archive manifest. The original raw-scan and receipt auditors are unchanged.

All replay commands consume saved evidence. Their operation does not require a
browser, fixture downloads, or new performance acquisitions. Component harness
execution is a separate reproduction step described in the component index.

The [archival checks](archival-checks.json) record the only whitespace findings:
two captured CSVs use their original CRLF bytes, and two captured workflows
retain an original extra EOF newline. Each copy is byte-identical to its
source. These evidence files are preserved without formatting normalization;
all other newly staged text passes the whitespace check.

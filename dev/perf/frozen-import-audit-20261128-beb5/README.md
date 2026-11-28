# Audit and preserve fixed import observations

This workflow analyzes existing artifacts. It launches no browser, parser,
native benchmark, import, fixture replay or replacement timing run. The
original runtime candidates, measurement protocols and observations remain
unchanged.

The one combined Ubuntu 24.04 job attempts six registered corpus artifacts:
canonical-checksum and recent-first-prefix studies for JMdict, Jitendex and
VNDB. A seventh optional entry preserves the separate no-unroll CRC component
artifact without claiming an independent correctness or performance audit.

## Frozen inputs

| Study | Original run | Original source | Measured runtime |
| --- | --- | --- | --- |
| Canonical checksums | 46112170828, attempt 1 | 55113f0d9f85faf4a867a311d1d78dd9d2e80609 | 570ccc3968046269cb00d2053e49d3c32367031a |
| Recent-first prefix | 46114428610, attempt 1 | 633761548509a77b43b414b83a80033e17ed7399 | 1a935bddf29c4d87606d2facd4b168af7e1a40f1 |
| CRC preservation only | 46120623371, attempt 1 | 887884769ad1b7d54872975920fc0f8fd43a56ee | Exact production modules recorded by that original component study |

Canonical JMdict and Jitendex artifact IDs 15252673899 and 15252164797, and
recent-first IDs 15252998358, 15254136620 and 15254106199, are prelocked with
their sizes and API SHA256 digests in registration.json. The canonical VNDB and
CRC entries use the same fixed selection rule before an ID is available: one
unique exact artifact name under the registered run, source head, attempt 1 and
completed registered job. The resolver records the resulting API ID, size and
digest and rejects ambiguity, expiry or any disagreement with a prelocked
identity. It never chooses a newer run, a rerun or a replacement artifact.

All available prelocked entries are attempted before the future entries.
The batch shares a 3,600-second wait deadline and polls every 45 seconds.
Optional CRC preservation waits at most 600 additional seconds within that
same deadline. An individual auditor subprocess has a 600-second limit.
Timeouts and unavailable entries remain explicit failures or optional
unavailability; no original measurement is repeated.

## Auditors and the known-answer gate

The canonical portable auditor is loaded verbatim from its original source
checkout. Its SHA256 is
8422368e7e720d5ba0165b47054612cf20ca01c766377a97d8321bab0f33a656.
Acquisition also checks the exact study Git tree, original qualification
config, source hash map and source-identity receipt. The later two-comment type
correction does not change the original measured candidate attribution.

The prefix auditor is newly reconstructed from the frozen runner and protocol.
Its unavailable predecessor is not represented as recovered or reused. The
original independently retained report remains attributable to prefix-first
source 47f3c3262931d0a92728c72fcd5cfb9b0ccc49a0.

Before accepting recent-first results, this same job reads the three original
corrected prefix ZIPs from evidence commit
a355146b6c511f8ccdea3fd7fa60af9c450d904f. The new auditor must reconstruct all
5,661 ordered journal entries and reproduce the original per-corpus treatment
and control comparisons. Raw receipts, source/output identities, counts and
protocol gates remain exact. Only derived arithmetic permits absolute
1e-9 milliseconds or 1e-10 percentage points for Python-version rounding.

Each original oracle must independently contain its actual 242 comparisons,
175 successes and 67 exact errors. The known-answer verifier validates the
frozen case/variant matrix and retains the original baseline oracle projection.
Recent-first auditing receives that validated original oracle and old source
checkout, checking the unchanged baseline JavaScript and verifier identity
before comparing baseline case outcomes. Candidate-specific diagnostics are
not substituted for baseline outcomes.

A prefix audit requires a successful same-job known-answer report for the
exact new auditor SHA256. The proof's original evidence/source identities,
journal count, three corpus successes and arithmetic tolerance are checked,
and its own SHA256 is recorded in each acquisition receipt. A failed proof
blocks prefix acceptance while allowing acquisition, canonical audits and
retention of all original artifacts to continue.

All new code was prepared while the local executor was unavailable. No local
syntax, execution or known-answer pass is claimed. Hosted syntax checking,
known-answer reconstruction and independent source review are required.

## Scope of the conclusions

The prefix audit checks frozen executable and harness identities, strict
package hash maps, complete six-treatment/six-control schedules, flag-disabled
controls and the registered synthetic controls. Every journal entry, including
verification invocations excluded from timing, must match the saved report in
order. Complete-work sums are recomputed only after output, coverage, type and
activation checks.

Those prefix observations remain warm synchronous component work.
VNDB synchronous score-column options do not establish actual production
worker admission. Verification order does not establish a cold-start effect.

The canonical auditor checks all original package bytes, per-import semantic
receipts, timing arithmetic, exhaustive-media receipts and the prospective
memory gates. Its primary totalImportMs is measured inside the browser from
file-input change through completedAtMonotonicMs. Automation polling is a
separate metric. The termRecordWriteMs diagnostic includes checksum and other
write work; it is not an isolated checksum timer.

A completed byte audit may still report a failed memory gate. Acquisition
completion, independent audit success, protocol gates, preservation and a
performance decision are separate fields. The batch continues after a corpus
failure. It never trims observations, subtracts controls, pools hosts or
automatically promotes a runtime candidate.

The CRC entry verifies only the API-bound original archive and its full member
census. Its summary explicitly states that no independent correctness,
performance or qualification audit was performed.

## Download and failure evidence

Authenticated downloads use a no-redirect opener on the constructed
api.github.com endpoint. A signed storage redirect is followed by a fresh
request with no Authorization header. Tokens and signed URLs are never
printed. Full original ZIP size and SHA256 must match the API identity before
extraction.

Extraction rejects traversal, duplicate members, symlinks and nonregular
files. A complete census records every original member's size, CRC, attributes
and SHA256. Full raw ZIPs and extracted evidence remain in the combined
Actions artifact.

Failed subprocesses retain complete stdout/stderr files and print a bounded,
sanitized stderr tail with the entry and stage. Resolution changes, timeout
context, partial downloads, acquisition failures, failed qualifications and
retention failures remain available. A failure cannot suppress attempts for
the remaining registered entries.

## Git retention

The job's only Git write is POST /repos/ManabiIO/manabitan/git/blobs. It creates
immutable, unreferenced objects for whitelisted evidence files, verifies each
Git object hash, and prints path/size/GitSHA/SHA256 manifests. It writes no ref,
branch, commit, PR, workflow or original artifact. Unreferenced objects are
not described as durable until the root agent reviews and anchors them.

Prefix and CRC original outer ZIPs are retained verbatim. For canonical
artifacts, a reduced Git archive is allowed only after the full original-byte
audit completed. It omits only the exact package-A.zip and package-B.zip
members; every observation and other original member byte remains intact.
The omission manifest retains both package sizes/hashes, the full original
member census and the outer archive digest. A later full package/byte audit
cannot be repeated from the reduced archive alone without the original
package ZIPs. The full originals remain in the combined Actions artifact.

A failed byte audit preserves the canonical original ZIP verbatim. A failed
memory gate alone does not invalidate completed package-byte verification.
Any reduced-archive preparation failure also falls back to the original ZIP.
Individual blob upload failures are recorded and do not suppress subsequent
whitelisted files or corpora.

Retained Git paths are restricted to
dev/perf/import-round-20261128-beb5/hosted-audit/<registered-entry>/.
The combined batch summary records every attempted entry and distinguishes
optional preservation from required audit gates.

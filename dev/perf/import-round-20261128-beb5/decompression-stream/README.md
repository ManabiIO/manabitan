# Rejected: browser gzip inflation for JMdict

Both registered `DecompressionStream('gzip')` variants lost the complete
inflation/CRC/copy comparison against the existing native libdeflate path. Do
not promote this proposal to a product PR, implement the conditional hook, tune
another slice size, or claim a complete-import gain from these results.

The frozen campaign is [run 46108692453](https://github.com/ManabiIO/manabitan/actions/runs/46108692453),
research commit `70f3cda48ba768979a117f58a3901334d402f700`, exact tree
`17ff7a2b17c9130f43c347791567a6a9b0e631a0`. Its sole parent and unchanged runtime
baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.

## Complete registered result

Ratios are candidate divided by baseline, so values above one are slower.
All six treatment pairs and all six identical-source control pairs are retained
for each scenario. No observation was trimmed, replaced, pooled with another
host, or adjusted by subtracting the control.

| Arm                       | Median owning-work ratio | Equal-work ratio | Median paired work difference | Initialization-inclusive ratio | Faster work pairs |
| ------------------------- | -----------------------: | ---------------: | ----------------------------: | -----------------------------: | ----------------: |
| Gzip, fixed 64 KiB slices |                   1.4237 |           1.4229 |                    +75.795 ms |                         1.2283 |             0 / 6 |
| Gzip, fixed 1 KiB slices  |                   2.4506 |           2.4459 |                   +258.973 ms |                         1.9268 |             0 / 6 |
| Native / identical native |                   1.0239 |           1.0114 |                     +4.197 ms |                         0.9927 |             2 / 6 |

The study uses every locked JMdict term bank: 53 banks, 12 unchanged groups,
171,617,523 decoded bytes, containing 528,299 rows. Each of the 36 measured arms
uses a fresh full Chromium 153.0.8010.12 process/profile and three fresh parser
worker instances. Groups run serially round-robin, four per worker. The reported
work is the sum of group inflation, CRC, framing and copies into native memory;
the total adds parallel worker-initialization wall time. Neither is concurrent
complete-import latency. Parsing, storage, compression, media and first hover
are outside this component. The slower first groups and later groups are both
retained separately.

The existing JMdict profile's 459.3 ms `parserSourceInflateMs` already includes
immediate CRC and bank-wrapper checking inside `inflate_and_join_term_banks`.
A sampled CRC duration is part of that work, not an additional amount to add.
The component's different host/scheduling must not be compared with that ordinary
profile as though the two were a treatment pair.

## Conformance and resource limits

Chromium passed all 14 standalone format checks and all 157 source cases, with
both helpers checked for each source. This includes all hidden-second-gzip-member
and trailing-data adversaries. Complete decoded bytes, sizes and bank spans
match; separate unchanged-native replay matches registered failure ordering.
Direct DS exceptions are not claimed to have the existing importer's error
classes or messages.

Node 22 feasibility failures are preserved in [node](node/). Its gzip decoder
accepts additional members, including the framed adversary. Both final exact
helpers have 12 false acceptances among 157 cases, despite correct ordinary
JMdict bytes. No Node timing or production-eligibility claim is made.

The [resource review](resource/output-bound-review.md) establishes a conditional
bound on active decoded payload for the pinned Chromium implementation. It does
not establish the existing native hard declared-output-capacity bound, a portable
API allocation guarantee, or a process-residency cap. The historical
[production outline](resource/production-outline.md) is retained as analysis;
the negative timing closes that implementation avenue.

## Retained evidence and audit

`artifact.zip` is the **verbatim original GitHub artifact**, ID `15251391461`,
220,443 bytes, SHA-256
`b49c57e37e181d19541de6e9da21a30e267363df928dd6b99d00bca345c15591`.
It contains all 120 original members, including registrations, source/browser
identities, raw arms, journals, conformance, capture manifests and logs.
[artifact-receipt.json](artifact-receipt.json) preserves the API digest and
metadata; [artifact-members.json](artifact-members.json) inventories every member.
`job.log` is the complete decoded job log. Nothing was removed from the ZIP.

[independent-audit.json](independent-audit.json) verifies all 36 arms, 171
conformance records, every journal entry, 329 source hashes, output digests,
copy counters and all timing sums/ratios. The [portable auditor](audit.py)
reproduces it exactly except for the extraction directory path.
[REPRODUCE.md](REPRODUCE.md) documents the read-only audit and frozen source.
[original-files.json](original-files.json) identifies every verbatim copied
source artifact; [evidence-files.json](evidence-files.json) covers the complete
evidence package except its own self-referential hash. The original auditor and
unabridged decision are retained alongside the portable copy.

This commit adds evidence only. It changes no runtime or workflow and starts no
new timing campaign.

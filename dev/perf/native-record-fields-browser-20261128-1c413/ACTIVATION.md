# Native record-field activation receipt checker

This is prospective, records-only tooling. It does not launch a browser or an
importer, execute WASM, wait for optional-loader readiness, acquire timings, alter
observations, or choose a performance threshold. The checker and its 22 pure or
synthetic tests have not been executed during authoring. All actual eligibility
and coverage values remain unsealed until the new current-source corpus
correctness evidence is complete and independently reviewed.

## Study boundary and current inert state

The producer owns study.json, its source guard, the frozen browser workflow and
the separate numeric decision policy. The initial state must remain:

    "acquisitionEnabled": false,
    "activation": {
      "sealed": false,
      "perCorpus": {"jmdict": null, "jitendex": null, "vndb": null}
    }

The checker fails closed if acquisitionEnabled is not true, activation.sealed is
not true, or any of the three per-corpus policies is null, incomplete or bound
to different field runtime bytes. The checker never changes these fields.
Enabling a future study requires a separate reviewed publication decision after
all correctness gates; a boolean inside this reader is not authorization.

The fixed schedule is 24 measured A/B pairs, eight interleaved A/C pairs, two
warmup A/B pairs, two exhaustive-media reports and four instrumented memory
reports: 74 original reports, including 29 B reports. C is the identical inactive
A source/package. The exact unchanged qualifier schedule is regenerated and
compared with registered-plan.json. All 74 original report paths are read,
including media and memory. Missing or failed reports remain failures; they are
not replaced, excluded or promoted into timing evidence.

The packaging-equivalent control contains the same inert helper and native
asset. Its database and store remain inactive. expectedPackageEntries must be
exactly:

- js/dictionary/dictionary-database.js
- js/dictionary/term-record-opfs-store.js

study.runtimeSha256 binds these four current product paths by full SHA-256:

- ext/js/dictionary/term-record-fields.js
- ext/js/dictionary/term-record-opfs-store.js
- ext/js/dictionary/dictionary-database.js
- ext/lib/term-record-fields.wasm

Each candidate package's recorded entry hashes must match that map. Inactive A
must contain the identical shared helper and WASM bytes. The separate full
artifact reader still independently binds original run/head/attempt/API
metadata, archives and complete package member inventories; this activation
checker alone is not an archive verifier or full qualification decision.

## Sealing an actual corpus policy

Only complete current-source correctness evidence may supply these values, before
any production-browser timing. No value is chosen from observed browser timings.

Each perCorpus object has exactly these fields:

| Field | Required value |
| --- | --- |
| fixtureSha256 | Exact unchanged pinned archive SHA-256 |
| termRows | Exact pinned complete term-row count |
| expectedCalls | Complete actual encoder-entry count established by source-bound corpus proof |
| minimumNativeCalls | Explicit positive prospective native-call coverage requirement |
| minimumNativeRows | Explicit positive prospective native-row coverage requirement |
| maximumReadinessJavascriptCalls | Explicit prospective allowance, strictly below total calls |
| allowedDeclineMaximums | Exact map for eligibility, memory-bound and unsupported-compact; each maximum is explicit |
| proof | Exact source/receipt provenance below |

The proof object has exactly:

- runId, original attempt (one), headSha and artifactId;
- artifactSha256, comparisonSha256, candidateReportSha256 and fieldCallsSha256;
- completeTermByteParity equal to true;
- runtimeSha256 equal to the study's complete four-path map.

These are necessary provenance bindings. The checker does not download or
re-audit the proof archive. The review which seals the policy must establish
those receipt hashes, full source lineage and complete field/final-term byte
parity. A copied hash or a component-only result does not supply that evidence.

The schema deliberately avoids a hypothetical ready-path result for each
pre-readiness call. Current corpus observations do not necessarily prove such
counterfactual per-call copy or eligibility data.

## Actual browser receipt and counter path

The checker verifies pinned pure qualification_receipts.py and protocol.py
before importing them. The common qualifier itself is only hashed, never
imported or executed. For each report, the unchanged pure semantic validator
binds summary/raw data to dictionary, browser, source, package, protected
observer hashes and canonical receipts. Memory reports use only the exact
unchanged marker transformation. No sampler, process inspection, browser or
other acquisition helper is called.

The metric path is the actual raw report:

- the unique phases entry with data.kind equal to dictionary-import;
- data.importDebugHistory entries and their importerPhaseTimings;
- the unique successful bulk-finalization entry;
- details.termRecordFields.

The settings controller passes the original details object through, so the
nested field-session metrics remain available. This path was independently
checked against the unchanged importer/controller/report code; it is not the
different Node correctness driver's report nesting.

A/C must have no field-session metrics. Every B report must contain complete
session counters, positive native calls and positive native rows. Each original
metric object is retained even when its validation fails.

The following identities are checked independently of performance:

- calls equals nativeCalls plus javascriptCalls and the sealed total calls;
- nativeAttempts equals nativeCalls plus the five attempt-terminal decline
  categories (unsupported-compact, native-trap, native-return, native-header,
  output-copy);
- guard-exception, native-memory-alias, memory-growth, input-copy, native-trap,
  native-return, native-header, output-copy and unavailable are zero;
- all other decline names are rejected, while the three declared eligible
  fallback categories stay within their sealed maxima;
- javascriptCalls minus all declared declines is nonnegative and within the
  readiness allowance; this is a source-derived inferred readiness count, not a
  new timing or per-call browser observer;
- all numeric counters are nonnegative safe integers, coverage meets the sealed
  bounds and native rows cannot exceed the complete term-row count.

Copy and private-memory counters also follow the source-bound native format.
Every successful call copies two count*4 columns and nonempty unique references.
The checker does not assume uniqueCount is at most rowCount. Compact output has
16 header bytes, at least one int32 score and eight bytes per row, and must be
strictly smaller than the original twelve-byte format. Slot-table bytes are
bounded by the unchanged power-of-two score table. Private memory starts at two
64KiB pages, grows monotonically by pages and is capped at 64MiB; its growth,
peak and scratch counts must reconcile. No checksum or hash cache over mutable
caller buffers is introduced.

## Invocation and retained result

Run only after the original qualifier process has returned, preserving its exit
status separately:

    python3 dev/perf/native-record-fields-browser-20261128-1c413/audit-activation.py \
      --study dev/perf/native-record-fields-browser-20261128-1c413/study.json \
      --evidence /absolute/original-cell \
      --dictionary jmdict --initial-order AB \
      --output /absolute/new-activation-result.json

The output must be new. The JSON contains the exact study/checker identities,
source/plan/browser receipt hashes, all 74 ordered rows, each actual metric
object, derived counter accounting, and every failure. It prints the same
compact structured result to logs so an upload failure does not conceal all
counter evidence. Raw payload bytes and base64 archives are never printed.

The 22 tests cover sealing/source mismatches, A/C inactivity, natural readiness
and all declared fallback outcomes, complete native/copy/memory accounting,
invalid counters, duplicate finalization, both fixed timing schedules, all
74-report traversal, preservation of missing/failed observations, immutable input
files, memory-overlay/source mismatches and strict JSON parsing. Synthetic
reader fixtures stub the already-pinned semantic validator only to test
traversal/error handling; they are not actual corpus or semantic evidence.

Performance medians, equal-work ratios, same-code controls, strict memory gates,
all-media checks, full correctness and the final qualification decision remain
separate. An activation pass cannot substitute for any of them.

# Corrected offscreen activation receipt

Run `45470204352` at tooling `200b8680bad62e9f40b015ceebebc7382b54dd4b` completed all four jobs successfully. Tooling tree: `02fd3a7018bd0025141f178bd3ca35b3d7244a85`. This read-only receipt uses only retained artifacts; no additional browser or import was run.

## Actual route counts

| Diagnostic | Attempts | Private admissions | Prefix placements | Guard suffix fallbacks | Existing shared admissions |
|---|---:|---:|---:|---:|---:|
| Prefix / Jitendex | 22 | 21 | 21 | 0 | 0 |
| Prefix / JMdict | 12 | 0 | 0 | 0 | 12 |
| Prefix / VNDB | 170 | 0 | 0 | 0 | 0 |

All prefix jobs used PR #874 source `ebb1da8d2cc2b28901400968891b632605f1b3f0`, tree `243ab638da9cb73e08d84609c41dcdfdf08475cd`, plus the exact diagnostic patch. Every diagnostic phase identifies the real production offscreen owner.

Jitendex's first owned private batch remains an unforced selection attempt with no private reservation. Every subsequent group has the exact attempt, private begin, prefix sequence; all 21 begins have `initialSelection: false`. These cover 372,728,692 selected unique-content bytes and 351,495 entries, from 372,749,014 eligible source bytes. Each frame start is its reference start plus 20 bytes per unique entry; every bounded final cursor is at most `0xfffffffe`. Zero guard fallbacks means the actual fixtures do not exercise the high-offset path; focused synthetic-cursor tests retain that coverage.

JMdict retains twelve shared admission pairs and exactly one initial shared selection. VNDB has only private-source attempt events, all with a null compression dictionary; its first two attempts are unforced and the remaining 168 forced. None enters this candidate's dictionary-specific private path.

PR #876's cache JMdict job used source `cdb23a11d991a72f860e400d0d81bb0747a5b4f9`, tree `1edef4035041ef848175e3278169daf2260ac34a`. All twelve publication calls are immediately followed by matching receivers. All twelve receivers reuse a true contiguous-range publication proof: 362,032 unique entries and 101,143,985 source bytes.

## Reconciliation and scope

The independent script verified downloaded archive hashes, exact committed instrumentation/workflow/summarizer bytes, full-index source patches before and after build, source/tree receipts, prepared fixture hashes and lock, unchanged benchmark/dependency hashes, Node 22.22.0, Chromium 153.0.8010.12, report hashes, package-hash consistency, raw event ordering and arithmetic, complete term-row counts and restart, deterministic canonical lookup receipts, sampled media, and normalized per-file logical storage sizes.

| Dictionary | Term rows after restart | Lookup receipts | Sampled media / total media | OPFS bytes |
|---|---:|---:|---:|---:|
| JMdict (both jobs) | 528,299 | 72 each | 0 / 0 | 43,520,477 |
| Jitendex | 436,555 | 72 | 64 / 236 | 67,466,332 |
| VNDB | 6,648,310 | 72 | 64 / 146,570 | 609,553,611 |

All lookup, offset-sensitive probe-digest and per-file size receipts match the retained prior same-layout correctness observations. Normalization is restricted to media generation UUIDs and SQLite opaque basenames. These diagnostics do not establish exhaustive content equality across every row or exhaustive media equality. The artifact contains package SHA receipts, not the actual product ZIP, so reported package hashes are reconciled across report/summary/sha256 receipts rather than rehashed from missing product bytes.

The standard benchmark harness still labels its usual timing boundary authoritative because that harness was unchanged. These four source-instrumented observations are explicitly **non-authoritative for timing** in their activation summaries and this receipt. No timing from them is used. Route activation is proved; PR #874's performance recommendation remains **HOLD** because the independent forward timing host did not establish a material gain.

## Retained original failures

All four failures from run `45468163108` remain under `../activation-failures-45468163108`. Three completed imports lacked a diagnostic phase because the first instrumentation targeted the fallback worker. Jitendex timed out before browser startup. The corrected diagnostic does not erase those outcomes, reinterpret missing counters as zero activation, or alter either runtime candidate.

## Downloaded artifact hashes

| Cell | Artifact | Verified ZIP SHA-256 |
|---|---|---|
| Prefix Jitendex | 14956446688 | `7822ac53c54913d9b05696099678184b4a34e7024c7464fae96b3ac5981abc33` |
| Prefix JMdict | 14956736581 | `88fbfc6b059405feaf1f6f28f8e0de8ae60ce80b0e56f51273cab2253954b9b2` |
| Prefix VNDB | 14956967658 | `5d12544116d6587f8ca5db3238cb2d1b66e0faee1b5a93e1f0e8a82eb9a6867e` |
| Cache JMdict | 14957926735 | `086fac74d7b9348bcb48dfd9f6570570f475486a1f03f9838188498118f397c0` |

This directory retains all four original ZIPs, safely extracted files, complete job logs, GitHub metadata, `reconcile.py`, and `independent-review.json`.

## Problem

The main import worker's run-boundary validation asks two helpers for each resolved content reference, repeating reference selection and the row's unique-index lookup. The baseline VNDB trace identifies this synchronous validation as remaining serial work.

## Change

Select the owned resolved-reference path once for each synchronous run, then read each row's unique index once for its offset and length. Both array bounds and the existing numeric, sentinel, offset-span and run-splitting validation remain in place. Selection is recomputed after every awaited append.

Fixed spans, fixed-length overrides, malformed descriptors and shared-backed reference columns retain the existing helper path. This changes no cache, allocation policy, format, grouping, concurrency or durability behavior. It does not duplicate #764's separate record-field encoding optimization.

## Validation

- 208 focused record-store and new boundary tests passed.
- An independent exact-commit comparison matches complete serialized lookup-sidecar bytes, run boundaries and error class/message in 23 cases, including offset splits, all record formats, malformed references, fixed overrides, shared columns and reference replacement across an awaited append.
- Scoped JavaScript lint, full main types, scoped new-test types and all-target build dry runs passed.
- Native WASM is unchanged.

## Qualification: HOLD

[Full CI 45124698611](https://github.com/ManabiIO/manabitan/actions/runs/45124698611) passed at the exact runtime head, including full main/dev/test/bench types, unit suites, build and Chromium/Firefox extension checks. Restart/interruption, CodeQL and other required workflows also passed. Conditional skipped jobs are not counted as executed passes.

The frozen [complete-browser study, run 45124794707](https://github.com/ManabiIO/manabitan/actions/runs/45124794707), research source `c0c2fdc79c9b4364e1a7fdfc915e5fd13ef332bc`, completed all six cells: **252 successful imports, 36 excluded warmups and 216 measured imports**. Each independent dictionary/direction job contains twelve adjacent AB/BA candidate/parent pairs and six interleaved unchanged-code controls. Both independent source/package/work/raw-clock audits pass. Every observation passes production OPFS publication, twelve source-derived persisted-content probes and a full browser restart; these are sampled readback, not exhaustive persisted-output equality.

Negative means faster. Independent hosts are reported separately; controls are not subtracted and no observation is discarded.

| Corpus | B/A median, forward / reverse | B/A equal work | Same-code C/A equal work |
| --- | ---: | ---: | ---: |
| JMdict | +1.07% / -3.62% | -1.09% / +2.22% | -1.62% / -0.97% |
| Jitendex | -0.41% / -1.12% | -0.30% / -1.01% | +0.08% / -0.03% |
| VNDB | -0.02% / -0.87% | +0.38% / -0.92% | +1.45% / +0.22% |

Jitendex's validation-phase counter improves about 36% in each direction, and VNDB's forward validation phase improves about 24% on equal work. Those counters identify a local mechanism; they do not directly count branch hits or establish complete-import savings. Both Jitendex whole-import median intervals include zero. VNDB's favorable reverse interval does not reproduce forward. JMdict retains a +44.27% slower reverse pair and substantial drift; its favorable median does not describe its equal-work result.

**Keep this candidate draft: no replicated material complete-import benefit.** No benchmark observation was retried or replaced. Trace weights are discovery evidence, not elapsed-time savings. Raw observations, all controls/tails, exact source identities and retained local validation failures are preserved in [#814](https://github.com/ManabiIO/manabitan/pull/814).

Baseline `5e1f8c12f7ff798ba407323aff675cb23b22af02`; runtime `cf1e18d59d08da729d4b2fe45c7a07021f42360a`; exact published tree `64d89a6c4d6b9722d30580d5cc834ebb7eac0057`.

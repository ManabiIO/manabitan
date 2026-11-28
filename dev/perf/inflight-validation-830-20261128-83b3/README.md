# JMdict in-flight validation: current-source evidence

The exact final #830 guard saves **16.9997 ms median in direct registration**
against the mean of two identical-code controls over the complete current
JMdict corpus. It is faster than both controls in **all 12 rounds**. This is a
credible component improvement worth reviewing; complete browser qualification
remains pending and the PR should remain a draft for that qualification.

The broader sink-and-drain aggregate is too variable here to establish total
storage or import speedup. Its favorable 11.217% paired median is **not a
qualified total-gain claim**: B beats both controls only 4/12, while unchanged
C−A ranges from −455.6119 to +353.5686 ms (−38.960% to +60.918%).

## Download and exact layout

- [Complete evidence archive](evidence.tar.gz): 1,514,762 bytes,
  SHA256 `01a3154653e6b55de5ab4b689abf42b017cf6c5d2b4959c6c59f50244d7f0b2d`.
- [Full file manifest](MANIFEST.json.txt): every one of 305 archive
  members has a byte length, SHA256 and Git blob identity. Every member was
  reread from the completed archive and compared to its unchanged source file.

The archive retains all 8,041,560 uncompressed
payload bytes. Extract it before following the inner README links. Its main
directory is `20261128-inflight-validation-830/`; the two existing oracle receipts are included at their
original sibling paths, and the exact two candidate files are under `source/`.
This layout is self-contained for evidence review. It does not duplicate the
dictionary ZIP or require the reclaimed raw compression capture slabs.

Inside the study directory:

| Evidence                                                           | Archive path relative to study directory                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Complete explanation and reproduction boundary                     | `README.md`                                                         |
| Prospective schedule, resource policy and frozen identities        | `protocol.md`, `protocol.json`                                      |
| Actual producer admission and complete-output preflight            | `preflight-1/`                                                      |
| All 36 chronological raw/control observations and child exits      | `cohort-1/result.json`, `cohort-1/round-*`                          |
| Fixed analysis and independent full recomputation                  | `cohort-1/analysis.json`, `cohort-1/independent-readback.json`      |
| Exact original patch, current port and reproducible commit payload | `upstream.diff`, `port.diff`, `port-commit.txt`, `port-source.json` |
| Actual contract/type/lint commands, reports and failures           | `focused-tests*`, `scoped-types*`, `scoped-eslint*`                 |
| Packaging ENOSPC receipt and original partial archive              | `setup-failures/`                                                   |
| Frozen actual-sink runner and publication builder                  | `common.mjs`, `sink-child.mjs`, `run.mjs`, `build-bundle.py`        |

## What was measured

A and C are byte-identical develop
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. B is exact upstream #830 head
`a628c6c7915576dcf280e98bc9129a508f2f9644` ported to that baseline, without
additional optimization. The component source-only commit is
`3eb1b7afa13c821af96e95fee1d6b4583af8e434`, tree
`28e0dd109918bc63a106e78cee718a7eb8c9d91e`.

The runtime SHA256 is
`12569a57197d4923fff7ed74fe6da071b4fff6d7a01bb9112e848c2a9d25cbbd`; the test SHA256
is `0b162f3d4889fba176a08aaee15bd8641115db7012f75c5124dcaf43119c30fe`.
The original final guarded source was reviewed independently; no pre-hardening
or older-corpus timing was pooled into this study.

The protocol fixed all six ABC permutations twice, with a fresh Node 22.22.0
process and four native codec workers per arm. It measured the first complete
current-corpus pass, without corpus warmup or inspector in measured children.
All 528,299 rows, 362,032 unique spans, 12 groups and 103 native frames were
processed. The parser ran sequentially in an explicit Node OPFS adapter.

| Whole-corpus metric, ms          | A median | B median | C median | Paired median B − mean(A,C) | B beats both |
| -------------------------------- | -------: | -------: | -------: | --------------------------: | -----------: |
| Direct registration              |  29.0262 |  10.2345 |  30.0897 |         −16.9997 (−63.919%) |      12 / 12 |
| Foreground sink plus final drain | 749.2108 | 670.5080 | 729.4417 |         −90.2432 (−11.217%) |       4 / 12 |

Paired differences use each matched round, not subtraction of the marginal
medians shown above. The direct component saving is 8.7007–28.0118 ms against
the matched control mean in every round. The primary is a noncontiguous sum of
12 public sink calls plus final session drain; its separate contiguous pipeline
envelope includes parser/oracle gaps and is diagnostic only. The secondary
direct-registration aggregate excludes producer factory work, which is inside
the primary. This is not a hardware-cache-cold or whole-browser measurement.

## Correctness and validation

Untimed precise coverage of unchanged candidate source proves all 12 actual
producer calls reach the guard's true return, with zero generic-loop body
executions. Every measured child checks the full span work count. The exact real
parent owned-content receipt is restored before the public sink. All codec
boundaries are idle and all planned, dispatched, source-consumed and completed
counts reconcile through final drain.

All 36 children exited 0 and matched all source/descriptor/native-frame oracles.
All 43,315,677 persisted bytes and 23 metadata fields match after normalizing only
the documented random 16-byte paired record/index generation IDs; raw hashes,
IDs and validated linkage are retained. No runtime randomness is replaced.
Independent readback verified every source/config/result identity and recomputed
every observation in all four recorded metrics.

293 current focused cases and scoped types passed. Initial scoped ESLint was
SIGKILLed without a reported source violation; one later authorized attempt on
the unchanged source passed with exit 0 in 26.431 seconds. Both logs remain.
Checkpoint packaging hit ENOSPC before timing; that failure is retained and the
original resource gates passed after safe reclamation. No measured child failed,
was replaced, or was excluded. No optional timing round ran.

The prospective protocol and successful admission were durably checkpointed
before the first timed child (archive Git blob
`10c2b7dd636c87e0912285c77810a10c8d70295f`, manifest
`7f4425631db4049d838d12c40a1d054bca969dbe`).
The full-cohort result SHA256 is
`c9a77c4417ac8525b1c4ab78c9e339eb4a8ac74f88ac429c43ea030518bb0ad9` and the independent
readback SHA256 is
`96a890c4de9e1bc2d18eb6fde9c3602cc45e91dac0a58690ac529cecae29c9fe`.
Any subsequent browser qualification must bind its own published head and keep
the exact runtime bytes above. This archive is evidence, not a whole-import or
memory qualification result.

# Single-pragma CRC screen: raw-artifact and logged-total audits

The one fixed default-engine Node screen shows a small, consistent owning-phase
benefit. It does not establish a browser or complete-import speedup, and no
performance PR is justified from this component alone.

The frozen [run 46120623371](https://github.com/ManabiIO/manabitan/actions/runs/46120623371)
uses research commit `887884769ad1b7d54872975920fc0f8fd43a56ee`, tree
`2dc2cfa2a858ca7cea7ee8317abc2c14fd3f34af`, sole parent
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The candidate is the one
registered inner-loop `#pragma clang loop unroll(disable)`, applied only to an
artifact copy of the baseline source. No lane, table, threshold, CRC fold,
worker count or grouping policy changes.

## Independent arithmetic from complete job logs

All 24 per-arm totals occur once in the prospectively registered order. The
independently recalculated six treatment and six identical-code pairs agree
with every logged aggregate. Positive changes mean slower.

| Scope | Treatment median | Treatment equal-work | Median paired difference | Faster treatment pairs | Identical-code median | Identical-code equal-work |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First complete pass | -4.1494% | -4.0608% | -7.1834 ms | 6/6 | -0.6516% | -0.8094% |
| Second complete pass | -4.0692% | -4.0688% | -5.7959 ms | 6/6 | +0.0237% | +0.2265% |
| Startup + first pass | -3.9066% | -3.3147% | -9.4310 ms | 6/6 | -0.8824% | -1.0313% |

These are separate first and second full passes through all 53 locked JMdict
banks in 12 unchanged groups, totaling 528,299 rows and 171,617,523 decoded
bytes. No observation was replaced, trimmed, control-subtracted or pooled.
The cohort uses 24 fresh default Node 22.22.0 processes, each with three private
worker instances sharing compiled module code. There is no timing warmup.
The first pass includes each instance's initial work, but later instances can
reuse compiled code; it is not three independent cold compilers. The second
pass is not asserted to be fully optimized.

The owning timer covers the exact production compressed-source inflater:
allocation, compressed-input copies, inflation, immediate CRC and wrapper
validation. Output copies/hashes used by the oracle occur outside the timer.
Groups execute serially in fixed round-robin order. Startup adds compilation
and parallel worker initialization wall time to summed serial owning work.
None of these values is concurrent complete-import latency or a CRC-only
measurement. The approximately 6–7 ms saving is summed component work on
this one Node host; it is not a projected browser saving.

## Gate and source evidence

The complete job log reports both mandatory production-module hashes reproduced
before timing: baseline
`8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee`
(67,659 bytes), candidate
`1d0990753b18591d0befd2be35e6fc5a7ba9ae93e48e883184d13f01fe0526e8`
(66,638 bytes). It then reports 837 deterministic CRC vectors, 157 production
source-conformance cases and all 12 complete JMdict source groups passing.
The test-export modules are limited to correctness vectors; timing uses the
exact production modules. Functional verification runs in a separate process.

The original log-only auditor binds these logged assertions and their order.
A separate completed raw-artifact audit now verifies all 327 original members,
27 source files against the frozen Git commit, the production and test modules,
all 837 vectors, 157 source cases, 12 source groups, 1,006 verification-journal
entries, 24 fresh-process arms, 576 timed group records and 1,368 arm-journal
entries. It reconciles every group, schedule, output, invocation/copy boundary,
capacity and aggregate with the original observations and complete job log.
`raw-audit.py` and `independent-raw-audit.json` retain this read-only audit.
No parser, native code, timing process or import was rerun for either audit.
Equal recorded WASM capacities are not a process-memory qualification.

Original artifact ID `15255386235`, name
`crc-no-unroll-screen-beb5-jmdict`, 641,405 bytes, API/upload SHA-256
`7f48f3a5957a0de458455086e7babb22b876278f62dda934d0a5906d5719c59d`.
The complete original ZIP was downloaded and its byte count and SHA-256 were
independently verified before extraction. `artifact-receipt.json` preserves the
original API binding. The verbatim archive and member census are durably
retained under `../hosted-audit/crc-no-unroll-jmdict/`. The combined hosted
acquisition independently agrees with that archive identity.

`job.log` is the complete decoded job log: 42,442 UTF-8 bytes, SHA-256
`63bf261b087d4e821b230ea4f497602ad6b8f9e55c86adb948287ff862d6ea6f`.
`logged-totals-audit.json` retains all 24 arm totals, all paired ratios, all
sums and the six independently recomputed summaries.

## Baseline advance and remaining limits

Develop advanced to `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16` through #972
while this study was queued. Read-only comparison finds no direct CRC source
change: the first 60,921 bytes of the parser source, including CRC and native
inflation functions, are identical. The separate inflater source, compiler
versions and build arguments are also unchanged. The complete parser module
does change. This component result remains attributed to the original `9e10`
baseline. The separate current-base candidate `19db774b564064a7e339d3c3a79ea8da04ab48b5`
uses the same single pragma and has independent native reproduction, full
correctness and source/unit gates. Its prospective browser study
`477fb271ef25fac533fb1faf737a5dab898190e3` must be evaluated separately; no old
and new results are pooled or treated as additive.

Forced-TurboFan codegen diagnostics motivated the experiment but do not explain
the measured improvement by themselves. The pragma also introduces state-array
memory operations and a 32-byte static initializer. No browser, complete-import
or process-memory qualification belongs to this screen.

## Reproduce only the logged-total audit

With Node available:

```sh
node audit-logged-totals.mjs job.log /absolute/path/to/new-result.json
```

The auditor requires the exact original log hash and refuses to replace an
existing output. Its arithmetic body was first executed against the retrieved log
in the available JavaScript analysis runtime. After the local executor
recovered, the standalone Node 22.22.0 CLI produced a byte-identical result.
This read-only audit starts no import or timing process. The frozen workflow/registration
remain under `dev/perf/crc-no-unroll-20261128-beb5/` in the research commit.

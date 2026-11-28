# CRC gap-tail study

This is a frozen research comparison, not a runtime promotion.

- Baseline A and identical control C: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.
- Candidate B: `a9171ea47b086474fa176c04b5531beee4d69e7c`, tree `cadfb45a302871b8fd1263473f6b62d6b8a9a2c7`.
- Local equivalent: `ebe3cb418a67c2fb65c0949ea0defdd38458ffcf`.
- Candidate parser SHA256: `b362d9b0106c28e9cb495d66c650463c771e165cb8ebadc4a66adda973466fd9`.

The native change processes the complete eight-byte and four-byte portions of a CRC gap tail with existing IEEE slicing tables. Every read stays inside the same span, final scalar handling remains, and no table, allocation, source admission, CRC witness, storage format, worker count or compression parameter changes. Only function 5 changes in the compiled module (538 to 822 bytes); all other function bodies and non-code sections are identical. The complete module grows 284 bytes.

## Scope and fixed protocol

Timing is prospectively limited to VNDB because actual compressed-source replay shows default deferred CRC active for all 170 VNDB groups and inactive for JMdict/Jitendex. Both inactive corpora retain complete compressed parity; this study makes no speed claim for them.

Each of two independent hosts has three excluded warmups and twelve complete ABC blocks with fresh browser profiles. The second host reverses every block. Timing retains the ordinary file-input change through completed post-UI work, with no product or harness overlay. `protocol.json` fixes identities, fixture/runtime, schedule, member changes, statistics, and gates before acquisition. No retries, appended samples, tail exclusion, host pooling, or control subtraction are allowed.

The preflight uses `compressed-corpus-replay.mjs`, not the decoded-source lookup replay. It independently inflates and checks every ZIP CRC/size with Node zlib, runs the production compressed-source preload and strict parser, proves unchanged source CRC admission/reuse, compares every canonical output/lookup digest, and rejects ten corrupt/truncated/trailing/size cases per corpus before dispatch. It covers all 7,613,164 rows across 937 banks. Both hosted cells repeat this complete all-corpus preflight.

The exact candidate additionally runs full units, scoped CRC test lint, main/test types, and all dry build targets. Every ordinary browser import retains semantic/storage/lookup receipts. Exhaustive media, four separate process-tree memory observations, and separate CPU traces follow timing. Memory qualification remains independent of speed.

## Prior component evidence and limits

Local correctness passed 95 focused tests and complete compressed parity. The actual VNDB distribution has 5,648,875 gap calls covering 407,601,778 bytes. The change replaces 33,289,408 scalar tail byte updates with bounded slicing operations. Twenty-six groups use the unchanged whole-bank verifier.

A fixed content-independent 1/1024 sample selected 5,451 real gaps with original alignment and incoming CRC state. Diagnostic modules changed only export aliases; all original function bodies remained byte-identical. A fully warmed, eager-compiled Node 24 kernel screen completed twelve balanced ABC blocks with 256 repetitions per window and exact output checks. CPU paired medians were −13.93% versus A and −13.94% versus C. Identical-code C/A median was +0.46%, but severe retained tails produced C/A equal-work −20.77%. These are noisy isolated kernel measurements and do not establish an import gain. Hosted Node 22.22.0 / Chromium 153.0.8010.12 measurement is a separate boundary and runtime.

Promotion requires a repeatable complete-import benefit against both controls on both independent hosts, assessed against control variation, plus complete correctness and memory gates.

Fused compact record fields: exploratory evidence and prospective oracle
======================================================================

Frozen baseline: 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2
Product candidate: aa2473f42957648d71912af0547a99039f795840
Previous prospective source: daddc68070aeb6156605bd114e8bf2d49367557f
Runtime algorithm review: e66df983c9dc3a55a86fbe27466ea3e6fd8a45bc
Earlier prototype with a fixedContentOffsetBase getter gap: 6d0dcf330ad65968a6463c3c2e5d3e36763a30d5

This directory does not establish an import speedup. The product tries to
combine exact content-span validation/minimum-base discovery with compact
score-palette discovery. It retains per-unique-span numeric validation, exact
base/field bytes, split and legacy fallback, and a single normal async boundary.
Actual producer identities, ordinary private metadata columns, and original
encoder methods are required before the trial can publish fresh output.

Recorded executable-source checks
--------------------------------
helper-harness.js.txt contains extracted actual baseline selector/encoder and
the corrected candidate helper, including its reference-origin guards.
helper-oracle.mjs.txt generates 2019 deterministic cases: 1653 exact compact
field/base matches, 247 exact error matches, 119 conservative fallbacks.
helper-oracle-results.json retains every case, including both error messages.
Run from repository root:
  node --input-type=module < dev/perf/import-fused-fields-20261128-d2d13264/helper-oracle.mjs.txt

integration-{baseline,candidate}-harness.js.txt preserve the actual writer,
field encoder, chunk encoder, reference validators and prepared entry helpers
with a minimal constructor and append capture. Fallback lookup serialization
is stubbed identically. Thus the 41 exact output/error/read-order cases are
control-flow evidence, not complete sidecar-envelope or OPFS persistence proof.
Run:
  node --input-type=module < dev/perf/import-fused-fields-20261128-d2d13264/integration-oracle.mjs.txt

Initial incomplete harness failures and the concrete fixed-base getter
regression before repair are retained separately, not counted as passing.
The original helper benchmark was exploratory, executed in functions V8 using
Date.now with 4 warmups and 8 alternating pairs per alias case, 6 replays of
528299 rows across 12 chunks per observation. Raw pairs are preserved. It
predates strengthened admission and the integrated writer. Its workload source
was not frozen at observation time, so do not use it as exact-source evidence.
synthetic-helper.mjs.txt is a reproducible, explicitly defined current-helper
workload for optional future component probes; it is not a reconstruction claim
for those earlier timings. No component result is an end-to-end gain.

Full-source gates (prospective)
------------------------------
The real Vitest product tests compare full envelopes with the real lookup
encoder and append-only interception. Hosted validation must run those tests,
all existing unit tests, scoped lint, full type checks and all build targets.

actual-worker-oracle.mjs.txt adapts the current baseline's retained #897
record-split replay. It runs the actual production planner and three parser
workers with the locked corpus, then invokes unmodified baseline/candidate
record encoders. Only append persistence is captured. Native content lengths
receive deterministic resolved offsets; both complete envelope bytes and all
append arguments must match. The report includes source/fixture/WASM hashes,
worker/group shape, shared source slab state, observed fused rows and envelope
digests. It does not exercise global dedup/compression or full OPFS/database
persistence, and it makes no elapsed-import claim.

Place a .mjs copy under builds so @zip.js/zip.js resolves, then:
  node builds/actual-worker-oracle.mjs BASE_TREE CANDIDATE_TREE \
    builds/e2e-dictionary-cache OUTPUT.json jmdict 4 8
Repeat for jitendex and vndb. Each source tree requires unchanged dependencies
and build:libs. The prospective workflow requires successful exact envelopes
on all three; JMdict additionally requires 12 prepared groups, exactly three
workers, and all 528299 rows to activate the fused path before browser timing.

Measurement tooling
-------------------
The package addition helper and qualification runner are copied unchanged
from 6c6f089cfd19db31968aaaac35bd13c4ac39ff4e. Their default remains no additions;
this experiment prospectively allows exactly the new preparation module and
forbids any removed package files. The schedule/measurement/control/exhaustive/
memory suffix remains identical to frozen9e10 except for recording the added
package list in registered metadata. Eleven new helper and32 existing
receipt/memory tests were executed successfully in hosted job140848450007.
Browser screening is six pairs per dictionary and cannot justify a PR.
Two independent12-pair JMdict cohorts with >=3% gain and all prospective
control/correctness/storage/memory criteria are required for promotion.

Local validation follow-up
--------------------------
Candidate aa2473 changes the original-method captures to typed Reflect.get calls
for repository style, adds missing test docs/layout, and uses Node's exact
byte-aware deepEqual for large test envelopes. Hot loops and admission logic
are unchanged. All33 actual-source cases pass. The partial test-only style
check passes using the official disableTypeChecked diagnostic overlay; local
full typed lint was killed by resource pressure. All failed setup, heap-limit,
worker-exit and killed-process attempts remain in local-validation-logs.json.
No full lint/type or end-to-end claim follows from this local diagnostic.
See local-validation-manifest.json for exact source bindings and commands.

Final pre-acquisition source and oracle binding
============================================
The current candidate is 91dfdea8f6d2f801b97c1f05a25102f3308371b0, tree cc5ebc68ac9c185cb5ea0c7313f37bd22be47c00. This tree is identical to local f04bc9af7e4b0dbbf61e69f95bb3a06861d0caa5. Before any qualifying acquisition, independent review identified typed metadata prototype hooks, forged native array kinds, and constructor instance hooks that could change the original first-error or getter-observation behavior. The final admission checks decline those callers before the unchanged original path. The compact encoding algorithm and ordinary-input bytes are unchanged. Prior source observations, if any, are superseded rather than pooled.

The helper and candidate integration harnesses were regenerated from these exact sources. source-bindings.json records five source-file hashes and61 executable fragment bindings; verify-source-bindings.py checks the pinned commit/tree, whole files, and every extracted function/constant/method before replay. The baseline integration harness remains byte-for-byte identical to workflow2182621584aae812e0db8379727bb2e4c781dd25. The2019 helper cases,41 integration cases, constructor/lookup/persistence stubs and numeric test thresholds are unchanged. The portable extraction reproducer accepts --repo, --output, --candidate, and optional --local-tested-commit arguments. These extracted-source checks retain their stated component scope; the full original lint/types/unit/build and actual-worker corpus gates remain mandatory.

The workflow delta changes only the candidate pin and adds the source-binding check before the existing deterministic replays. The six-pair acquisition schedules, warmups, A/C controls, exhaustive verifier, separate memory passes, fixed package additions, prospective criteria, failure retention, and compact observation logging remain unchanged. No timing claim is made by this update.

# Manabitan import optimization — phase2B checkpoint

This is an evidence snapshot as of **2026-11-28T06:34:31Z**. It adds all six
completed composite-parser `minsize` cohorts and their audits, the exact root
results and decisions, pending wide-keyword scheduling/publication evidence,
and the frozen coordinator diagnostic source/specification/history. It changes
no product code, benchmark protocol, observation, or decision. Phase1 and
phase2A remain immutable.

## Review the conclusions directly

[RESULTS.md](RESULTS.md) and [DECISIONS.json](DECISIONS.json) are byte-for-byte
copies of the root's frozen projections, also present inside the proof archive.
Their original projection timestamps remain unchanged; the later checkpoint
timestamp does not imply that pending work completed.

The minsize candidate is **shelved with no PR**. Its two JMdict cohorts point in
opposite directions, both Jitendex cohorts point slower, and VNDB does not
replicate an import-speed improvement. All **252 prescribed imports** and
**2,152 raw memory scans** remain retained. Five memory cohorts qualify.
VNDB AB separately fails the frozen sampling-coverage condition in both arms;
its comparison fields remain null. That failure is not evidence of increased
memory use. The prior fingerprint candidate also remains shelved; its complete
raw evidence is in phase2A, and the unchanged decision is visible in the direct
root projection here.

The wide-keyword candidate's source QA, full-parser corpus parity and six-cell
qualification remain **pending** in this snapshot. The qualification was
prospectively scheduled in parallel with its correctness gates; no acceptance
gate was waived. No pending outcome payload is included or inferred. The
coordinator diagnostic is also queued: its three fixed observations will study
existing dependency order and cannot support a relative-speed claim.

## Contents and provenance

| Item | Scope |
|---|---|
| `minsize-*.raw-evidence.tar.gz` | Six existing raw cell archives, copied unchanged. Each retains 269 original JSON/JSONL/log/protocol files and one derived package audit. |
| `proofs-and-sources.tar.gz` | 119 frozen proof/source files, including independent audits, scheduling/publication receipts, synthesis, original preparation history, all nine diagnostic source files and superseded prospective failure policies. |
| `CELL-INDEX.json` | Original artifact/run/job IDs, artifact digests, cell archive identities, audit counts and memory qualification scope. |
| `INPUT-FREEZE.json` | Exact input hashes and as-of scope, captured before packaging; its initial packaging-pending label is historical. |
| `PROOF-INVENTORY.json` / `INVENTORY.json` | Complete member and outer-file byte lengths, SHA256 and Git blob identities. The containing Git tree authenticates the inventory's own bytes. |
| `DEPENDENCIES.json` | Exact immutable phase1/phase2A archive and member locators; no duplicate prior archive bytes. |
| `STATUS.json` / `EXCLUSIONS.json` | Complete versus pending outcomes, omitted duplicate payloads and limits. |

The six minsize cohorts use baseline
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` and candidate
`2907ba1bad0958c22fe363f88d7cceb4d4bc604e`, qualification run
`46104898097`, workflow commit
`0c2a8a75cd0322cc13348b977a7e915b555d5a88`. Source QA passed at the same
candidate: pinned native regeneration, 380 focused cases, JavaScript lint,
four TypeScript projects, 669 unit files / 15,135 passes / 47 skips, and all-target
dry build. That original log and receipt are bound through phase2A dependencies.

The diagnostic source is frozen at remote commit
`b66020e0def759142ab2106a3f634a970ad807d7` and tree `dad39eefe469361fc5f74a14446b352b431bc77f`.
Its five observer files, driver, extractor, specification and workflow match
the independent source review and the verified remote blobs. The original
review, two superseded prospective driver/spec policies, supplemental approval,
local/remote identities and final same-tree alignment receipt are retained.
No diagnostic observation existed when its fail-stop policy was finalized.

The earlier preparation files describe a broader future checkpoint with twelve
cohort archives and missing outcomes. They are retained as **preparation
history**, not the scope of this snapshot. `INPUT-FREEZE.json` and this README
define the selected six-cell as-of snapshot. Later wide, parity, QA and
coordinator outcomes must be saved additively.

## What was verified before payload omission

Each original GitHub artifact ZIP was hash-verified. Both nested product ZIPs
and every one of their 554 members per arm were rehashed, and the exact two
allowed package differences were checked: parser C source and parser WASM.
Only the 42 duplicate HTML renderings and two product ZIP payloads per cell
were then omitted. Their complete size/digest records and actual package-member
proofs remain. No raw JSON, JSONL, log, failure, memory scan or prescribed import
was removed, and no observation was rerun to replace an unfavorable result.

The checkpoint verifier rehashes retained bytes and checks those original
receipts for consistency. It does **not** claim to rehash omitted payloads or to
reproduce a browser measurement.

## Verification and reproduction limits

From this directory, run:

```sh
python verify-phase2b-checkpoint.py . --phase2a ../phase2a/proofs-and-sources.tar.gz --phase1 ../phase1/checkpoint-phase1.tar.gz
```

An optional `--repack /new/absent/path.tar.gz` rebuilds the proof archive from
retained member bytes and requires an identical hash. The six raw cell archives
are verified as existing lossless archives and are never repacked. The builder
records how the original frozen workspace inputs were assembled; it never
discovers later results or executes product code.

Hosted QA/browser qualification used Node 22.22.0. The separately queued hosted
full-parser parity plan uses Node 24.20.0; earlier local component receipts also
use their recorded Node 24.20.0 runtime. Do not reinterpret one runtime as the
other or rerun failed local attempts.

Browser semantic receipts cover counts, normalized storage, restart, twelve
fixed lookup terms over six passes and separate all-referenced-media checks.
They do not establish exhaustive persisted-row equality. Full parser-output
digests have a different scope. Memory is sampled process-tree PSS/private,
not a guaranteed absolute peak. Stage timers overlap. Audit/correctness passes,
static code-size changes and coordinator-observed windows are not speedup
evidence. The complete, separate cohort results and the unchanged root decisions
govern promotion; **no product PR has been created by this task**.

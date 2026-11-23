# Import lifetime and byte admission study

This is a new, separately frozen round of the JMdict, Jitendex and VNDB import
study. Earlier measurements and failed qualification attempts remain unchanged.
The production candidates and package differences are pinned in `candidates.json`.
No measurements from this study are used to tune its candidates or sampling rules.

## Questions

The preceding shared-source candidate (#810) improved Jitendex import time but
increased sampled process-tree PSS. This study tests two separate explanations:

- A compression message may retain an entire source slab after the required
  spans have already been gathered into WASM. The source-release candidate clears
  its three input references immediately after successful gathering.
- Parser admission previously considered group count, while owned content bytes
  were diagnostic only. The parser-budget candidate charges each active group
  its known source estimate, then replaces that estimate with exact owned slab
  bytes until its ordered sink finishes.

The parser policy is fixed before measurement: the existing 24 MiB group target
times the unchanged worker count. Admission follows source order. One oversized
group may run when the charged pipeline is empty; already admitted output can
exceed its estimate. Unchanged ZIP prefetch, WASM heaps, compression buffers and
downstream storage are outside this accounting. It is not an RSS limit.

## Immutable inputs

Each run records the harness commit/tree, production commit/tree, pinned archive
size and SHA-256, package digest, every packaged member hash, dependency lock and
the five identical benchmark overlays. An exact allowlist checks packaged source
differences before observations begin. Source, package, archive and overlay
identities are checked again for each observation. Every observation has a
separate write-once receipt. Failures are preserved; runs are not retried or
trimmed to obtain a result.

## Timing

Three comparisons use separate jobs: #801 to current #810 as a fresh control,
#810 to source release, and #810 to byte admission. Each corpus has two fixed
replications. Each replication contains one warmup per arm, two baseline A/A
pairs, eight alternating adjacent A/B or B/A pairs, and two final A/A pairs.
The second replication reverses the arm order in each candidate pair. The timing
window is the existing UI import boundary; restart and readback occur afterward.
All 26 observations and all controls are retained. No process sampling runs in
these jobs. There are 468 planned timing observations across 18 jobs.

Pair ratios, median ratios, faster-pair counts and the complete A/A range are
reported. A small ratio within control variation is not evidence of a reliable
whole-import gain. Component diagnostics do not replace end-to-end timing.

## Separate process memory

Six separate jobs cover the three corpora and two replications. Four arms are
measured: A = #801, B = current #810, C = #810 plus source release, D = #810 plus
byte admission. The fixed orders are `ABCDDCBA` and `CDABBADC`: two reversed
four-arm blocks per job, two observations per arm, 48 observations overall.
Each block reports B versus A, C/D versus B, and C/D versus A. This permits both
incremental and absolute memory comparisons on the same host.

The observer samples the discovered Chromium process trees with ordinary
`/proc` reads. The window includes startup, import, public readback and browser
restart. All elapsed times from these runs are excluded. Reported PSS and private
bytes are sampled maxima of qualified, fully readable stable trees, not exact
import-only peaks. Process membership and memory can change between reads.

The new observer adds an actual read through a live sibling task when a zombie
thread-group leader has no readable address space of its own. A recovered value
counts exactly once under the leader PID, with complete before/after task
membership, identity and group proof. The original failed leader read remains in
the evidence. Missing, changing, malformed or denied proof remains unqualified.
The existing narrow single-thread zombie exemption is unchanged. This does not
retroactively qualify any older failed observation. See the observer's dedicated
notes and executable process witnesses in the frozen observer bundles for the
exact conditions.

## Readback qualification

All imports must pass exact pinned dictionary counters, twelve complete public
term-response probes, and matching pre/post-restart semantic and physical data.
The same package must produce the same complete physical probes and digest in
every observation. Complete public semantic responses must match across arms.

For #801 versus #810 only, the established reservation layout can move physical
reference offsets and encoded reference previews. Only the exact row-level paths
are allowed; the associated readable-preview counter is independently recomputed
and can differ only when its preview rows differ. The two new candidates must
match #810's physical data exactly. Sequence, entry, storage and other fields may
not change. The guard tests reject missing observations, altered public results,
restart changes, incorrect derived counts and similarly named fields outside the
precisely permitted paths.

## Interpretation

The shared-source PR remains a draft until the speed/memory tradeoff is resolved
or explicitly accepted. Releasing input references is mechanically observable
without promising an earlier GC or lower process PSS. The byte budget must
demonstrate progress, unchanged output, useful memory reduction and acceptable
import time. The first qualifying comparison is retained even if unfavorable.

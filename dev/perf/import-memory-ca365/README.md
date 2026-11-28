# Frozen import comparisons

The parent directory's `import-qualification-ca365.json` binds the exact baseline, candidate,
release member allowlist, browser version, schedules and decision thresholds
before browser acquisition. These temporary workflows do not change production
defaults and are not intended to merge.

## Ordinary timing

Each corpus has two independent hosted jobs. Each job runs one warmup per arm,
then all six permutations of A/B/C. A and C use the identical baseline release
ZIP. B uses the candidate release. Each observation starts a fresh browser
profile. The second job reverses the first job's cohort order. No observation is
discarded, replaced or rerun according to its timing.

The original harness measures browser monotonic time from the file-input change
event through visible import completion. Its original production-default row,
lookup, restart, persistence and media checks remain enabled. All 72 public
lookup response hashes must also match across observations and arms. Physical
reference offsets are retained but are not mistaken for semantic responses.
Timed imports validate the fixed media sample; host zero additionally performs
complete media payload verification in A and B after all timed observations.

External libraries are generated once and shared between arm worktrees. Each
arm then restores its own checked native WASM artifacts from its own manifest.
Packaging calls the exported build API without rebuilding those libraries.
Every release member must match except the explicitly reviewed allowlist.
Complete release ZIPs, member hashes, binary source diff, fixture identity,
runner/workflow bytes, host receipts and original reports are retained.

The JSON protocol requires a target gain of at least 5% against both controls on
each host, with at least five of six faster pairs per control. The non-target
screen permits at most 3% median regression against either control on either
host. Data completeness and performance passage are separate fields. A green
acquisition job means valid observations were collected; it does not by itself
mean the candidate passed the performance screen.

## Separate memory screen

The observer, independent raw-scan auditor and coverage tests are unchanged from
commit `f2f08c8ee74cdea548c5c1b494ec15bf10360b46`. `provenance.json` records their
original location and byte hashes. Only orchestration and packaging use the new
frozen candidate. The two test-only import markers and ABBA/BAAB schedule helpers
are extracted unchanged into `overlay_helpers.py`.

Every corpus receives two independent memory jobs with four observations each.
The original observer waits 25 ms between scans during import, discovers the
whole browser process tree and checks stable identities before and after reads.
At least five fully covered scans, pre/post brackets within 250 ms, and no covered
gap greater than 250 ms are required. Live unreadable address spaces invalidate
coverage. Original failures and scans remain in the artifact; missing values
never become measured zeroes.

Both adjacent pairs per job must satisfy at most 5% median and 10% individual
increases in sampled maximum PSS and private memory. Every observation must
qualify. Complete media and public lookup/restart checks run in every memory
observation after the marked import window. The independent auditor rebuilds
process sums, coverage, maxima and pair changes from the retained raw scans.

These are non-atomic sampled import-window maxima, not exact peaks. Startup,
readback and restart are excluded from the maxima. All internal benchmark timing
labels are overridden by this outer memory protocol: no latency claim uses the
instrumented memory observations.

Original observer source: [pinned memory qualification](https://github.com/ManabiIO/manabitan/tree/f2f08c8ee74cdea548c5c1b494ec15bf10360b46).

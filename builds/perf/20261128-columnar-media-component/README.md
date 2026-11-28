# Existing PR #907: actual worker component qualification

This screen qualifies the existing compact projected-media transport from
[PR #907](https://github.com/ManabiIO/manabitan/pull/907). The original implementation
is `2a0b9243540bf54932165fd9ab4da17709e3b390`, authored by Alex Ehlke; the reviewed
original PR head is `e5fbc6af88c8c69bfa7471da287ef9ceef953c90`. The current-develop
port is `4e003dda038b8eb8cf6abbc45a6f959afd802aac`, based on
`dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`. It preserves the current native
image projector in argument five and adds the transport flag in argument six.
The connector-created product commit is
`66ae01d41e3abdb546873f62f8db9ff35bd4ebbb`; it has the identical product tree
`ecfffcd1443c36fc064debe148cfc2b4a482151e`. Commit metadata differs while the
runtime and test bytes match the local port exactly.

## Acquisition contract

Hosted acquisition on Ubuntu 26.04 was selected prospectively on 2026-11-28,
before any full-corpus timing. The local memory-only pre-start blocks are
preparation evidence and launched no child. Do not acquire a local cohort or
switch locations in response to results. The research workflow is prepared for
a single push to its isolated branch; publishing that branch launches the
hosted acquisition. It does not write to the existing PR branch. Do not rerun
the workflow or push a replacement acquisition after timing starts.

The source manifest records every tracked runtime source, the native artifact
and manifest, dependency and dictionary lock files, and the existing Node worker
adapter. A and C are the exact same reference checkout. B must match the reviewed
port byte for byte. The tooling checkout HEAD also contains this measurement
metadata; its measured runtime equals commit `4e003dda038b8eb8cf6abbc45a6f959afd802aac`
and `ext/js` tree `e0afc2e275dd1ab83f3e6ad931b468e19e9a5fab`. Generated
libraries must match between arms, and native output bytes must match the
checked-in artifacts. The controller freezes those identities and the harness
before any full-corpus observation, then checks them before and after every
child.

`generate-identities.py --reference /path/to/reference --candidate /path/to/candidate`
checks byte-for-byte deterministic reproduction of the manifest. `--write`
regenerates it before freezing; it includes no timestamps or machine paths.

The primary cohort uses six fresh-process blocks in this order:
`ABC`, `BCA`, `CAB`, `ACB`, `CBA`, `BAC`. The paired statistic is
`B / sqrt(A * C)`. Promotion to browser qualification requires median ratio
at most 0.95, a paired 95% median-bootstrap interval entirely below 1, and
absolute median `C/A - 1` at most 0.03. The bootstrap has 20,000 resamples and
seed 20261128. Failed observations are retained and never replaced.

Each child has a 384 MiB old-space limit per realm, three production parser
workers, a 2 GiB common-process RSS watchdog, and a 180 second deadline. The
controller requires at least 3 GiB `MemAvailable` before launch and aborts below
1 GiB available. The watchdog samples every 100 ms. RSS includes all Node worker
threads and must not be summed across their realm snapshots. These measurements
describe component feasibility, not whole-browser memory.

## Measured path and correctness

The timer surrounds the production `_readTermBankFileFast` call. Parent module
imports, archive verification/catalog creation, and parent Wasm compilation
precede it. Worker startup, production compressed lazy source admission,
inflate/CRC/parse, actual message transfer/delivery, parent media materialization,
and the final ordered sink callback are inside it. No parser experiment flags,
grouping policy, validation, or ownership route are replaced. The sink retains
first-owner deferred image diagnostics through production importer methods.
Database, compression, image payload storage, and OPFS are outside this component.
No whole-import gain may be inferred from this screen.

Qualification hashes all emitted content/key/lookup columns and every transferred
payload, verifies source/result detachment, observes the real parent's owned
content receipt, and retains owned columns through later native reuse. It renders
the production missing-image diagnostic for every reference and again for every
retained first owner after all groups finish. Timing uses the existing unmodified
Node worker adapter; qualification-only hashing and receipt consumption are absent.

The `preparation` directory preserves the original local synthetic pre-start
failure. It launched no child: available memory was below the unchanged 3 GiB gate.
There were no full-corpus or timing observations at that point.

Invoke `screen-controller.py` with `smoke`, `freeze`, `qualify`, and `timing` in
that sequence, giving the same `--reference`, `--candidate`, `--archive`, `--node`
(if Node 22.22.0 is not on PATH), and fresh `--output` directory to each command.

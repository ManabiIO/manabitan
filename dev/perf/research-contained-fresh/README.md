# Research-only contained phase qualification

Do not merge this branch or its replacement manual workflow into `develop`.

This experiment checks the current product `ext` tree against the frozen
`4a694f5d3` baseline, then builds isolated baseline, wide-word inflater, CRC
shift-cache, and colon-parser WASM variants. The ordinary source ZIPs are pinned
by SHA-256. No product file is changed by the runner.

Every observation starts a fresh Node 22 process with one JS parser module and
one selected WASM module. Same-arm controls repeat that entire setup. Parsing
primes the decoder before equal corpus warmups. Full corpus verification occurs
after the timed batch; native CRC, sizes, row counts, and fallback checks remain
active during timing. Setup, compilation, and oracle allocations are excluded
from steady-state timing and must be checked separately before shipping.

Each phase completes 24 counterbalanced candidate pairs and 12 same-arm
controls, using the registered shuffled schedule. No samples are trimmed or
retried. Paired log-ratio confidence intervals and practical margins are fixed
in the contract. Inconclusive evidence is retained without calling it a
regression. These are component measurements, not browser import results.

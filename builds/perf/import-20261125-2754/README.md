# Import optimization evidence: 2026-11-25

This separate evidence branch starts at develop commit
`7d1643e6147a10cb2165e9744cf0e63b59e46632`. It contains research receipts and
archives, with no product source changes.

## Current checkpoint

The initial checkpoint preserves the complete textual evidence for the current
native media projection memory study. The JMdict, Jitendex, and VNDB timing
studies are separate acquisitions and will be indexed here when their audits
are complete. This checkpoint makes no whole-import speed claim.

| Evidence                                                 | Frozen source pair                                                                      | Outcome                                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Native media projection memory](media-memory/README.md) | `7d1643e6147a10cb2165e9744cf0e63b59e46632` → `7a8b25a44a3fe165107ed816377cc72bb0fac67d` | Jitendex passes both replications. VNDB fails both replications on the unchanged scan-coverage rule. Memory promotion remains blocked. |

All 16 scheduled correctness observations pass. The independent audit
reconciles all 1,504 raw scans, source/package identities, and retained semantic
receipts. Four unqualified VNDB observations retain null maxima; both VNDB
replication medians remain null. No observation was retried, replaced, or
removed, and no threshold was relaxed.

The original four Actions artifact ZIP containers and eight duplicate release
ZIP payloads are omitted from the compact archive. Their exact identities,
digests, original download URLs, and per-package entry hashes are retained.
Every other artifact member is preserved verbatim, including failures. The
[archive manifest](media-memory/archive-manifest.json) enumerates every retained
file and every omitted payload.

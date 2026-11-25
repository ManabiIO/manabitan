# Direct ZIP media entry preparation

The speculative source ZIP media worker now passes its selected directory entries
directly to the shared packer. For the pinned VNDB archive, this removes a second
146,570-entry `Map`, its insertion and lookup operations, and 293,140 requirement
and source wrapper objects. The selected-entry array contains references to the
existing directory entries. These are structural work counts, not measured peak
memory or browser import improvements.

`preparePackedSourceZipMedia` keeps its existing requirements/Map API and access
order. The new entry API uses the same admission, duplicate-name, local-header,
overlap, range, compression, cancellation and CRC validation. Physical read order
and caller record order are unchanged. The packed Blob still contains the full
original media span and the media index format is unchanged.

## Exact-base correctness evidence

[exact-base-worker-oracle.json](exact-base-worker-oracle.json) compares the actual
production media worker handler from
`3d65e403c644b9a5a6be3128d72f9d30050b70e0` with this change. Both recorded HEADs are
that base because the candidate changes were uncommitted during verification.
The recorded source hashes differ only for the packer and worker. The fixture,
native WASM module, runner and worker shim are pinned by SHA-256; relevant source
and harness hashes are checked again after execution.

[media-verification.json](media-verification.json) records the independent Python
check of every packed image against the original ZIP using `zipfile` and `zlib`.
It compares complete decoded bytes, sizes and CRCs, rejects trailing DEFLATE data,
and verifies every media-index identity and row checksum, including empty slots.

| Verified output                 |           Result |
| ------------------------------- | ---------------: |
| Source images                   |          146,570 |
| Decoded image bytes             |      188,131,284 |
| Packed Blob bytes               |      195,649,882 |
| Index bytes                     |        3,912,816 |
| Index slots / empty slots       | 163,034 / 16,464 |
| Packed stored / DEFLATE records |      146,569 / 1 |
| Payload range reads in each arm |              144 |
| Payload range bytes in each arm |      205,086,922 |

The two complete packed Blob SHA-256 values and index SHA-256 values match.
The source ZIP SHA-256 is
`da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`.
The output and all-media content digests are in the evidence files.

Each handler ran in a fresh sequential Node 22.22.0 child process with a local
`self` shim. Blob hashing and output writes stayed inside the producing process.
This exercises production directory reading, image selection, packing, native CRC
checks and index creation. It does not qualify browser worker transfer or a full
dictionary import. This run used `--oracle-only`; the `observations` array is empty.
Single-call timing diagnostics in the raw receipt are not a performance cohort,
and no speed percentage is claimed.

## Validation and earlier attempts

The focused suite passed 146 tests across the new direct-entry regression file
and the existing raw-range, ZIP validation and generation-media storage suites.
The new cases cover complete byte/index equivalence, reversed input order,
duplicate names before I/O, malformed metadata, generic API getter and rejection
order, CRC failure precedence, cancellation and the admission threshold.

The all-target dry build and scoped lint passed. Type-check results and exact
validation commands are recorded in [validation.json](validation.json). The full
local unit suite was not started for this change after another full suite in the
shared environment stalled. Default unit and browser integration checks remain
PR CI gates; local browser execution was blocked by the environment's socket
permissions.

Two earlier oracle attempts are retained separately:

- [node-worker-setup-attempt.json](node-worker-setup-attempt.json): the first Node
  worker-based harness exited with signal 11 / status 139 before producing any
  oracle result or timing observation. It used a file-backed Blob crossing a Node
  worker lifetime. The exact cause was not established. The final child-process
  harness keeps Blob use and verification in the producing process.
- [historical-base-worker-oracle.json](historical-base-worker-oracle.json): a
  successful intermediate run used historical base `e35f179f213535497498086c8e26b5d413600891`.
  Its parser wrapper differs from the intended base, so it is excluded from the
  exact-base conclusion. The final run above corrected this identity mismatch.

## Reproduce the full source-media proof

Use Node 22.22.0 or a supported newer release and Python 3.11+. Put the complete
VNDB ZIP named by `test/perf/dictionaries.lock.json` in a read-only fixture cache.
Install the locked dependencies and build the libraries in both checkouts. The
baseline must be a clean checkout of the commit below; the candidate is this PR.

```sh
git -C "$BASELINE_ROOT" rev-parse HEAD
# Expected: 3d65e403c644b9a5a6be3128d72f9d30050b70e0
test "$(git -C "$BASELINE_ROOT" rev-parse HEAD)" = 3d65e403c644b9a5a6be3128d72f9d30050b70e0
node test/perf/direct-media-entries-20261123/screen.mjs \
  --baseline-root "$BASELINE_ROOT" \
  --cache-dir "$DICTIONARY_CACHE" \
  --out builds/perf/direct-media-entries-proof --oracle-only
python3 dev/perf/direct-media-entries-20261123/verify_media.py \
  --archive "$DICTIONARY_CACHE/vndb_characters_by_bee.zip" \
  --evidence builds/perf/direct-media-entries-proof
```

The output directory retains the complete packed media bytes and both indexes for
independent reinspection. Those large generated files and the input ZIP are not
included in this PR.

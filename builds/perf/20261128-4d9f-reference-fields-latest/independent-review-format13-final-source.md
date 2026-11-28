# Source-review follow-up: prospective85a8 corpus tooling

This is a source and identity review, not an execution result. It follows the independent format13/observer-v2 review in blob `5f725532df583e446fcc01e4ad189a1aa3f3660c`.

## Runtime pin

The reviewed prospective target is `85a8aa49f76fbabd2dc494aad247f74774ff2573`, public tree `ae7323d19d6da0cc500ff231a0dcd469ce4f31af`. Its sole parent is the previously reviewed `16c1b9fb1e850fec5d1c3e1dba792b9c8a293e97`.

The independently fetched GitHub comparison contains one changed runtime file, `ext/js/dictionary/term-record-opfs-store.js`:
- The nested rowBytes expression becomes ordered assignments of the same constants under the same conditions.
- Four read calls are reformatted without changing their arguments or order.

The authoritative decoder, checksum checks, sparse gather, byte budget and reader ownership rules are unchanged. The actual new store blob `d056b473923f762ab2c4dca91393effa2abc0f40` hashes to `434864abaa3939f6e86361d3c01685fa296b3ea8b2120a7411454ef295805e45`, exactly the updated canonical pin.

Public runtime trees match the new profile: ext `0028cecbfd79ffaa69c62a22ecff5dbc7f0e3f6b`; dictionary WASM `af8cb3aa7dfdec313024b973ca72c84f220871cc`; dev/lib `4d4b281ddf0baf15e9bb10cce12e98724bd2a64a`.

## Portable helper and hosted wrapper

All29 uploaded entries in manifest blob `3aed6c1a760f86f9bde8167dea9627443eb9a5ef` were checked against the reviewed local files using Git blob IDs, SHA256 and byte counts.

The earlier declared22 helper files match their original blobs, except the three previously reviewed adaptations: default evidence root; previous-reader schema13 expectation with the two added unreached-hook spies; and matching result assertions. Every member of the eight-file original oracle archive was independently hash-checked. The archive remains SHA256 `7959bf4736e64ca55e2ee7176774f2c62d2802a7df968f226818f969bb642e78`.

The85 update changes only candidate identities/labels and explanatory receipts in the orchestration/evidence files. All core parser, metadata, field, full-file, media-path and bounded-OPFS verifier algorithms remain unchanged.

The hosted driver pins85 for both default-off and enabled corpus arms. It uses a300 only in the separate previous-reader check. That check writes an actual format4 record/index pair, sets SQLite floor13, invokes the real a300 reader, and requires rejection before recovery, content preparation, content-root activation, purge resumption, record preparation, schema initialization, runtime pragmas or health restoration. SQLite and OPFS bytes must remain identical.

I found an import-path issue in the first unexecuted Python contract invocation. It was corrected to execute the exact test file directly, which supplies its directory on sys.path and reaches its retained unittest.main entry point. The corrected85 driver SHA256 is `ce6e25a35049e8751d6799de7eeab360647eb1246ef8f1e808cfd9ee6b21b993`; workflow SHA256 is `f3b40e62010994a20bf1ca8942efcafa5b1ad9c798a14ce26177f102c31cb99a`.

The workflow retains fresh per-arm processes, exact Node executable and heap/resource guards, source/asset checks, no unchanged retries, and unconditional outcome upload.

**No remaining source blocker found.** No tests or corpus acquisitions were executed by this reviewer. The earlier16c browser observations remain16c evidence. Neither those observations nor older f28/dcfc corpus results are relabeled as85 qualification.

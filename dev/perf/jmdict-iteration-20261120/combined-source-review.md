# Combined import optimization: independent review

Local commit `58105ed64b453b3166cf5632f657808005b15b65`; remote product `a0f8e8e00d30823b8451248b3e6bab20b4640eb8`; tree `b0d18a0f0bbd096ebe9a18d09bf284d2684d4a65`; parent `d733d0efe53398bfc2b45985aa709ade54f5710a`.

## Result

No blocking interaction finding. The combined tree is exactly the union of owned-content commit `fecdb112`, constructor-copy commit `4285a714`, and fixture correction `ff0c3e4e`. An isolated temporary Git index reconstructed that exact tree; the real index and source worktree were unchanged. There are exactly twelve changed paths.

The parser difference relative to the owned candidate consists of exactly seven typed-array constructor substitutions. All still allocate independent owned backing with the same element widths and exact view lengths. Native signatures and encoded lookup bytes are copied before scratch reuse. The lookup string view remains intentionally inside its already owned encoded index, so early worker reuse does not expose mutable native memory. No native source, WASM, transport layout, or lookup format changed.

The ownership witness, shared-arena admission, exact retained-span cache adoption, byte budgets, FIFO behavior, shared compression reservation and rollback joins are unchanged from the separately reviewed owned candidate. The fixture correction waits for the peer result before cancelling its producer, while the active sink still waits on finishSink; it preserves the intended failure-during-storage schedule.

## Full fixture byte oracle

The unchanged runner was invoked sequentially for all three dictionaries against the combined source with flags `{}`, the fixed group sizes, and the same locked archives/WASM. Every pinned comparison field matched the frozen baseline receipt.

| Fixture  |    Rows | Lookup bytes | Full digest                                                        |
| -------- | ------: | -----------: | ------------------------------------------------------------------ |
| jmdict   | 526,942 |   19,446,728 | `430a59f035c1e6bb66352f50b3d722b8bf853b394d56d5816f0576594e1ebb57` |
| jmnedict | 667,942 |   26,292,164 | `4ef00ce3bfda6a4a705800e459c7f0b54a82cb5fb76d149d8f119e416157dd5f` |
| jitendex | 435,448 |   20,031,116 | `b618d21aa8c89a3f2f21613fa15c9fa8689bdd9efb991c9475e78e8ac057e805` |

The digest covers every content row, content hash/length fields, scores, sequences, equality flags, encoded lookup bytes and lookup-plan columns before the next native parse. The driver uses the sequential parser, so this is component byte parity rather than a parallel ownership or persisted-OPFS proof. Component timing and memory fields are diagnostic only.

Complete commands, source/fixture/runner/WASM hashes, all comparison fields and full logs are preserved in `exact-union-review.json`, `interaction-review.json`, `full-fixture-parity.json`, and the three `*-combined.log` files. No source edits or broad unit run were performed by this reviewer.

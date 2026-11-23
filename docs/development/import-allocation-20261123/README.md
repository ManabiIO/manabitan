# Import allocation investigation — 2026-11-23

Two independent code PRs reduce repeated allocation and worker-message work against the frozen `develop` baseline `3d65e403c644b9a5a6be3128d72f9d30050b70e0`.

| Candidate                    | PR                                                     | Published source                           | Source tree                                |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| Direct record-field columns  | [#849](https://github.com/ManabiIO/manabitan/pull/849) | `10a8f09e96ff943ec1351b1391cb56fa7e20feed` | `deae81513cb4fb5508c9d9a388316e049b05429b` |
| Compact projected-media rows | [#850](https://github.com/ManabiIO/manabitan/pull/850) | `3597a103b0f35d076587e08196caa9f5d12f53ef` | `27587b807d38c6ed910a056d46305a3ef4554b78` |

The code branches contain runtime changes and regression tests. This separate study branch contains the fixed comparison workflow and evidence. The evidence files added here do not modify either product source or the frozen browser runner.

## Complete source replays

Both replays cover all 7,613,164 term rows in 937 banks from the locked JMdict, Jitendex and VNDB archives. They establish the narrower component properties described below; they do not replace real browser persistence checks.

- [Record fields](record-fields/README.md): byte-identical encoder results for every row in each of two resolved-reference modes. Eligible rows avoid 40,818,984 bytes of cumulative temporary column allocation and the same amount of copying per mode. Source offsets and compressed references are synthetic valid positions. The original harness failure on integer-valued Float64 score columns and its corrected VNDB-only replay are both retained.
- [Projected media](projected-media/README.md): byte-identical remaining columns, content, key plans and lookup indexes, with equal diagnostic keys and image paths after copying, transfer and native-memory reuse. In fixed four-bank VNDB groups, projected rows contain four properties instead of sixteen, removing 1,760,664 properties. Node V8 serialization sizes are recorded separately from browser performance.

These are cumulative work and representation measurements. They do not establish peak-memory savings, complete-import acceleration, or exact counts under the adaptive production batching policy.

## Frozen browser comparison

[Hosted run 45262185499](https://github.com/ManabiIO/manabitan/actions/runs/45262185499) tests each candidate independently on all three complete archives. The workflow and runner are frozen at commit `86ab2b81d9212bb8715f034481148b7d86428cc3`, tree `04bb506aef09c84ccd3ae09b0237bf4256c43dbe`.

Each cell contains six complete, position-balanced ABC triplets: A and C share the identical baseline release package, and B is the frozen candidate. Every attempted observation remains in its original artifact. No first-run exclusion, tail deletion, optional stopping or timing retry is permitted. All eighteen timed imports retain inventory, strict OPFS, restart and sampled content/media verification. Separate baseline and candidate diagnostic imports verify all referenced media against the source archives.

The timing boundary is the existing browser harness's file-input dispatch through completed import finalization and UI cleanup. Download, build, browser startup, restart and verification occur outside that interval. Node 22.22.0, release Chrome packages, production defaults, source/fixture hashes and clean-source checks are required. Tracing and process-memory sampling are disabled for these comparisons.

Six paired blocks are an exploratory screen. Candidate comparisons must be interpreted together with the identical-product control and their descriptive intervals. A passing correctness gate does not establish a speedup or a prespecified non-regression margin. Results are reported independently for each corpus and candidate; they must not be pooled into a combined performance claim.

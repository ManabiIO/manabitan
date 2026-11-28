# Rejected private sequence64 codec study

This research record preserves a completed JMdict experiment that did **not** meet its prospective gain gate. It is not an optimization PR, and no whole-import speedup is claimed. The product baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.

The exact-production candidate passed all correctness checks, but its one fixed 103-block component screen saved only 2.65–4.85 ms of CPU per canonical corpus across the three comparisons. It missed the 5%, seven-of-eight consistency and 10 ms gates. All 32 observations remain in the record. See `RESULT.md` for complete scope and provenance.

## Inspect the saved evidence

Run `python3 verify.py` in this directory to verify every archive part and saved file, independently recompute the paired results and confirm the failed advancement decision. No compiler, native module, network access or benchmark runs during verification.

To restore all 393 logical evidence files into a new directory, run `python3 verify.py --extract checked64-record`. The ZIP is split into twelve ordered parts solely to keep each repository blob small. `index.json` binds every part and the assembled archive. The archive stores identical file contents once and maps their original relative paths through its internal manifest.

The record contains frozen source packages, compiled WASM, exact-product build receipts, direct and API-capacity results, original setup failures, the corrected corpus/planner metadata, all timing observations and independent reviews. It explicitly distinguishes reused correctness evidence from new executions. The old 31-block/4 MiB screen was never timed; the real database uses 1 MiB blocks, which were reconstructed and independently verified before this screen.

Full dictionary/canonical payloads, SDK/package binaries, generated WAT/amalgamations and the repository's existing dictionary bytes are omitted. Their identities, public source pins, reconstruction programs and omission policy are preserved. Original execution paths are historical provenance; this is a complete saved-result audit, not a claim that the captured local paths are a portable one-command fresh acquisition.

The separate later capacity-dispatch census or candidate is outside this snapshot. Nothing in this branch changes product runtime files.

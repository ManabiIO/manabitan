# Hosted VNDB full-copy correctness evidence

The first-attempt hosted run [46111017640](https://github.com/ManabiIO/manabitan/actions/runs/46111017640) passed on Node 22.22.0 and Ubuntu 26.04. Its complete artifact and independent audit are preserved here. No product runtime files or active acquisition workflows change in this evidence commit.

All **170 groups, 665 banks and 6,648,310 rows** passed. Checks include full values and bytes against the frozen baseline, same-module object/view/backing-buffer aliases against the public copy path, unchanged raw/native sources, all 146,725 projected media rows, and all 170 prepared indexes/routes. There were no failures or fallback source reads. All copied-content groups in this workload used the private-content branch; their raw native sources used shared WASM memory.

The runtime hashes match candidate `e90c4c04172b691985858609094887f9541541dd`; this hosted research run used `7c4049e37035a20c51822361ef3bfc25f667b366` against baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Node's version is confirmed in the manifest and job logs. This workflow did not record the executable's digest.

This is **untimed Node correctness evidence**. It does not establish browser import latency, persistent storage behavior, or a memory improvement. Reported process maximum RSS of 497,204 KiB is diagnostic only. Browser nonregression, correctness and memory qualification remains separate under run `46113567719`.

## Verify the preserved result

Run `python3 verify.py` in this directory. It verifies the outer archive, all sixteen source/evidence files, the original GitHub artifact, all standalone group receipts, complete bank/group coverage, runtime/source/reference bindings and every captured equality result. It runs the retained receipt auditor in a temporary directory and does not run a benchmark or access the network. The new timestamped verification receipt exists only in that temporary directory.

`hosted-copy-evidence.zip` preserves the original artifact ZIP, compressed complete job log, GitHub metadata, published workflow, source package, frozen reference metadata, original audit program and its original receipt. Extracted artifact contents are omitted only to avoid duplicating bytes already in the exact original ZIP. `manifest.json` and `index.json` bind each file and archive.

The original artifact SHA-256 is `9d075f92fd94b7b5fc7af462bcef783aba342c85380afde349f32f493cba119f`. Its oracle manifest is `b6c209428c2e706cb5da75e9d14ae702b7ac8023c5d1fc1d58b642136c4ae6fd`; the independent audit is `2b4a43c5cca524f6a52b8c918a5244791282a51b82d14840de87c206e02ac78c`.

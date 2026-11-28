# Clean hosted validation for batched worker image paths

The validation job in [run 46113567719](https://github.com/ManabiIO/manabitan/actions/runs/46113567719) passed on Node 22.22.0. This archive preserves its exact uploaded ZIP, complete job log, workflow, source comparison and audit.

The single clean invocation passed **669 unit files / 15,159 tests**, with 47 inherited skips. Scoped ESLint, main and test TypeScript, the pinned native WASM rebuild, library generation and all seven extension dry-build targets also passed. The earlier local setup failures and narrow repairs remain historical evidence; they are not combined into this hosted result.

Validation ran at research commit `d36ee85feb1513af31f769175affa33b3696a307`. Its runtime and test files equal product candidate `e90c4c04172b691985858609094887f9541541dd`; all sixty intervening changed files are research or workflow files. Baseline remains `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`.

This job supplies build and test evidence. The six independent dictionary browser jobs are a separate qualification stage; this archive asserts no browser latency or memory result.

Run `python3 verify.py` to verify the saved archive and original log members, source/workflow bindings, successful job steps, complete test totals and exact seven-target build list. It does not run tests, native code, a browser or a benchmark. Complete error-path diagnostics in unit logs are retained verbatim.

Original GitHub artifact: `15253361929`, 47,103 bytes, SHA-256 `9df4dd5b1b7ffc14277ed149e9c705084f365a0e4f8df6844506d7bfb705a5e5`. The audit records its initial log-parser overmatch and narrow correction; no CI command or observation was repeated.

The local executor disconnected after the first successful offline verification and returned with its temporary directory cleared. All seven original evidence inputs survived. The deterministic ZIP was recreated byte for byte, SHA-256 `364e03b474968a9d3f51109b6f3cf6245ad26f68b5ab889b6e84fbcbd1cd06bc`; the wrapper manifest has a new creation timestamp. `reconstruction.json` records this event separately. No test, build, browser import or timing acquisition was repeated.

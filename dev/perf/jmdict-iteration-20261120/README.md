# Compact JMdict import evidence index

This Git-sized subset indexes all 20 performance cells and preserves independent observation/pair/cohort summaries, exact source/package/runtime/fixture and artifact identities, and all 72 original failed Jitendex attempts. It contains no compressed source-data store. Full offline replay requires the separately delivered `portable-evidence-20261120` directory from the raw evidence archive.

```sh
python3 -B verify.py --packet /path/to/portable-evidence-20261120
```

Use Python 3.11 or newer. The command verifies the full packet, restores exact original analyzer inputs and invokes every unchanged archived analyzer, with network and external data reads denied during analyzer execution. It requires no browser, Node packages, repository checkout, original workspace or network. The full packet's manifest must match `FULL_PACKET_MANIFEST.sha256` in this directory. The verifier also requires its own and `packet_lib.py` bytes to match the full packet's tool hashes.

Coverage: 576 attempted observations, 504 qualified observations, 72 preserved invalid observations, and 288 pair rows. Seventeen cells are valid. The constructor/owned/flush initial Chromium Jitendex cells remain invalid: their original analyzers still exit 1, contain 24 errors each and have no qualified comparisons. Raw successful browser reports do not override the failed original wrappers. No outliers or observations were dropped.

`index.json` gives all campaign/cell identities, original artifact ZIP SHA256/path/run URL, package/runtime/fixture pins and independently computed qualified comparisons. `observations.jsonl` contains every raw timer-derived elapsed value plus explicit qualification eligibility. `pairs.jsonl` includes all pairs; invalid raw changes are marked ineligible and have no qualified change. `cohorts.json` preserves every original cohort error; `failures.json` preserves exact wrapper error lines and source log hashes. Detailed per-file inventories and all exact analyzer inputs are in the full packet, not this subset.

The copied `offline-verification-receipt.json` records the successful full-packet replay. Re-run the command to obtain a new receipt in the full packet's `verification/` directory. A relocated replay and targeted integrity checks are recorded with the full packet delivery.

These are benchmark evidence and original failure dispositions. CI, full persisted-byte validation, and interpretation of untimed memory diagnostics are separate evidence sets. Firefox timing qualification checks extension reload; Chromium checks browser restart.

# Source-only native-field browser launch preflight

This single original CI job validates the corrected study source before its separate browser branch is published. It acquires no browser or import measurements.

## Exact source

The target is `8680bdf7046154e65635bd82d549c6fbc07f8b5f`, tree `249737a04041bce753e7d2e67fd04aec2c9e4ee8`, with clean product `8982dd89fac525100bdcaca7507bfff7feb2c842` as its sole parent. Its source aggregate is `46bdf936009651b9a3c8ae5697ac88fd00a7c0e3be67eda851d685d89ff50e28`. Root publishes that exact commit only under `test/native-record-fields-browser-trigger-source-20261128-1c413` for this preflight. The acquisition workflow's distinct `perf/native-record-fields-browser-acquire-20261128-1c413` trigger does not match that source ref.

This preflight workflow lives on a separate branch, `test/native-record-fields-browser-preflight-trigger-20261128-1c413`. Its own complete three-file source boundary and immutable target bindings are recorded in `source.json`. The job checks out the target at repository root, preserving the same dependency and generated-library paths used by the eventual acquisition.

## Concrete failure and narrow correction

Original browser workflow run `46136060186`, head `7d003d51dd3bd6ce24f9159680e658fe8f32dd07`, stopped all six jobs in the initial source guard before dependency setup, browser installation or qualification. The pinned fixture lock has four entries, including unrelated JMnedict; the study intentionally selects JMdict, Jitendex and VNDB. Comparing the entire four-entry map to the selected three-entry map was an invalid source assertion. The original failures and artifacts remain preserved, and no original timing observations are replaced.

The corrected guard still binds the complete fixture file's Git identity and SHA-256. It requires the study's exact fixed three-key set, requires every selected key in the lock, and compares all selected metadata exactly. The product, fixtures, common qualifier, timing gates, activation policy and schedule are unchanged. This source-only job executes that corrected guard end to end before a separate original acquisition can begin.

## Executed checks

The job first records its original run and target identities outside the checkout so setup failures remain available. It binds its complete workflow/README/manifest source, the target commit/tree/parent, and exact target source snapshots.

It then runs the actual target's `verify-source.py --phase launch`, including complete Git source boundaries, fixture metadata, sealed policies and read-only original prerequisite API identities. The unchanged 22 activation cases and seven added fixture-guard cases run together from `test-activation.py`. The fixture tests include the original fourth-entry case, missing/extra selected keys, metadata drift, malformed inputs and nonmutation.

The job uses the repository's unchanged setup-node action pin and Node 22.22.0, followed by exactly the repository setup commands: `npm ci`, `npm run build:libs`, and `npm run license-report:html`. Each command's complete output is retained separately. The copied setup action is bound as an exact source input. These are dependency/library setup operations; the job does not invoke importer, browser, native kernel, correctness corpus or benchmark programs.

Finally it runs the actual `verify-source.py --phase generated`, verifying exact native assets and recording the sole permitted generated legal-page difference. The same target source, guard, policy and API checks run again after setup.

## Retention and disposition

The workflow permits only attempt 1, has no matrix or retry, and never cancels an active preflight. Its always-run outcome step records every required step and hashes every retained file. The always-run artifact upload includes complete available logs, source snapshots, both guard receipts, setup outputs and original failure information. It does not drop incomplete evidence. Original GitHub job logs separately retain action setup and checkout output.

A passing preflight establishes executable source/setup validation only. It is not a native correctness, browser, media, memory or performance result. A failed preflight remains a failed original and cannot authorize acquisition. Root reviews its exact outcomes before publishing the identical already-tested study commit to the separate performance branch. The original frozen six-cell schedule remains 24 measured pairs, eight controls, two warmup pairs, two exhaustive-media and four memory observations per cell.

No file in this preflight changes product behavior or any previously measured cohort.

## Preserved launcher validation failure

The initial source-only preflight at `0ab9f1390876af6458c97bf1cbb385dcae94ca1e`, run `46136784829`, failed workflow validation before any job existed. Its job inventory is empty. Independent workflow lint run `46136785712`, job `140953757151`, identified the unsupported `runner` context in job-level `env`. Full original metadata and lint log are retained by receipt `404b841700a130ab5f478d9e5eb2d681d7734fc2`; the full decoded lint log is `72ac30ca70a4718765bbaa979bb6fbe1fc253d35`.

This revision makes only the launcher correction: the first shell step exports the output path from the existing `RUNNER_TEMP` environment variable and appends it to `GITHUB_ENV` for subsequent steps. The upload action retains its valid `runner.temp` input. The target study, setup commands, guard and pure tests are unchanged. This distinct original source-only run acquires no import or timing observations.

## Trigger-only target revision

The prior source-only preflight `0fde3e1ca108386c00a1e6c879fdc870c199ee7a`, run `46137023673`, passed both real guards, all 29 pure cases and all locked setup steps against target `915d6f42aea484dffdc7ee72a8d19e417b90cb95`. Its complete original evidence is retained by completion receipt `04b6779799b477521d8644c315688a662efe7936` and independent executed review `8f52b626c7202d1e29ff885f0f3237ab4a36ab30`.

The subsequent immutable `915d` acquisition ref had no custom acquisition run in the saved commit-wide registration query `232ae9f84f705cd5bdb0cb7883127289591a0b8b`. That is a recorded workflow-registration observation, not a performance result. No timing observations are being replaced.

The current target changes only the acquisition trigger to the unique `perf/native-record-fields-browser-acquire-20261128-1c413` branch and removes its top-level push path filter. The complete acquisition jobs section, product/control, guard/checker/29 cases and every policy remain byte-identical. Metadata records the registration history. Exact target assembly proof is `c302a7bbf7fe5a8afcb45d0338e7692ac1ed77e0`.

This preflight rebind changes only target/source identities, its unique trigger-preflight branch and descriptive provenance. All executed guard, test and setup commands are the same as in the successful `0fde` preflight. It remains one source-only original job with no browser, importer or measurement command.

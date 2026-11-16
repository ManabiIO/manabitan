# Production Release Readiness

Use this runbook to prepare an immutable browser-extension candidate. Qualification does not publish a tag or a store update. The detailed publication procedure is in [Deployments](deployments.md).

## Freeze and qualify the candidate

1. Fetch `origin`, preserve unrelated work, and inspect both sides of `main...develop`. Reconcile divergence through a release branch and PR; do not force-push either branch or replace incoming work with a tested checkout. Development fixes belong on `develop`.
2. Record the final full commit SHA, Git tree, intended browser targets, and a nonzero four-part version. Version components must have no leading zeroes and must not exceed 65535. Any changed runtime or packaged content needs qualification again. For merge-only commits, retain proof that the complete tree matches the qualified candidate.
3. Run full validation with Node 22, CodeQL, restart/interruption recovery, and the strict versioned CI workflow using the candidate ref and its `release_version` input. Require actual Chromium, Edge, Firefox and Firefox Android execution with OPFS, no storage fallback and no runtime verification skips. Include source ZIP import with deduplication, lookup/hover, replacement, restart, and the actual published-profile upgrade/reimport flow.
4. Retain the exact tested ZIPs and their hashes. Verify source/tree identity, manifest versions and add-on identities, required WASM assets, and the upgrade report. The package audit requires each named package's complete canonical MV3 manifest. When comparing rebuilt ZIPs with qualification artifacts, compare each target's `treeSha256`, file count and native-asset digests as well: ZIP byte hashes can differ because of archive timestamps even when every extracted file is identical. A dry-run build, `0.0.0.0` test package, or package from another source tree does not qualify the intended release.

Desktop runtime checks and store delivery are separate results. Firefox Android has automated import, lookup, replacement, visible search and mining coverage through temporary add-on installation. Its signed distribution, ordinary installation and automatic updates remain unqualified. Safari remains unqualified.

## Verify publication configuration

Use Manabitan-owned listings and inspect credential metadata without printing secret values. The publisher must resolve these names from its configured environment or inherited organization secrets:

| Channel                     | Listing identity                      | Credentials                                         |
| --------------------------- | ------------------------------------- | --------------------------------------------------- |
| Chrome stable               | `G_STABLE_EXTENSION_ID`               | `G_CLIENT_ID`, `G_CLIENT_SECRET`, `G_REFRESH_TOKEN` |
| Chrome development          | `G_DEVELOPMENT_EXTENSION_ID`          | Same Google credentials                             |
| Firefox stable              | `FF_EXTENSION_ID`                     | `FF_JWT_ISSUER`, `FF_JWT_SECRET`                    |
| Firefox development/offline | `FF_OFFLINE_EXT_ID`                   | Same Firefox credentials                            |
| Edge stable                 | `EDGE_PRODUCT_ID`                     | `EDGE_CLIENT_ID`, `EDGE_API_KEY`                    |
| Chrome offline CRX          | Identity derived from the signing key | `CHROME_CRX_PRIVATE_KEY`                            |

Firefox signing identities must match their [manifest variants](../../dev/data/manifest-variants.json). The stable and development Gecko IDs differ; only the development variant uses the offline update feed. Verify the signed package version/ID and the feed hash before qualifying that update channel.

The [configuration-only probe on 2026-11-16](https://github.com/ManabiIO/manabitan/actions/runs/43838733779) checked effective secrets inside the `cd` environment, including inherited organization secrets available to that job. Only `FF_OFFLINE_EXT_ID` was present, and it matched the development manifest. Chrome, Firefox and Edge publisher credentials and stable listing IDs were unavailable; offline Chrome signing was also unconfigured. The probe disclosed no secret values and attempted no publication. Configure the missing credentials and listing IDs, then repeat this check and verify authentication and listing ownership before publication. A development publisher can skip signing/upload when credentials are unavailable; a green skipped run does not prove distribution.

## Prepare upgrade guidance and publish deliberately

Keep [dictionary reimport instructions](../releases/import-engine.md) with the release notes. Older dictionary storage is rebuilt; dictionary-specific preferences and available sources are retained. Local dictionaries without a download source need their original archives, because a settings backup does not contain dictionary entries. Confirm recovery through the settings UI using the actual published-profile upgrade fixture.

After release approval, reconcile the qualified candidate into `main` and verify its tree. Use [tag.sh](../../tag.sh) from a clean `main` matching `origin/main`; it creates a signed tag and separately confirms the push. Pushing that tag publishes a public unsigned prerelease. Promoting a prerelease to stable dispatches the Chrome, Firefox and Edge publishers, so perform that step only when publication is intended.

Finally, verify the available version on each selected store listing, normal clean installation, and updating from the prior signed version. Store upload/build success alone establishes none of those results. Keep Firefox Android experimental until its normal delivery path is separately qualified.

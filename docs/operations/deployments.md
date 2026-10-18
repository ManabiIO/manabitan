# Deployments

Manabitan builds GitHub release packages and has separate publication workflows for Chrome, Firefox and Edge. Development builds use the Chrome development listing and the Firefox offline update channel; the stable channel also includes Edge. Only collaborators with deployment permissions should run publication workflows.

A successful unsigned ZIP build does not prove store installation, signing or automatic updates. Configure Manabitan-owned listings and credentials in the `cd` environment before publishing. Never reuse Yomitan listing IDs. Do not put credentials in documentation or workflow inputs.

## Qualify the release candidate

Active development belongs on `develop`. Integrate a tested candidate into `main` through the normal review process before tagging. Review any divergence between the branches; do not substitute an untested release-branch checkout.

Run the repository validation and the blocking Chromium, Edge, Firefox and Firefox Android CI lanes against the exact candidate commit. Inspect the uploaded browser reports for failures, unsupported-runtime skips and storage fallback. The Android lane currently establishes temporary add-on installation and post-install debugging smoke; it does not establish full mobile dictionary import and lookup.

Require CodeQL to pass for the exact active `develop` candidate and review its findings against `main` during promotion qualification. Manually dispatched CI includes four browser lanes; it does not replace CodeQL security analysis.

Build fresh packages with Node 22 and the supported WASM compiler. From the repository root:

```sh
npm ci
npm run build:source-release
```

This rebuilds runtime libraries, generates the dependency license page and packages every buildable variant. The six desktop ZIPs are `manabitan-chrome.zip`, `manabitan-chrome-dev.zip`, `manabitan-chrome-playwright.zip`, `manabitan-edge.zip`, `manabitan-firefox.zip` and `manabitan-firefox-dev.zip`. The all-target build also produces an unpacked Firefox Android directory. The prerelease workflow archives that directory as `manabitan-firefox-android.zip` with `manifest.json` at the ZIP root and includes it in release hashes and assets. This is an unsigned package; the installation smoke lane does not establish ordinary end-user installation or automatic updating. Verify package manifests, versions, file sets and hashes before distribution.

Keep documentation link changes gated on publicly available destinations and a passing link check. A website build or publication receipt alone does not establish that the canonical routes are reachable.

## Create a development prerelease

1. On `main`, finish pending Git operations, preserve or commit working changes, and ensure HEAD matches `origin/main` exactly. The [tag helper](../../tag.sh) checks these conditions after fetching.
2. Run `./tag.sh`. It selects an unused four-part CalVer tag such as `26.10.17.0`, asks for confirmation, creates a signed tag at the displayed commit and separately asks before pushing it. A working Git signing key is required. Components must not have leading zeroes. `MANABITAN_RELEASE_BRANCH` overrides the expected branch only for an intentional alternate release process.
3. Confirm that [Create prerelease on tag](https://github.com/ManabiIO/manabitan/actions/workflows/create-prerelease-on-tag.yml) builds the tagged source and publishes the intended [GitHub prerelease](https://github.com/ManabiIO/manabitan/releases) with package assets.
4. Review the dispatched [Chrome development](https://github.com/ManabiIO/manabitan/actions/workflows/publish-chrome-development.yml) and [Firefox development](https://github.com/ManabiIO/manabitan/actions/workflows/publish-firefox-development.yml) runs. Approve the `cd` environment where required. These workflows can skip publication when their signing/store credentials are absent; a green skipped run is not publication evidence.
5. Check the actual destination. Chrome development publication uses the configured `G_DEVELOPMENT_EXTENSION_ID`; offline CRX signing has its own key. Firefox development signs `manabitan-firefox-dev.zip`, uploads an XPI and updates the `metadata` branch's `updates.json` only after successful signing. Verify the uploaded signed package identity/version and update-feed hash before treating installation or updating as qualified.

The build-only `0.0.0.0` version is for qualification. Assign a real release version through the tag process before publication.

## Promote a stable release

1. Confirm the selected prerelease's packages and source are qualified. Create the Manabitan-owned store listings and configure Chrome, Firefox and Edge publication credentials before promoting it. For Firefox, `FF_EXTENSION_ID` must match the stable Gecko ID in [manifest variants](../../dev/data/manifest-variants.json). Existing Yomitan installs do not automatically migrate to Manabitan's distinct add-on identity.
2. In [Manabitan Releases](https://github.com/ManabiIO/manabitan/releases), edit the intended prerelease, clear “Set as a pre-release” and select the latest-release option as appropriate.
3. Confirm the [release workflow](https://github.com/ManabiIO/manabitan/actions/workflows/release.yml) dispatches [publish-chrome](https://github.com/ManabiIO/manabitan/actions/workflows/publish-chrome.yml), [publish-firefox](https://github.com/ManabiIO/manabitan/actions/workflows/publish-firefox.yml) and [publish-edge](https://github.com/ManabiIO/manabitan/actions/workflows/publish-edge.yml) for that release tag. Approve required environment deployments.
4. Inspect each publication result and verify the version available from each Manabitan-owned listing. Store review timing varies. Verify a clean installation and an update from the prior signed version separately; uploading an archive does not establish either result.

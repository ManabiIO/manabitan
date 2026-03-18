# Deployments

We deploy Manabitan to the Firefox and Chrome web stores via two channels: the dev build and the stable build. We do this via a series of GitHub Actions.

For Chrome Web Store listing copy, privacy policy, and reviewer guidance, see [Chrome Web Store Release Checklist](./chrome-web-store-release.md).

Only collaborators with deployment permissions are allowed to deploy.

## Deploying a dev build

1. Tag the commit with a version number. Like: `git tag 24.4.28.0 HEAD` (do this after pulling in the latest changes in master) or `git tag 24.4.28.0 abc123`

> [!WARNING]
> You can not use leading zeroes in the version tags (e.g. `24.04.28.0`). Firefox store does not allow them and the deploy will fail.

2. Push the tag to origin. `git push origin 24.4.28.0`
3. The [`Create prerelease on tag`](https://github.com/ManabiIO/manabitan/actions/workflows/create-prerelease-on-tag.yml) GitHub Actions workflow will run. It publishes a new prerelease in [Releases](https://github.com/ManabiIO/manabitan/releases) and kicks off workflows for Firefox and Chrome publishing.
4. Find the corresponding `publish-chrome-development` GH action run and unblock the deployment.
5. Find the corresponding `publish-firefox-development` GH action run and unblock the deployment.
6. Wait anywhere between 5 minutes and a few hours for the Chrome development listing to update. Firefox does not have a dedicated Manabitan dev listing; users install the dev build from the release assets.

## Deploying a stable build

1. Go to ["Releases"](https://github.com/ManabiIO/manabitan/releases) and pick a version you want to promote to stable.
2. On the top right corner click on "Edit" and on the bottom there are two options `Set as a pre-release` and `Set as the latest release`. Uncheck `Set as a pre-release` and check `Set as the latest release`.
3. This will trigger the [`release`](https://github.com/ManabiIO/manabitan/actions/workflows/release.yml) workflow, which in turn triggers the `publish-chrome`, `publish-firefox`, and `publish-edge` workflows.
4. Unblock the store publish workflows as needed and wait 5 minutes to a few hours for the stable listings to update.

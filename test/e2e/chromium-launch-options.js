/* SPDX-License-Identifier: GPL-3.0-or-later */

import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {version: playwrightVersion} = require(require.resolve('playwright-core/package.json'));
const verifiedPlaywrightVersion = '1.63.0';
// Playwright has no public default-arguments API. Keep this snapshot versioned:
// its exact switch must be filtered out before adding the merged replacement.
const defaultDisabledFeatures = [
    'AvoidUnnecessaryBeforeUnloadCheckSync',
    'DestroyProfileOnBrowserClose',
    'DialMediaRouteProvider',
    'GlobalMediaControls',
    'HttpsUpgrades',
    'LensOverlay',
    'MediaRouter',
    'PaintHolding',
    'ThirdPartyStoragePartitioning',
    'BlockOriginHeaderModificationOnRedirect',
    'Translate',
    'AutoDeElevate',
    'OptimizationHints',
    'msForceBrowserSignIn',
    'msEdgeUpdateLaunchServicesPreferredVersion',
];
const featurePrefix = '--disable-features=';
const defaultFeatureSwitch = featurePrefix + defaultDisabledFeatures.join(',');

/**
 * Prevent the macOS code-sign clone without replacing Playwright's disabled
 * features. Repeated Chromium switches do not merge their comma-separated values.
 * @template {import('playwright').LaunchOptions} T
 * @param {T} options
 * @param {NodeJS.Platform} [platform]
 * @returns {Omit<T, 'args'|'ignoreDefaultArgs'> & {args?: string[], ignoreDefaultArgs?: boolean|string[]}}
 */
export function getChromiumLaunchOptions(options, platform = process.platform) {
    if (platform !== 'darwin') { return options; }
    const ignored = options.ignoreDefaultArgs;
    const defaultsEnabled = ignored !== true && !(Array.isArray(ignored) && ignored.includes(defaultFeatureSwitch));
    if (ignored !== true && playwrightVersion !== verifiedPlaywrightVersion) {
        throw new Error(
            'Review the Chromium disabled-feature snapshot in test/e2e/chromium-launch-options.js ' +
            'after upgrading Playwright (expected ' + verifiedPlaywrightVersion + ', found ' + String(playwrightVersion) + ').',
        );
    }
    const features = new Set(defaultsEnabled ? defaultDisabledFeatures : []);
    const args = [];
    for (const arg of options.args ?? []) {
        if (arg.startsWith(featurePrefix)) {
            for (const feature of arg.slice(featurePrefix.length).split(',')) {
                if (feature.length > 0) { features.add(feature); }
            }
        } else {
            args.push(arg);
        }
    }
    features.add('MacAppCodeSignClone');
    args.push(featurePrefix + [...features].join(','));
    return {
        ...options,
        args,
        ignoreDefaultArgs: ignored === true ? true : [...new Set([...(Array.isArray(ignored) ? ignored : []), defaultFeatureSwitch])],
    };
}

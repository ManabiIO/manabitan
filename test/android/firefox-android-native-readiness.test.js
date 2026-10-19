import {mkdtemp, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {findOwnedAddedSheetButton, parseAndroidNativeHierarchy, prepareAndroidNativeReadiness} from './firefox-android-native-readiness.js';

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/android/firefox-android-extension-added-sheet-ci-39180206332.xml');
const ownedTitle = 'Manabitan Popup Dictionary was added';
const firefoxPackage = 'org.mozilla.firefox';

/**
 * @param {{packageName?: string, text?: string, resourceId?: string, className?: string, clickable?: boolean, enabled?: boolean, bounds?: string}} [options]
 * @returns {string}
 */
function nativeNode({packageName = firefoxPackage, text = '', resourceId = '', className = 'android.widget.TextView', clickable = false, enabled = true, bounds = '[10,20][110,80]'} = {}) {
    return `<node package="${packageName}" text="${text}" resource-id="${resourceId}" class="${className}" clickable="${clickable}" enabled="${enabled}" bounds="${bounds}" />`;
}

/**
 * @param {string} body
 * @returns {string}
 */
function hierarchy(body) {
    return `<?xml version="1.0"?><hierarchy>${body}</hierarchy>`;
}

describe('Firefox Android native readiness', () => {
    test('recognizes the actual CI extension-added sheet and computes its tap center from captured bounds', async () => {
        const xml = await readFile(fixturePath, 'utf8');
        const nodes = parseAndroidNativeHierarchy(xml);
        const action = findOwnedAddedSheetButton(nodes, firefoxPackage, 'Manabitan Popup Dictionary');
        expect(action).toEqual({
            title: ownedTitle,
            resourceId: 'org.mozilla.firefox:id/confirm_button',
            text: 'OK',
            bounds: {left: 807, top: 2106, right: 1038, bottom: 2232},
            tapCenter: {x: 922, y: 2169},
        });
    });

    test('does not act on another package or an unrelated OK dialog', () => {
        const anotherPackage = parseAndroidNativeHierarchy(hierarchy(nativeNode({packageName: 'com.android.permissioncontroller', text: ownedTitle, resourceId: 'org.mozilla.firefox:id/title'})));
        expect(findOwnedAddedSheetButton(anotherPackage, firefoxPackage, 'Manabitan Popup Dictionary')).toBeNull();
        const unrelated = parseAndroidNativeHierarchy(hierarchy(`${nativeNode({text: 'Allow notifications?', resourceId: 'org.mozilla.firefox:id/title'})}${nativeNode({text: 'OK', resourceId: 'org.mozilla.firefox:id/confirm_button', className: 'android.widget.Button', clickable: true})}`));
        expect(findOwnedAddedSheetButton(unrelated, firefoxPackage, 'Manabitan Popup Dictionary')).toBeNull();
    });

    test('rejects invalid bounds and missing enabled matching confirmation controls', () => {
        const title = nativeNode({text: ownedTitle, resourceId: 'org.mozilla.firefox:id/title'});
        const invalidBounds = parseAndroidNativeHierarchy(hierarchy(`${title}${nativeNode({text: 'OK', resourceId: 'org.mozilla.firefox:id/confirm_button', className: 'android.widget.Button', clickable: true, bounds: '[10,20][10,80]'})}`));
        expect(() => findOwnedAddedSheetButton(invalidBounds, firefoxPackage, 'Manabitan Popup Dictionary')).toThrow(/invalid native bounds/);
        const disabled = parseAndroidNativeHierarchy(hierarchy(`${title}${nativeNode({text: 'OK', resourceId: 'org.mozilla.firefox:id/confirm_button', className: 'android.widget.Button', clickable: true, enabled: false})}`));
        expect(() => findOwnedAddedSheetButton(disabled, firefoxPackage, 'Manabitan Popup Dictionary')).toThrow(/exactly one enabled clickable/);
    });

    test('captures before and after native state, dismisses only its sheet, then opens normal Firefox browsing', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'manabitan-android-native-readiness-'));
        const outputDirectory = path.join(root, 'native-readiness');
        const initial = await readFile(fixturePath, 'utf8');
        const browser = hierarchy(`${nativeNode({resourceId: 'org.mozilla.firefox:id/url_bar', text: 'Search or enter address'})}`);
        /** @type {Array<{args: string[], timeout: number, encoding: 'utf8'|null|undefined}>} */
        const commands = [];
        const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
        let currentHierarchy = initial;
        const result = await prepareAndroidNativeReadiness({
            adbDevice: 'emulator-5554',
            packageName: firefoxPackage,
            extensionName: 'Manabitan Popup Dictionary',
            outputDirectory,
            runCommand: async (args, options) => {
                commands.push({args, timeout: options.timeout, encoding: options.encoding});
                if (args.includes('input') && args.includes('tap')) {
                    currentHierarchy = browser;
                    return {stdout: ''};
                }
                if (args.includes('am') && args.includes('start')) { return {stdout: ''}; }
                const joined = args.join(' ');
                if (joined.endsWith('screencap -p')) {
                    expect(options.encoding).toBeNull();
                    return {stdout: screenshot};
                }
                if (joined.endsWith('dumpsys activity activities')) { return {stdout: 'mResumedActivity: org.mozilla.firefox/.HomeActivity'}; }
                if (joined.endsWith('dumpsys window windows')) { return {stdout: 'mCurrentFocus=org.mozilla.firefox'}; }
                if (joined.includes('uiautomator dump')) { return {stdout: 'dumped'}; }
                if (joined.includes('exec-out cat')) { return {stdout: currentHierarchy}; }
                throw new Error(`Unexpected command ${joined}`);
            },
            sleep: async () => {},
        });

        expect(result.ready).toBe(true);
        expect(result.captures.map((capture) => capture.label)).toContain('before');
        expect(result.captures.map((capture) => capture.label)).toContain('after-owned-sheet-dismissal');
        expect(result.actions.map(({name}) => name)).toEqual(['dismiss-owned-extension-added-sheet', 'open-normal-browser-with-action-view']);
        expect(result.actions[0]).toMatchObject({title: ownedTitle, buttonResourceId: 'org.mozilla.firefox:id/confirm_button', tapCenter: {x: 922, y: 2169}});
        const firstTapIndex = commands.findIndex(({args}) => args.includes('input') && args.includes('tap'));
        const viewIndex = commands.findIndex(({args}) => args.includes('am') && args.includes('start'));
        expect(firstTapIndex).toBeGreaterThan(-1);
        expect(viewIndex).toBeGreaterThan(firstTapIndex);
        expect(commands.every(({timeout}) => timeout > 0 && timeout <= 4_000)).toBe(true);
        const screenshotRelativePath = result.captures[0]?.files.screenshot?.path;
        expect(screenshotRelativePath).toBeDefined();
        const screenshotPath = path.join(outputDirectory, screenshotRelativePath ?? '');
        expect(await readFile(screenshotPath)).toEqual(screenshot);
        expect(commands.filter(({args}) => args.includes('uiautomator')).every(({encoding}) => encoding === 'utf8')).toBe(true);
        expect(result.reportPath).toBeDefined();
        expect(await readFile(path.join(outputDirectory, result.reportPath ?? ''), 'utf8')).toContain('"ready": true');
    });

    test('uses the injected monotonic clock for the cumulative command budget and does not act after it expires', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'manabitan-android-native-readiness-clock-'));
        let clock = 0;
        let currentHierarchy = await readFile(fixturePath, 'utf8');
        /** @type {Array<{args: string[], timeout: number}>} */
        const commands = [];
        const error = await prepareAndroidNativeReadiness({
            adbDevice: 'emulator-5554',
            packageName: firefoxPackage,
            extensionName: 'Manabitan Popup Dictionary',
            outputDirectory: path.join(root, 'native-readiness'),
            now: () => clock,
            runCommand: async (args, options) => {
                commands.push({args, timeout: options.timeout});
                clock += 5_000;
                const joined = args.join(' ');
                if (joined.endsWith('screencap -p')) { return {stdout: Buffer.from([1, 2, 3])}; }
                if (joined.endsWith('dumpsys activity activities') || joined.endsWith('dumpsys window windows')) { return {stdout: 'activity'}; }
                if (joined.includes('uiautomator dump')) { return {stdout: 'dumped'}; }
                if (joined.includes('exec-out cat')) { return {stdout: currentHierarchy}; }
                if (args.includes('input') && args.includes('tap')) {
                    currentHierarchy = hierarchy(nativeNode({resourceId: 'org.mozilla.firefox:id/url_bar', text: 'Search or enter address'}));
                    return {stdout: ''};
                }
                if (args.includes('am') && args.includes('start')) { throw new Error('Intent should not run after the shared work deadline'); }
                throw new Error(`Unexpected command ${joined}`);
            },
        }).catch((value) => value);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toMatch(/deadline|hierarchy/);
        expect((/** @type {Array<Record<string, unknown>>} */ (error.nativeReadiness.actions)).map((action) => action.name)).not.toContain('open-normal-browser-with-action-view');
        expect(commands.every(({timeout}) => timeout > 0 && timeout <= 4_000)).toBe(true);
        expect(commands.some(({args}) => args.includes('am') && args.includes('start'))).toBe(false);
    });

    test('uses only the recognized welcome Continue control and records its observed bounds', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'manabitan-android-native-readiness-welcome-'));
        const welcome = hierarchy(`${nativeNode({text: 'Welcome to Firefox'})}${nativeNode({text: 'Continue', className: 'android.widget.Button', clickable: true, resourceId: 'org.mozilla.firefox:id/onboarding_continue', bounds: '[100,200][300,260]'})}`);
        const browser = hierarchy(nativeNode({resourceId: 'org.mozilla.firefox:id/url_bar', text: 'Search or enter address'}));
        let currentHierarchy = welcome;
        /** @type {string[][]} */
        const commands = [];
        const result = await prepareAndroidNativeReadiness({
            adbDevice: 'emulator-5554',
            packageName: firefoxPackage,
            extensionName: 'Manabitan Popup Dictionary',
            outputDirectory: path.join(root, 'native-readiness'),
            runCommand: async (args) => {
                commands.push(args);
                const joined = args.join(' ');
                if (joined.endsWith('screencap -p')) { return {stdout: Buffer.from([1])}; }
                if (joined.endsWith('dumpsys activity activities') || joined.endsWith('dumpsys window windows')) { return {stdout: 'activity'}; }
                if (joined.includes('uiautomator dump')) { return {stdout: 'dumped'}; }
                if (joined.includes('exec-out cat')) { return {stdout: currentHierarchy}; }
                if (args.includes('input') && args.includes('tap')) {
                    currentHierarchy = browser;
                    return {stdout: ''};
                }
                if (args.includes('am') && args.includes('start')) { return {stdout: ''}; }
                return {stdout: ''};
            },
            sleep: async () => {},
        });
        expect(result.actions.find(({name}) => name === 'continue-terms-of-use')).toMatchObject({buttonText: 'Continue', bounds: {left: 100, top: 200, right: 300, bottom: 260}, tapCenter: {x: 200, y: 230}});
        expect(commands.some((args) => args.includes('input') && args.includes('tap') && args.at(-2) === '200' && args.at(-1) === '230')).toBe(true);
    });

    test('declines optional onboarding choices using their recognized page headings', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'manabitan-android-native-readiness-onboarding-'));
        const screens = [
            ['Welcome to Firefox', 'Continue'],
            ['Open all your links with built-in privacy', 'Not now'],
            ['Sync everywhere you use Firefox', 'Not now'],
            ['Help us grow Firefox', 'No thanks'],
            ['Choose your address bar', 'Continue'],
        ];
        let screenIndex = 0;
        /**
         * @param {string} title
         * @param {string} safeButton
         * @returns {string}
         */
        const hierarchyFor = (title, safeButton) => hierarchy(`${nativeNode({text: title})}${title === 'Help us grow Firefox' ? `<node package="${firefoxPackage}" text="" resource-id="org.mozilla.firefox:id/onboarding_safe" class="androidx.compose.material.Button" clickable="true" enabled="true" bounds="[100,200][300,260]"><node package="${firefoxPackage}" text="${safeButton}" class="android.widget.TextView" clickable="false" enabled="true" bounds="[110,210][290,250]" /></node>${nativeNode({text: 'Yes', className: 'android.widget.Button', clickable: true, resourceId: 'org.mozilla.firefox:id/onboarding_primary'})}` : nativeNode({text: safeButton, className: 'android.widget.Button', clickable: true, resourceId: 'org.mozilla.firefox:id/onboarding_safe', bounds: '[100,200][300,260]'})}`);
        const result = await prepareAndroidNativeReadiness({
            adbDevice: 'emulator-5554',
            packageName: firefoxPackage,
            extensionName: 'Manabitan Popup Dictionary',
            outputDirectory: path.join(root, 'native-readiness'),
            runCommand: async (args) => {
                const joined = args.join(' ');
                if (joined.endsWith('screencap -p')) { return {stdout: Buffer.from([1])}; }
                if (joined.endsWith('dumpsys activity activities') || joined.endsWith('dumpsys window windows')) { return {stdout: 'activity'}; }
                if (joined.includes('uiautomator dump')) { return {stdout: 'dumped'}; }
                if (joined.includes('exec-out cat')) {
                    const [title, button] = screens[screenIndex] ?? ['Search or enter address', ''];
                    return {stdout: button ? hierarchyFor(title, button) : hierarchy(nativeNode({resourceId: 'org.mozilla.firefox:id/url_bar', text: title}))};
                }
                if (args.includes('input') && args.includes('tap')) {
                    screenIndex += 1;
                    return {stdout: ''};
                }
                return {stdout: ''};
            },
            sleep: async () => {},
        });
        expect(result.ready).toBe(true);
        expect(result.actions.map(({name}) => name)).toEqual([
            'open-normal-browser-with-action-view',
            'continue-terms-of-use',
            'decline-default-browser',
            'decline-sync',
            'decline-marketing',
            'continue-with-selected-toolbar-default',
        ]);
        const declineActions = result.actions.filter(({name}) => String(name).startsWith('decline-'));
        expect(declineActions.map(({buttonText}) => buttonText)).toEqual(['Not now', 'Not now', 'No thanks']);
        expect(result.actions.some(({buttonText}) => ['Yes', 'Confirm', 'Start syncing', 'Set as default browser'].includes(String(buttonText)))).toBe(false);
        expect(result.actions.find(({name}) => name === 'decline-marketing')).toMatchObject({buttonText: 'No thanks', buttonResourceId: 'org.mozilla.firefox:id/onboarding_safe'});
    });

    test('fails closed on unknown onboarding headings and ambiguous safe controls', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'manabitan-android-native-readiness-unknown-'));
        for (const [index, screen] of [
            `${nativeNode({text: 'Some new Firefox page'})}${nativeNode({text: 'Continue', className: 'android.widget.Button', clickable: true})}`,
            `${nativeNode({text: 'Help us grow Firefox'})}${nativeNode({text: 'No thanks', className: 'android.widget.Button', clickable: true})}${nativeNode({text: 'Skip', className: 'android.widget.Button', clickable: true})}`,
            `${nativeNode({text: 'Help us grow Firefox'})}<node package="${firefoxPackage}" text="" class="androidx.compose.material.Button" clickable="true" enabled="true" bounds="[100,200][300,260]"><node package="${firefoxPackage}" text="No thanks" class="android.widget.TextView" clickable="false" enabled="true" bounds="[110,210][200,250]" /><node package="${firefoxPackage}" text="Skip" class="android.widget.TextView" clickable="false" enabled="true" bounds="[200,210][290,250]" /></node>`,
        ].entries()) {
            /** @type {string[][]} */
            const commands = [];
            let hierarchyReadCount = 0;
            await expect(prepareAndroidNativeReadiness({
                adbDevice: 'emulator-5554',
                packageName: firefoxPackage,
                extensionName: 'Manabitan Popup Dictionary',
                outputDirectory: path.join(root, `run-${index}`),
                runCommand: async (args) => {
                    commands.push(args);
                    const joined = args.join(' ');
                    if (joined.endsWith('screencap -p')) { return {stdout: Buffer.from([1])}; }
                    if (joined.endsWith('dumpsys activity activities') || joined.endsWith('dumpsys window windows')) { return {stdout: 'activity'}; }
                    if (joined.includes('uiautomator dump')) { return {stdout: 'dumped'}; }
                    if (joined.includes('exec-out cat')) {
                        hierarchyReadCount += 1;
                        return {stdout: hierarchy(screen)};
                    }
                    if (args.includes('am') && args.includes('start')) { return {stdout: ''}; }
                    throw new Error(`Unexpected command ${joined}`);
                },
                sleep: async () => {},
            })).rejects.toThrow(/Unrecognized Firefox native UI state|Unrecognized Firefox first-run|exactly one enabled clickable safe control|conflicting safe labels/);
            expect(commands.some((args) => args.includes('input') && args.includes('tap'))).toBe(false);
            expect(hierarchyReadCount).toBeGreaterThanOrEqual(2);
        }
    });

    test('preserves failure snapshots and rejects an unexpected package without tapping', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'manabitan-android-native-readiness-failure-'));
        const unexpected = hierarchy(nativeNode({packageName: 'com.android.permissioncontroller', text: 'Allow'}));
        /** @type {string[][]} */
        const commands = [];
        await expect(prepareAndroidNativeReadiness({
            adbDevice: 'emulator-5554',
            packageName: firefoxPackage,
            extensionName: 'Manabitan Popup Dictionary',
            outputDirectory: path.join(root, 'native-readiness'),
            runCommand: async (args) => {
                commands.push(args);
                const joined = args.join(' ');
                if (joined.endsWith('screencap -p')) { return {stdout: Buffer.from([1, 2, 3])}; }
                if (joined.endsWith('dumpsys activity activities') || joined.endsWith('dumpsys window windows')) { return {stdout: 'activity'}; }
                if (joined.includes('uiautomator dump')) { return {stdout: 'dumped'}; }
                if (joined.includes('exec-out cat')) { return {stdout: unexpected}; }
                throw new Error(`Unexpected command ${joined}`);
            },
        })).rejects.toMatchObject({
            message: expect.stringContaining('unexpected package'),
            nativeReadiness: expect.objectContaining({
                failureCapture: expect.objectContaining({
                    files: expect.objectContaining({
                        screenshot: expect.objectContaining({status: 'success'}),
                        hierarchy: expect.objectContaining({status: 'success'}),
                    }),
                }),
            }),
        });
        expect(commands.some((args) => args.includes('input') && args.includes('tap'))).toBe(false);
        expect(commands.some((args) => args.includes('am') && args.includes('start'))).toBe(false);
    });
});
